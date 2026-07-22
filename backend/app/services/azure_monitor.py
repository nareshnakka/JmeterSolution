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
