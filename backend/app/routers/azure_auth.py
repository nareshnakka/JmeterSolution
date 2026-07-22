"""Azure interactive login and live metric preview (not persisted)."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.services import azure_login
from app.services.azure_monitor import (
    clear_token_cache,
    sample_configured_targets,
)
from app.services.jmeter_runner import run_manager
from app.services.system_config import (
    get_enabled_azure_targets,
    get_system_config,
    list_azure_targets_from_config,
)

router = APIRouter(prefix="/api/azure", tags=["azure"])


class AzureAuthStatusOut(BaseModel):
    signed_in: bool
    username: str | None = None
    tenant_id: str | None = None
    subscription_id: str | None = None
    subscription_id_set: bool = False
    signed_in_at: str | None = None
    client_id: str | None = None
    message: str = ""
    monitor_enabled: bool = False
    targets_configured: int = 0


class AzureLoginStartOut(BaseModel):
    session_id: str
    status: str
    user_code: str | None = None
    verification_uri: str | None = None
    message: str | None = None
    error: str | None = None


class AzureLoginSessionOut(BaseModel):
    session_id: str
    status: str
    user_code: str | None = None
    verification_uri: str | None = None
    message: str | None = None
    error: str | None = None
    account: dict = Field(default_factory=dict)


class AzureLiveMetricServer(BaseModel):
    name: str
    cpu_percent: float | None = None
    cpu_max_percent: float | None = None
    memory_percent: float | None = None
    error: str | None = None


class AzureLiveMetricsOut(BaseModel):
    signed_in: bool
    monitor_enabled: bool
    sampled_at: str
    persisted: bool = False
    note: str = "Preview only — Azure metrics are saved only while a test run is active."
    servers: list[AzureLiveMetricServer] = Field(default_factory=list)


def _monitor_context(db: Session) -> tuple[bool, int]:
    cfg = get_system_config(db)
    enabled = bool(getattr(cfg, "azure_monitor_enabled", False))
    targets = [t for t in list_azure_targets_from_config(cfg) if t.get("resource_id")]
    return enabled, len(targets)


@router.get("/status", response_model=AzureAuthStatusOut)
def azure_status(db: Session = Depends(get_db)):
    payload = azure_login.status_payload()
    enabled, target_count = _monitor_context(db)
    return AzureAuthStatusOut(
        **payload,
        monitor_enabled=enabled,
        targets_configured=target_count,
    )


@router.post("/login/start", response_model=AzureLoginStartOut)
def azure_login_start():
    try:
        session = azure_login.start_device_code_login()
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to start Azure login: {exc}") from exc
    return AzureLoginStartOut(
        session_id=session.session_id,
        status=session.status,
        user_code=session.user_code,
        verification_uri=session.verification_uri,
        message=session.message,
        error=session.error,
    )


@router.get("/login/{session_id}", response_model=AzureLoginSessionOut)
def azure_login_poll(
    session_id: str,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    session = azure_login.get_login_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Login session not found")

    if session.status == "success" and not getattr(session, "_azure_kick_done", False):
        session._azure_kick_done = True  # type: ignore[attr-defined]
        clear_token_cache()
        # Auto-enable sampling so the next test run picks up live Azure metrics.
        cfg = get_system_config(db)
        if not getattr(cfg, "azure_monitor_enabled", False):
            cfg.azure_monitor_enabled = True
            db.commit()
        # Mid-run: start sampling if a test is already active.
        background_tasks.add_task(run_manager.ensure_azure_sampling_for_active_runs)

    return AzureLoginSessionOut(
        session_id=session.session_id,
        status=session.status,
        user_code=session.user_code,
        verification_uri=session.verification_uri,
        message=session.message,
        error=session.error,
        account=session.account or {},
    )


@router.post("/login/{session_id}/cancel")
def azure_login_cancel(session_id: str):
    if not azure_login.cancel_login(session_id):
        raise HTTPException(status_code=404, detail="Login session not found")
    return {"ok": True}


@router.post("/logout", response_model=AzureAuthStatusOut)
def azure_logout(db: Session = Depends(get_db)):
    azure_login.clear_login()
    clear_token_cache()
    payload = azure_login.status_payload()
    enabled, target_count = _monitor_context(db)
    return AzureAuthStatusOut(
        **payload,
        monitor_enabled=enabled,
        targets_configured=target_count,
        message="Signed out of Azure.",
    )


@router.get("/live-metrics", response_model=AzureLiveMetricsOut)
def azure_live_metrics(db: Session = Depends(get_db)):
    """Current CPU/Memory for configured VMs — preview only, never written to disk."""
    if not azure_login.is_signed_in():
        return AzureLiveMetricsOut(
            signed_in=False,
            monitor_enabled=False,
            sampled_at=datetime.now(timezone.utc).isoformat(),
            servers=[],
            note="Sign in to preview Azure metrics. Values are not saved until a test run starts.",
        )

    cfg = get_system_config(db)
    enabled = bool(getattr(cfg, "azure_monitor_enabled", False))
    targets = get_enabled_azure_targets(cfg)
    if not targets:
        targets = [
            t for t in list_azure_targets_from_config(cfg) if t.get("name") and t.get("resource_id")
        ]

    servers: list[AzureLiveMetricServer] = []
    if targets:
        raw = sample_configured_targets(targets)
        for t in targets:
            name = t["name"]
            metrics = raw.get(name) or {}
            servers.append(
                AzureLiveMetricServer(
                    name=name,
                    cpu_percent=metrics.get("cpu_percent"),
                    cpu_max_percent=metrics.get("cpu_max_percent"),
                    memory_percent=metrics.get("memory_percent"),
                )
            )

    return AzureLiveMetricsOut(
        signed_in=True,
        monitor_enabled=enabled,
        sampled_at=datetime.now(timezone.utc).isoformat(),
        persisted=False,
        servers=servers,
        note=(
            "Preview only — not saved. When a test starts, live Azure CPU/Memory is stored with "
            "that run and shown on the Live Dashboard."
            if servers
            else "Signed in, but no VMs configured. Add servers under Configuration → Azure Target Servers."
        ),
    )
