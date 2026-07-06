"""Recurring and one-off scenario schedules."""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.date import DateTrigger
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models import ScheduleFrequency, ScenarioSchedule, TestRun, TestRunStatus, TestRunType
from app.utils.datetime_utils import naive_utc, utc_now
from app.services.run_queue import try_start_or_queue

DAY_NAMES = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
UTC = ZoneInfo("UTC")


def _get_scheduler():
    from app.services.scheduler import scheduler

    return scheduler


def _job_id(schedule_id: int) -> str:
    return f"scenario_schedule_{schedule_id}"


def parse_days_of_week(raw: str | None) -> list[int]:
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, list):
            return [int(d) for d in parsed if 0 <= int(d) <= 6]
    except (json.JSONDecodeError, TypeError, ValueError):
        pass
    return []


def serialize_days_of_week(days: list[int]) -> str:
    return json.dumps(sorted(set(days)))


def compute_next_run_at(
    frequency: ScheduleFrequency,
    run_at: datetime,
    days_of_week: list[int],
    *,
    after: datetime | None = None,
) -> datetime | None:
    now = after or utc_now()
    run_at = naive_utc(run_at)
    if after is not None:
        after = naive_utc(after)
        now = after

    if frequency == ScheduleFrequency.ONCE:
        return run_at if run_at > now else None

    if frequency == ScheduleFrequency.DAILY:
        candidate = now.replace(
            hour=run_at.hour, minute=run_at.minute, second=0, microsecond=0
        )
        if candidate <= now:
            candidate += timedelta(days=1)
        return candidate

    if frequency == ScheduleFrequency.WEEKLY:
        if not days_of_week:
            return None
        for offset in range(8):
            candidate = now.replace(
                hour=run_at.hour, minute=run_at.minute, second=0, microsecond=0
            ) + timedelta(days=offset)
            if candidate.weekday() in days_of_week and candidate > now:
                return candidate
        return None

    return None


def register_scenario_schedule(schedule: ScenarioSchedule) -> None:
    if not schedule.is_active:
        return

    job_id = _job_id(schedule.id)
    if schedule.frequency == ScheduleFrequency.ONCE:
        trigger = DateTrigger(run_date=schedule.next_run_at, timezone=UTC)
    elif schedule.frequency == ScheduleFrequency.DAILY:
        trigger = CronTrigger(
            hour=schedule.run_at.hour,
            minute=schedule.run_at.minute,
            timezone=UTC,
        )
    else:
        days = parse_days_of_week(schedule.days_of_week)
        dow = ",".join(DAY_NAMES[d] for d in sorted(days))
        trigger = CronTrigger(
            day_of_week=dow,
            hour=schedule.run_at.hour,
            minute=schedule.run_at.minute,
            timezone=UTC,
        )

    scheduler = _get_scheduler()
    scheduler.add_job(
        _fire_scenario_schedule,
        trigger=trigger,
        id=job_id,
        replace_existing=True,
        kwargs={"schedule_id": schedule.id},
    )


def unschedule_scenario(schedule_id: int) -> None:
    job_id = _job_id(schedule_id)
    scheduler = _get_scheduler()
    job = scheduler.get_job(job_id)
    if job:
        scheduler.remove_job(job_id)


def deactivate_scenario_schedule(db: Session, schedule: ScenarioSchedule) -> None:
    schedule.is_active = False
    unschedule_scenario(schedule.id)
    db.commit()


def deactivate_existing_schedules(db: Session, scenario_id: int) -> None:
    active = (
        db.query(ScenarioSchedule)
        .filter(ScenarioSchedule.scenario_id == scenario_id, ScenarioSchedule.is_active.is_(True))
        .all()
    )
    for schedule in active:
        schedule.is_active = False
        unschedule_scenario(schedule.id)
    if active:
        db.commit()


def create_scenario_schedule(
    db: Session,
    scenario_id: int,
    frequency: ScheduleFrequency,
    run_at: datetime,
    days_of_week: list[int] | None,
    notes: str | None,
) -> ScenarioSchedule:
    if frequency == ScheduleFrequency.WEEKLY and not days_of_week:
        raise HTTPException(400, "Select at least one day for weekly schedule")

    run_at = naive_utc(run_at)

    next_run = compute_next_run_at(
        frequency,
        run_at,
        days_of_week or [],
    )
    if next_run is None:
        raise HTTPException(400, "Scheduled time must be in the future")

    deactivate_existing_schedules(db, scenario_id)

    schedule = ScenarioSchedule(
        scenario_id=scenario_id,
        frequency=frequency,
        run_at=run_at,
        days_of_week=serialize_days_of_week(days_of_week or []) if frequency == ScheduleFrequency.WEEKLY else None,
        next_run_at=next_run,
        is_active=True,
        notes=notes,
    )
    db.add(schedule)
    db.commit()
    db.refresh(schedule)
    register_scenario_schedule(schedule)
    return schedule


def restore_scenario_schedules() -> None:
    db = SessionLocal()
    try:
        schedules = (
            db.query(ScenarioSchedule)
            .filter(ScenarioSchedule.is_active.is_(True))
            .all()
        )
        for schedule in schedules:
            if schedule.frequency == ScheduleFrequency.ONCE and schedule.next_run_at <= utc_now():
                schedule.is_active = False
                continue
            if schedule.frequency != ScheduleFrequency.ONCE:
                schedule.next_run_at = compute_next_run_at(
                    schedule.frequency,
                    schedule.run_at,
                    parse_days_of_week(schedule.days_of_week),
                ) or schedule.next_run_at
            register_scenario_schedule(schedule)
        db.commit()
    finally:
        db.close()


async def _fire_scenario_schedule(schedule_id: int) -> None:
    db = SessionLocal()
    try:
        schedule = db.get(ScenarioSchedule, schedule_id)
        if not schedule or not schedule.is_active:
            return

        run = TestRun(
            scenario_id=schedule.scenario_id,
            run_type=TestRunType.SCHEDULED,
            status=TestRunStatus.PENDING,
            scheduled_at=utc_now(),
            notes=schedule.notes,
        )
        db.add(run)
        db.commit()
        db.refresh(run)

        await try_start_or_queue(db, run)

        if schedule.frequency == ScheduleFrequency.ONCE:
            schedule.is_active = False
            unschedule_scenario(schedule.id)
        else:
            schedule.next_run_at = compute_next_run_at(
                schedule.frequency,
                schedule.run_at,
                parse_days_of_week(schedule.days_of_week),
            )
        db.commit()
    finally:
        db.close()
