"""Notification history and application updates."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.schemas import (
    AppNotificationOut,
    NotificationClearRequest,
    NotificationClearOut,
    UpdateApplyOut,
    UpdateApplyRequest,
    UpdateCheckOut,
)
from app.services.app_notifications import clear_notifications, list_notifications, parse_payload
from app.services.update_manager import update_manager

router = APIRouter(prefix="/api", tags=["notifications"])


def _to_notification_out(note) -> AppNotificationOut:
    payload = parse_payload(note)
    actions: list[dict] = []
    if note.kind == "update_available" and payload:
        actions.append(
            {
                "type": "update",
                "label": "Update",
                "version": payload.get("latest_version"),
            }
        )
    elif note.kind in (
        "test_completed",
        "test_failed",
        "test_cancelled",
        "host_cpu_high",
        "host_memory_high",
        "run_resumed",
    ) and payload:
        run_id = payload.get("run_id")
        if run_id:
            label = "Open Live Dashboard" if note.kind == "run_resumed" else "View Results"
            action_type = "open_live" if note.kind == "run_resumed" else "view_run"
            actions.append({"type": action_type, "label": label, "run_id": run_id})
    return AppNotificationOut(
        id=note.id,
        kind=note.kind,
        title=note.title,
        message=note.message,
        payload=payload,
        actions=actions,
        created_at=note.created_at,
    )


@router.get("/notifications", response_model=list[AppNotificationOut])
def get_notifications(db: Session = Depends(get_db)):
    return [_to_notification_out(n) for n in list_notifications(db)]


@router.post("/notifications/clear", response_model=NotificationClearOut)
def clear_notification_items(body: NotificationClearRequest, db: Session = Depends(get_db)):
    deleted = clear_notifications(db, body.ids)
    return NotificationClearOut(deleted=deleted)


@router.get("/updates/check", response_model=UpdateCheckOut)
def check_updates(db: Session = Depends(get_db)):
    data = update_manager.check_for_updates(db, notify=True)
    return UpdateCheckOut.model_validate(data)


@router.get("/updates/status", response_model=UpdateCheckOut)
def update_status(db: Session = Depends(get_db)):
    data = update_manager.check_for_updates(db, notify=False)
    return UpdateCheckOut.model_validate(data)


@router.post("/updates/apply", response_model=UpdateApplyOut)
def apply_update(body: UpdateApplyRequest, db: Session = Depends(get_db)):
    if not body.confirmed:
        return UpdateApplyOut(status="cancelled", message="Update was not confirmed.")
    result = update_manager.schedule_or_apply(db, latest_version=body.version)
    return UpdateApplyOut(status=result["status"], message=result["message"])
