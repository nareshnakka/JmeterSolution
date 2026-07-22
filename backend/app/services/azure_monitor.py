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


def azure_auth_mode() -> str:
    mode = (settings.azure_auth_mode or "client_secret").strip().lower()
    if mode in ("interactive", "device_code", "user", "login"):
        return "interactive"
    if mode in ("cli", "azure_cli", "default"):
        return "cli"
    return "client_secret"


def azure_credentials_configured() -> bool:
    """True when we can attempt Azure Monitor calls (subscription + some auth path)."""
    if not settings.azure_subscription_id.strip():
        return False
    try:
        from app.services.azure_login import is_signed_in

        if is_signed_in():
            return True
    except Exception:
        pass
    mode = azure_auth_mode()
    if mode == "cli":
        return True
    if mode == "interactive":
        # Device-code login required — do not sample until signed in on the Azure page.
        return False
    return bool(
        settings.azure_tenant_id.strip()
        and settings.azure_client_id.strip()
        and settings.azure_client_secret.strip()
    )


def clear_token_cache() -> None:
    global _cached_token, _cached_token_expires
    with _token_lock:
        _cached_token = None
        _cached_token_expires = None


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

    if not settings.azure_subscription_id.strip():
        raise RuntimeError("AZURE_SUBSCRIPTION_ID is not set in .env")

    try:
        from azure.identity import AzureCliCredential, ClientSecretCredential, DefaultAzureCredential
    except ImportError as exc:
        raise RuntimeError(
            "azure-identity is not installed. Run: pip install azure-identity"
        ) from exc

    token = None
    errors: list[str] = []

    # 1) In-app Microsoft login (encrypted token cache) — preferred.
    try:
        from app.services.azure_login import get_interactive_token, is_signed_in

        if is_signed_in():
            access = get_interactive_token()
            # Synthetic expires — interactive path refreshes via MSAL cache.
            expires = now + timedelta(minutes=50)
            with _token_lock:
                _cached_token = access
                _cached_token_expires = expires
            return access
    except Exception as exc:
        errors.append(f"interactive: {exc}")

    mode = azure_auth_mode()
    if mode in ("cli", "interactive"):
        # Prefer Azure CLI so the agent uses the interactive user who ran `az login`
        # (no app-registration IAM required if that user can already view metrics).
        try:
            credential = AzureCliCredential()
            token = credential.get_token("https://management.azure.com/.default")
        except Exception as exc:
            errors.append(f"cli: {exc}")
            try:
                credential = DefaultAzureCredential(exclude_interactive_browser_credential=True)
                token = credential.get_token("https://management.azure.com/.default")
            except Exception as exc2:
                errors.append(f"default: {exc2}")
    else:
        if not (
            settings.azure_tenant_id.strip()
            and settings.azure_client_id.strip()
            and settings.azure_client_secret.strip()
        ):
            detail = "; ".join(errors) if errors else "no credentials"
            raise RuntimeError(
                "Azure credentials are not configured. Sign in on the Azure page, "
                f"or set client_secret in .env. ({detail})"
            )
        try:
            credential = ClientSecretCredential(
                tenant_id=settings.azure_tenant_id.strip(),
                client_id=settings.azure_client_id.strip(),
                client_secret=settings.azure_client_secret.strip(),
            )
            token = credential.get_token("https://management.azure.com/.default")
        except Exception as exc:
            errors.append(f"client_secret: {exc}")

    if token is None:
        raise RuntimeError(
            "Failed to get Azure access token. Sign in on the Azure page. "
            + ("; ".join(errors) if errors else "")
        )

    expires = datetime.fromtimestamp(token.expires_on, tz=timezone.utc)
    with _token_lock:
        _cached_token = token.token
        _cached_token_expires = expires
    return token.token


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


