"""Fetch VM CPU and Memory % from Azure Monitor Metrics (stored with each test run)."""

from __future__ import annotations

import json
import logging
import threading
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any

from app.config import settings

logger = logging.getLogger(__name__)

_token_lock = threading.Lock()
_cached_token: str | None = None
_cached_token_expires: datetime | None = None

# Platform metric — always available for Azure VMs.
CPU_METRIC = "Percentage CPU"
# Prefer guest OS memory % when AMA / VM Insights is enabled.
MEMORY_GUEST_METRIC = r"\Memory\% Committed Bytes In Use"
MEMORY_GUEST_NAMESPACE = "Azure.VM.Windows.GuestMetrics"
# Fallback host metric (available on many SKUs with newer diagnostics).
MEMORY_HOST_METRIC = "Available Memory Percentage"


def azure_credentials_configured() -> bool:
    return bool(
        settings.azure_tenant_id.strip()
        and settings.azure_client_id.strip()
        and settings.azure_client_secret.strip()
        and settings.azure_subscription_id.strip()
    )


def build_vm_resource_id(
    *,
    subscription_id: str,
    resource_group: str,
    vm_name: str,
) -> str:
    """Build a full Azure VM resource ID from subscription + RG + name."""
    sub = subscription_id.strip().strip("/")
    rg = resource_group.strip()
    name = vm_name.strip()
    if not sub or not rg or not name:
        return ""
    return (
        f"/subscriptions/{sub}/resourceGroups/{rg}"
        f"/providers/Microsoft.Compute/virtualMachines/{name}"
    )


def fill_missing_resource_ids(
    targets: list[dict[str, str]],
    *,
    subscription_id: str,
    resource_group: str,
) -> list[dict[str, str]]:
    """Fill blank resource_id values from default subscription + resource group + VM name."""
    out: list[dict[str, str]] = []
    for item in targets:
        name = str(item.get("name") or "").strip()
        resource_id = str(item.get("resource_id") or "").strip()
        if name and not resource_id:
            resource_id = build_vm_resource_id(
                subscription_id=subscription_id,
                resource_group=resource_group,
                vm_name=name,
            )
        if name:
            out.append({"name": name, "resource_id": resource_id})
    return out


def parse_azure_targets(raw: str | None) -> list[dict[str, str]]:
    """Parse targets JSON: [{name, resource_id}, ...]."""
    if not raw or not raw.strip():
        return []
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return []
    if not isinstance(data, list):
        return []
    out: list[dict[str, str]] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        resource_id = str(item.get("resource_id") or "").strip()
        if name and resource_id:
            out.append({"name": name, "resource_id": resource_id})
    return out


def serialize_azure_targets(targets: list[dict[str, str]]) -> str:
    clean = parse_azure_targets(json.dumps(targets))
    return json.dumps(clean, indent=2)


def _get_access_token() -> str:
    global _cached_token, _cached_token_expires
    now = datetime.now(timezone.utc)
    with _token_lock:
        if (
            _cached_token
            and _cached_token_expires
            and _cached_token_expires > now + timedelta(minutes=2)
        ):
            return _cached_token

    if not azure_credentials_configured():
        raise RuntimeError("Azure credentials are not configured in .env")

    try:
        from azure.identity import ClientSecretCredential
    except ImportError as exc:
        raise RuntimeError(
            "azure-identity is not installed. Run: pip install azure-identity"
        ) from exc

    credential = ClientSecretCredential(
        tenant_id=settings.azure_tenant_id.strip(),
        client_id=settings.azure_client_id.strip(),
        client_secret=settings.azure_client_secret.strip(),
    )
    token = credential.get_token("https://management.azure.com/.default")
    expires = datetime.fromtimestamp(token.expires_on, tz=timezone.utc)
    with _token_lock:
        _cached_token = token.token
        _cached_token_expires = expires
    return token.token


def _http_get_json(url: str, token: str) -> dict[str, Any]:
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _latest_average(payload: dict[str, Any]) -> float | None:
    values = payload.get("value") or []
    if not values:
        return None
    timeseries = values[0].get("timeseries") or []
    if not timeseries:
        return None
    data = timeseries[0].get("data") or []
    for point in reversed(data):
        avg = point.get("average")
        if avg is not None:
            return float(avg)
    return None


def _metrics_url(
    resource_id: str,
    *,
    metric_names: str,
    metric_namespace: str | None = None,
    minutes: int = 5,
) -> str:
    end = datetime.now(timezone.utc)
    start = end - timedelta(minutes=minutes)
    timespan = f"{start.strftime('%Y-%m-%dT%H:%M:%SZ')}/{end.strftime('%Y-%m-%dT%H:%M:%SZ')}"
    params: dict[str, str] = {
        "api-version": "2023-10-01",
        "metricnames": metric_names,
        "aggregation": "Average",
        "timespan": timespan,
        "interval": "PT1M",
    }
    if metric_namespace:
        params["metricnamespace"] = metric_namespace
    rid = resource_id if resource_id.startswith("/") else f"/{resource_id}"
    base = f"https://management.azure.com{rid}/providers/Microsoft.Insights/metrics"
    return f"{base}?{urllib.parse.urlencode(params)}"


