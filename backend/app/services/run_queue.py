"""Serial test-run queue — one JMeter run at a time."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models import TestRun, TestRunStatus
from app.services.jmeter_runner import run_manager


def reconcile_stale_runs(db: Session) -> int:
    """Mark DB RUNNING rows as failed when no live JMeter process is tracked."""
    updated = 0
    now = datetime.utcnow()
    running = db.query(TestRun).filter(TestRun.status == TestRunStatus.RUNNING).all()
    for run in running:
        if _run_is_alive(run):
            continue
        run.status = TestRunStatus.FAILED
        run.error_message = (
            "Test run was interrupted (server restarted or JMeter process was lost)"
        )
        run.finished_at = now
        run_manager.cleanup_run(run.id)
        updated += 1
    if updated:
        db.commit()
    return updated


def _run_is_alive(run: TestRun) -> bool:
    return run_manager.is_tracked_run_active(run.id, run.pid)


def has_active_run(db: Session) -> bool:
    reconcile_stale_runs(db)
    return (
        db.query(TestRun)
        .filter(TestRun.status == TestRunStatus.RUNNING)
        .first()
        is not None
    )


async def try_start_or_queue(db: Session, test_run: TestRun) -> bool:
    """Start immediately when idle; otherwise leave as PENDING in the queue."""
    reconcile_stale_runs(db)
    if has_active_run(db):
        test_run.status = TestRunStatus.PENDING
        db.commit()
        return False
    await run_manager.start_run(db, test_run)
    db.refresh(test_run)
    return test_run.status == TestRunStatus.RUNNING


async def process_run_queue() -> None:
    """Start the oldest queued run when the server becomes idle."""
    db = SessionLocal()
    try:
        reconcile_stale_runs(db)
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
