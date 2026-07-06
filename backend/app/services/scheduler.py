"""APScheduler integration for scheduled test runs and auto-archive."""

from datetime import datetime

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.date import DateTrigger
from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models import TestRun, TestRunStatus, TestRunType
from app.services.archive import auto_archive_old_runs
from app.services.jmeter_runner import run_manager
from app.services.run_queue import try_start_or_queue
from app.services.scenario_schedule import restore_scenario_schedules

scheduler = AsyncIOScheduler()


def start_scheduler() -> None:
    if not scheduler.running:
        scheduler.start()
        _restore_scheduled_runs()
        restore_scenario_schedules()
        scheduler.add_job(
            _run_auto_archive_job,
            trigger=CronTrigger(hour=2, minute=0),
            id="auto_archive_runs",
            replace_existing=True,
        )


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


def _run_auto_archive_job() -> None:
    db = SessionLocal()
    try:
        auto_archive_old_runs(db)
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
        await try_start_or_queue(db, run)
    finally:
        db.close()