def fetch_vm_cpu_memory(resource_id: str) -> dict[str, float | None]:
    """Return latest CPU % and Memory % for one VM resource id."""
    token = _get_access_token()
    cpu: float | None = None
    memory: float | None = None

    try:
        cpu_payload = _http_get_json(_metrics_url(resource_id, metric_names=CPU_METRIC), token)
        cpu = _latest_average(cpu_payload)
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
        logger.warning("Azure CPU metric failed for %s: %s", resource_id, exc)

    # Guest memory % (AMA / VM Insights)
    try:
        mem_payload = _http_get_json(
            _metrics_url(
                resource_id,
                metric_names=MEMORY_GUEST_METRIC,
                metric_namespace=MEMORY_GUEST_NAMESPACE,
            ),
            token,
        )
        memory = _latest_average(mem_payload)
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError):
        memory = None

    if memory is None:
        try:
            mem_payload = _http_get_json(
                _metrics_url(resource_id, metric_names=MEMORY_HOST_METRIC),
                token,
            )
            memory = _latest_average(mem_payload)
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
            logger.warning("Azure Memory metric failed for %s: %s", resource_id, exc)

    return {
        "cpu_percent": round(cpu, 1) if cpu is not None else None,
        "memory_percent": round(memory, 1) if memory is not None else None,
    }


def diagnose_azure_monitor(targets: list[dict[str, str]] | None = None) -> dict[str, Any]:
    """Safe diagnostics for Config UI — never returns secrets."""
    checks: dict[str, Any] = {
        "credentials_configured": azure_credentials_configured(),
        "tenant_id_set": bool(settings.azure_tenant_id.strip()),
        "client_id_set": bool(settings.azure_client_id.strip()),
        "client_secret_set": bool(settings.azure_client_secret.strip()),
        "subscription_id_set": bool(settings.azure_subscription_id.strip()),
        "token_ok": False,
        "targets_tested": [],
        "ok": False,
        "message": "",
    }
    if not checks["credentials_configured"]:
        missing = [
            name
            for name, present in (
                ("AZURE_TENANT_ID", checks["tenant_id_set"]),
                ("AZURE_CLIENT_ID", checks["client_id_set"]),
                ("AZURE_CLIENT_SECRET", checks["client_secret_set"]),
                ("AZURE_SUBSCRIPTION_ID", checks["subscription_id_set"]),
            )
            if not present
        ]
        checks["message"] = (
            "Missing Azure keys in backend .env: " + ", ".join(missing)
            + ". Edit project-root .env then restart so it copies to backend/.env."
        )
        return checks

    try:
        _get_access_token()
        checks["token_ok"] = True
    except Exception as exc:
        checks["message"] = f"Failed to get Azure access token: {exc}"
        return checks

    ready = [t for t in (targets or []) if t.get("name") and t.get("resource_id")]
    if not ready:
        checks["message"] = (
            "Credentials OK, but no VMs have a resource ID. "
            "Set default resource group + Save Azure Settings, or paste full resource IDs."
        )
        checks["ok"] = True  # auth works; targets still need config
        return checks

    # Test first target only to keep the call fast.
    sample_target = ready[0]
    try:
        metrics = fetch_vm_cpu_memory(sample_target["resource_id"])
        checks["targets_tested"].append(
            {
                "name": sample_target["name"],
                "cpu_percent": metrics.get("cpu_percent"),
                "memory_percent": metrics.get("memory_percent"),
                "error": None,
            }
        )
        if metrics.get("cpu_percent") is None and metrics.get("memory_percent") is None:
            checks["message"] = (
                f"Auth OK for {sample_target['name']}, but no CPU/Memory values returned. "
                "Check Monitoring Reader role, resource ID, and VM Insights/AMA for Memory."
            )
        else:
            checks["ok"] = True
            checks["message"] = (
                f"OK — sample from {sample_target['name']}: "
                f"CPU={metrics.get('cpu_percent')} Memory={metrics.get('memory_percent')}. "
                "Metrics are collected only while a test run is active."
            )
    except Exception as exc:
        checks["targets_tested"].append(
            {
                "name": sample_target["name"],
                "cpu_percent": None,
                "memory_percent": None,
                "error": str(exc),
            }
        )
        checks["message"] = f"Auth OK, but metrics call failed for {sample_target['name']}: {exc}"

    return checks


def sample_configured_targets(targets: list[dict[str, str]]) -> dict[str, dict[str, float | None]]:
    """Sample CPU/Memory for each configured target. Keys are display names."""
    result: dict[str, dict[str, float | None]] = {}
    for target in targets:
        name = target["name"]
        try:
            result[name] = fetch_vm_cpu_memory(target["resource_id"])
        except Exception as exc:
            logger.warning("Azure sample failed for %s: %s", name, exc)
            result[name] = {"cpu_percent": None, "memory_percent": None}
    return result
