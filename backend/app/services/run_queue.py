"""Serial test-run queue — one JMeter run at a time."""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models import TestRun, TestRunStatus
from app.services.jmeter_runner import run_manager


def has_active_run(db: Session) -> bool:
    return (
        db.query(TestRun)
        .filter(TestRun.status == TestRunStatus.RUNNING)
        .first()
        is not None
    )


async def try_start_or_queue(db: Session, test_run: TestRun) -> bool:
    """Start immediately when idle; otherwise leave as PENDING in the queue."""
    if has_active_run(db):
        test_run.status = TestRunStatus.PENDING
        db.commit()
        return False
    await run_manager.start_run(db, test_run)
    return True


async def process_run_queue() -> None:
    """Start the oldest queued run when the server becomes idle."""
    db = SessionLocal()
    try:
        if has_active_run(db):
            return
        pending = (
            db.query(TestRun)
            .filter(TestRun.status == TestRunStatus.PENDING)
            .order_by(TestRun.created_at.asc())
            .first()
        )
        if pending:
            await run_manager.start_run(db, pending)
    finally:
        db.close()
