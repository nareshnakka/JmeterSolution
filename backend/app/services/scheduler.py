"""APScheduler integration for scheduled test runs."""

from datetime import datetime

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.date import DateTrigger
from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models import TestRun, TestRunStatus, TestRunType
from app.services.jmeter_runner import run_manager

scheduler = AsyncIOScheduler()


def start_scheduler() -> None:
    if not scheduler.running:
        scheduler.start()
        _restore_scheduled_runs()


def shutdown_scheduler() -> None:
    if scheduler.running:
        scheduler.shutdown(wait=False)


def schedule_test_run(test_run_id: int, scheduled_at: datetime) -> None:
    scheduler.add_job(
        _fire_scheduled_run,
        trigger=DateTrigger(run_date=scheduled_at),
        id=f"test_run_{test_run_id}",
        replace_existing=True,
        kwargs={"test_run_id": test_run_id},
    )


def unschedule_test_run(test_run_id: int) -> None:
    job_id = f"test_run_{test_run_id}"
    job = scheduler.get_job(job_id)
    if job:
        scheduler.remove_job(job_id)


def _restore_scheduled_runs() -> None:
    db = SessionLocal()
    try:
        runs = (
            db.query(TestRun)
            .filter(
                TestRun.status == TestRunStatus.SCHEDULED,
                TestRun.scheduled_at.isnot(None),
                TestRun.scheduled_at > datetime.utcnow(),
            )
            .all()
        )
        for run in runs:
            schedule_test_run(run.id, run.scheduled_at)
    finally:
        db.close()


async def _fire_scheduled_run(test_run_id: int) -> None:
    db = SessionLocal()
    try:
        run = db.get(TestRun, test_run_id)
        if not run or run.status != TestRunStatus.SCHEDULED:
            return
        run.status = TestRunStatus.PENDING
        db.commit()
        await run_manager.start_run(db, run)
    finally:
        db.close()
