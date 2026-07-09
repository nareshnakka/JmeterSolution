"""Persisted in-app notification history."""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from app.models import AppNotification


def create_notification(
    db: Session,
    *,
    kind: str,
    title: str,
    message: str,
    payload: dict[str, Any] | None = None,
    dedupe_key: str | None = None,
) -> AppNotification | None:
    """Create a notification. Skips insert when dedupe_key already exists."""
    if dedupe_key:
        existing = (
            db.query(AppNotification)
            .filter(AppNotification.dedupe_key == dedupe_key)
            .first()
        )
        if existing:
            return None

    note = AppNotification(
        kind=kind,
        title=title,
        message=message,
        payload_json=json.dumps(payload) if payload else None,
        dedupe_key=dedupe_key,
        created_at=datetime.utcnow(),
    )
    db.add(note)
    db.commit()
    db.refresh(note)
    return note


def list_notifications(db: Session, *, limit: int = 200) -> list[AppNotification]:
    return (
        db.query(AppNotification)
        .order_by(AppNotification.created_at.desc())
        .limit(limit)
        .all()
    )


def clear_notifications(db: Session, ids: list[int] | None = None) -> int:
    q = db.query(AppNotification)
    if ids is not None:
        if not ids:
            return 0
        q = q.filter(AppNotification.id.in_(ids))
    deleted = q.delete(synchronize_session=False)
    db.commit()
    return deleted


def notify_test_run_finished(
    db: Session,
    *,
    run_id: int,
    scenario_name: str,
    status: str,
) -> None:
    if status == "completed":
        kind = "test_completed"
        title = "Test completed"
        message = f'"{scenario_name}" (run #{run_id}) completed successfully.'
    elif status == "failed":
        kind = "test_failed"
        title = "Test failed"
        message = f'"{scenario_name}" (run #{run_id}) failed.'
    elif status == "cancelled":
        kind = "test_cancelled"
        title = "Test stopped"
        message = f'"{scenario_name}" (run #{run_id}) was stopped.'
    else:
        return

    create_notification(
        db,
        kind=kind,
        title=title,
        message=message,
        payload={"run_id": run_id, "scenario_name": scenario_name, "status": status},
        dedupe_key=f"{kind}:{run_id}",
    )


def parse_payload(note: AppNotification) -> dict[str, Any] | None:
    if not note.payload_json:
        return None
    try:
        data = json.loads(note.payload_json)
        return data if isinstance(data, dict) else None
    except json.JSONDecodeError:
        return None