def _latest_metric_field(payload: dict[str, Any], field: str) -> float | None:
    """Return the newest non-null aggregation value (average, maximum, …)."""
    values = payload.get("value") or []
    if not values:
        return None
    timeseries = values[0].get("timeseries") or []
    if not timeseries:
        return None
    data = timeseries[0].get("data") or []
    for point in reversed(data):
        raw = point.get(field)
        if raw is not None:
            return float(raw)
    return None


def _latest_average(payload: dict[str, Any]) -> float | None:
    return _latest_metric_field(payload, "average")


def _metrics_url(
    resource_id: str,
    *,
    metric_names: str,
    metric_namespace: str | None = None,
    minutes: int = 5,
    aggregation: str = "Average",
) -> str:
    end = datetime.now(timezone.utc)
    start = end - timedelta(minutes=minutes)
    timespan = f"{start.strftime('%Y-%m-%dT%H:%M:%SZ')}/{end.strftime('%Y-%m-%dT%H:%M:%SZ')}"
    params: dict[str, str] = {
        "api-version": "2023-10-01",
        "metricnames": metric_names,
        "aggregation": aggregation,
        "timespan": timespan,
        "interval": "PT1M",
    }
    if metric_namespace:
        params["metricnamespace"] = metric_namespace
    rid = resource_id if resource_id.startswith("/") else f"/{resource_id}"
    base = f"https://management.azure.com{rid}/providers/Microsoft.Insights/metrics"
    return f"{base}?{urllib.parse.urlencode(params)}"


def fetch_vm_cpu_memory(resource_id: str) -> dict[str, float | None]:
    """Return latest Avg CPU %, Max CPU %, and Memory % for one VM resource id."""
    token = _get_access_token()
    cpu: float | None = None
    cpu_max: float | None = None
    memory: float | None = None

    try:
        cpu_payload = _http_get_json(
            _metrics_url(
                resource_id,
                metric_names=CPU_METRIC,
                aggregation="Average,Maximum",
            ),
            token,
        )
        cpu = _latest_metric_field(cpu_payload, "average")
        cpu_max = _latest_metric_field(cpu_payload, "maximum")
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
        "cpu_max_percent": round(cpu_max, 1) if cpu_max is not None else None,
        "memory_percent": round(memory, 1) if memory is not None else None,
    }


def diagnose_azure_monitor(targets: list[dict[str, str]] | None = None) -> dict[str, Any]:
    """Safe diagnostics for Config UI — never returns secrets."""
    signed_in = False
    try:
        from app.services.azure_login import is_signed_in

        signed_in = is_signed_in()
    except Exception:
        signed_in = False

    checks: dict[str, Any] = {
        "credentials_configured": azure_credentials_configured(),
        "auth_mode": azure_auth_mode(),
        "signed_in": signed_in,
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
        if not checks["subscription_id_set"]:
            checks["message"] = (
                "AZURE_SUBSCRIPTION_ID is missing in .env. Set it in the project-root .env, "
                "restart, then sign in on the Azure page."
            )
        elif azure_auth_mode() == "cli":
            checks["message"] = (
                "AZURE_AUTH_MODE=cli — open the Azure page to sign in, or run az login on this machine."
            )
        else:
            checks["message"] = (
                "Not signed in to Azure. Open the Azure page and sign in with Microsoft, "
                "or set AZURE_CLIENT_SECRET in .env if using an app registration."
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
                "cpu_max_percent": metrics.get("cpu_max_percent"),
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
                f"CPU avg={metrics.get('cpu_percent')} max={metrics.get('cpu_max_percent')} "
                f"Memory={metrics.get('memory_percent')}. "
                "Metrics are collected only while a test run is active."
            )
    except Exception as exc:
        checks["targets_tested"].append(
            {
                "name": sample_target["name"],
                "cpu_percent": None,
                "cpu_max_percent": None,
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
            result[name] = {
                "cpu_percent": None,
                "cpu_max_percent": None,
                "memory_percent": None,
            }
    return result
