"""Test run execution, scheduling, artifacts, and comparison."""

import os
import json
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session, joinedload

from app.database import SessionLocal, get_db
from app.models import Application, Build, Release, Scenario, ScenarioSchedule, TestRun, TestRunStatus, TestRunType
from app.schemas import (
    ArtifactInfo,
    AzureResourcesOut,
    CompareRequest,
    CompareRunSummary,
    ErrorSample,
    ErrorDetailOut,
    HostResourcesOut,
    ScheduledQueueItem,
    TestRunCreate,
    TestRunConsiderOut,
    TestRunConsiderRequest,
    TestRunDeleteFailure,
    TestRunDeleteOut,
    TestRunDeleteByDateOut,
    TestRunDeleteByDateRequest,
    TestRunDeleteRequest,
    TestRunLogsOut,
    TestRunActivityOut,
    TestRunOut,
    TestRunQueueOut,
    TestRunReportOut,
    TestRunSchedule,
    QueuedRunItem,
    TransactionMetric,
    normalize_run_notes,
)
from app.services.jmeter_runner import run_manager
from app.services.host_resources import load_host_resources
from app.services.azure_resources import load_azure_resources
from app.services.jtl_agg_cache import jtl_agg_cache
from app.services.system_config import get_system_config
from app.services.jtl_parser import (
    find_matching_trace_sample,
    get_error_detail_with_trace,
    parse_jtl_file,
    sample_to_error_detail,
    search_errors_from_jtl,
    _merge_error_detail,
)
from app.services.run_artifacts import (
    ensure_run_directory,
    remove_run_artifacts,
    resolve_jtl_path,
    resolve_errors_trace_jtl_path,
    resolve_log_path,
    resolve_run_file,
)
from app.services.scheduler import schedule_test_run, unschedule_test_run
from app.services.scenario_schedule import parse_days_of_week
from app.services.run_queue import process_run_queue, try_start_or_queue
from app.utils.datetime_utils import utc_now

router = APIRouter(prefix="/api/test-runs", tags=["test-runs"])

TERMINAL_RUN_STATUSES = frozenset(
    {TestRunStatus.COMPLETED, TestRunStatus.FAILED, TestRunStatus.CANCELLED}
)

MAX_LOG_CHUNK_BYTES = 512 * 1024


def _parse_scenario_tags(tag: str | None) -> list[str]:
    if not tag:
        return []
    try:
        parsed = json.loads(tag)
        if isinstance(parsed, list):
            return [str(t) for t in parsed]
    except json.JSONDecodeError:
        return [tag]
    return []


def _enrich_run(run: TestRun, db: Session) -> TestRunOut:
    scenario = db.get(Scenario, run.scenario_id)
    out = TestRunOut.model_validate(run)
    if scenario:
        out.scenario_name = scenario.name
        out.scenario_tags = _parse_scenario_tags(scenario.tag)
        app = db.get(Application, scenario.application_id)
        if app:
            out.application_name = app.name
            build = db.get(Build, app.build_id)
            if build:
                out.build_name = build.name
                release = db.get(Release, build.release_id)
                if release:
                    out.release_name = release.name
    return out


def _scenario_context(scenario: Scenario, db: Session) -> dict:
    ctx: dict = {
        "scenario_name": scenario.name,
        "scenario_tags": _parse_scenario_tags(scenario.tag),
        "release_id": None,
        "release_name": None,
        "build_id": None,
        "build_name": None,
        "application_id": scenario.application_id,
        "application_name": None,
    }
    app = db.get(Application, scenario.application_id)
    if app:
        ctx["application_name"] = app.name
        ctx["build_id"] = app.build_id
        build = db.get(Build, app.build_id)
        if build:
            ctx["build_name"] = build.name
            ctx["release_id"] = build.release_id
            release = db.get(Release, build.release_id)
            if release:
                ctx["release_name"] = release.name
    return ctx


def _list_scheduled_items(db: Session) -> list[ScheduledQueueItem]:
    items: list[ScheduledQueueItem] = []

    for schedule in (
        db.query(ScenarioSchedule)
        .filter(ScenarioSchedule.is_active.is_(True))
        .order_by(ScenarioSchedule.next_run_at.asc())
        .all()
    ):
        scenario = db.get(Scenario, schedule.scenario_id)
        if not scenario:
            continue
        frequency = (
            schedule.frequency.value
            if hasattr(schedule.frequency, "value")
            else str(schedule.frequency)
        )
        items.append(
            ScheduledQueueItem(
                schedule_id=schedule.id,
                scenario_id=scenario.id,
                frequency=frequency,
                run_at=schedule.run_at,
                days_of_week=parse_days_of_week(schedule.days_of_week),
                next_run_at=schedule.next_run_at,
                notes=schedule.notes,
                **_scenario_context(scenario, db),
            )
        )

    for run in (
        db.query(TestRun)
        .filter(TestRun.status == TestRunStatus.SCHEDULED, TestRun.is_archived.is_(False))
        .order_by(TestRun.scheduled_at.asc())
        .all()
    ):
        scenario = db.get(Scenario, run.scenario_id)
        if not scenario or not run.scheduled_at:
            continue
        items.append(
            ScheduledQueueItem(
                test_run_id=run.id,
                scenario_id=scenario.id,
                frequency="once",
                run_at=run.scheduled_at,
                next_run_at=run.scheduled_at,
                notes=run.notes,
                **_scenario_context(scenario, db),
            )
        )

    items.sort(key=lambda item: item.next_run_at)
    return items


@router.get("", response_model=list[TestRunOut])
def list_test_runs(
    release_id: int | None = None,
    build_id: int | None = None,
    status: TestRunStatus | None = None,
    include_archived: bool = False,
    db: Session = Depends(get_db),
):
    q = db.query(TestRun).order_by(TestRun.created_at.desc())
    if not include_archived:
        q = q.filter(TestRun.is_archived.is_(False))
    if status:
        q = q.filter(TestRun.status == status)
    runs = q.limit(200).all()
    enriched = [_enrich_run(r, db) for r in runs]
    if release_id or build_id:
        filtered = []
        for r in enriched:
            if build_id and r.build_name:
                build = db.query(Build).filter(Build.id == build_id).first()
                if build and r.build_name != build.name:
                    continue
            if release_id and r.release_name:
                release = db.get(Release, release_id)
                if release and r.release_name != release.name:
                    continue
            filtered.append(r)
        return filtered
    return enriched


@router.get("/queue", response_model=TestRunQueueOut)
def get_run_queue(db: Session = Depends(get_db)):
    running = (
        db.query(TestRun)
        .filter(TestRun.status == TestRunStatus.RUNNING, TestRun.is_archived.is_(False))
        .order_by(TestRun.started_at.asc())
        .first()
    )
    pending = (
        db.query(TestRun)
        .filter(TestRun.status == TestRunStatus.PENDING, TestRun.is_archived.is_(False))
        .order_by(TestRun.created_at.asc())
        .all()
    )
    return TestRunQueueOut(
        running=_enrich_run(running, db) if running else None,
        queued=[
            QueuedRunItem(**_enrich_run(run, db).model_dump(), queue_position=index + 1)
            for index, run in enumerate(pending)
        ],
        scheduled=_list_scheduled_items(db),
    )


@router.get("/activity", response_model=TestRunActivityOut)
def get_run_activity(db: Session = Depends(get_db)):
    """Cheap running/pending counts for adaptive frontend polling (no enrichment)."""
    running = (
        db.query(TestRun)
        .filter(TestRun.status == TestRunStatus.RUNNING, TestRun.is_archived.is_(False))
        .count()
    )
    pending = (
        db.query(TestRun)
        .filter(TestRun.status == TestRunStatus.PENDING, TestRun.is_archived.is_(False))
        .count()
    )
    return TestRunActivityOut(
        running=running,
        pending=pending,
        has_active=running > 0 or pending > 0,
    )


@router.get("/{run_id}", response_model=TestRunOut)
def get_test_run(run_id: int, db: Session = Depends(get_db)):
    run = db.get(TestRun, run_id)
    if not run:
        raise HTTPException(404, "Test run not found")
    return _enrich_run(run, db)


@router.post("", response_model=TestRunOut, status_code=201)
async def start_adhoc_run(body: TestRunCreate, db: Session = Depends(get_db)):
    scenario = db.get(Scenario, body.scenario_id)
    if not scenario:
        raise HTTPException(404, "Scenario not found")

    run = TestRun(
        scenario_id=body.scenario_id,
        run_type=TestRunType.ADHOC,
        status=TestRunStatus.PENDING,
        notes=normalize_run_notes(body.notes),
    )
    db.add(run)
    db.commit()
    db.refresh(run)

    await try_start_or_queue(db, run)
    db.refresh(run)
    return _enrich_run(run, db)


@router.post("/schedule", response_model=TestRunOut, status_code=201)
def schedule_run(body: TestRunSchedule, db: Session = Depends(get_db)):
    scenario = db.get(Scenario, body.scenario_id)
    if not scenario:
        raise HTTPException(404, "Scenario not found")
    if body.scheduled_at <= utc_now():
        raise HTTPException(400, "scheduled_at must be in the future")

    run = TestRun(
        scenario_id=body.scenario_id,
        run_type=TestRunType.SCHEDULED,
        status=TestRunStatus.SCHEDULED,
        scheduled_at=body.scheduled_at,
        notes=normalize_run_notes(body.notes),
    )
    db.add(run)
    db.commit()
    db.refresh(run)
    schedule_test_run(run.id, body.scheduled_at)
    return _enrich_run(run, db)


def _delete_test_run_record(run: TestRun, db: Session) -> None:
    """Cancel/stop if active, remove artifacts, and delete the DB row."""
    if run.status == TestRunStatus.SCHEDULED:
        unschedule_test_run(run.id)
    elif run.status in (TestRunStatus.RUNNING, TestRunStatus.PENDING):
        run_manager.cancel_run(run.id, run.pid)

    run_manager.cleanup_run(run.id)

    remove_run_artifacts(run)

    db.delete(run)


def _to_naive_utc(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    if dt.tzinfo is not None:
        return dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def _query_runs_by_finished_range(
    db: Session,
    *,
    finished_from: datetime | None,
    finished_to: datetime | None,
    include_archived: bool,
) -> list[TestRun]:
    if finished_from is None and finished_to is None:
        raise ValueError("At least one of finished_from or finished_to is required")

    start = _to_naive_utc(finished_from)
    end = _to_naive_utc(finished_to)
    if start and end and start > end:
        raise ValueError("finished_from must be before or equal to finished_to")

    q = db.query(TestRun).filter(
        TestRun.finished_at.isnot(None),
        TestRun.status.in_(tuple(TERMINAL_RUN_STATUSES)),
    )
    if start is not None:
        q = q.filter(TestRun.finished_at >= start)
    if end is not None:
        q = q.filter(TestRun.finished_at <= end)
    if not include_archived:
        q = q.filter(TestRun.is_archived.is_(False))

    return q.order_by(TestRun.finished_at.asc(), TestRun.id.asc()).all()


@router.post("/delete", response_model=TestRunDeleteOut)
def delete_test_runs(body: TestRunDeleteRequest, db: Session = Depends(get_db)):
    deleted: list[int] = []
    failed: list[TestRunDeleteFailure] = []

    for run_id in body.test_run_ids:
        run = db.get(TestRun, run_id)
        if not run:
            failed.append(TestRunDeleteFailure(id=run_id, error="Test run not found"))
            continue
        try:
            _delete_test_run_record(run, db)
            deleted.append(run_id)
        except Exception as exc:
            failed.append(TestRunDeleteFailure(id=run_id, error=str(exc)))

    db.commit()
    return TestRunDeleteOut(deleted=deleted, failed=failed)


@router.post("/delete-by-date", response_model=TestRunDeleteByDateOut)
def delete_test_runs_by_date(body: TestRunDeleteByDateRequest, db: Session = Depends(get_db)):
    try:
        matches = _query_runs_by_finished_range(
            db,
            finished_from=body.finished_from,
            finished_to=body.finished_to,
            include_archived=body.include_archived,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    sample_ids = [run.id for run in matches[:20]]
    if body.dry_run:
        return TestRunDeleteByDateOut(match_count=len(matches), sample_ids=sample_ids)

    deleted: list[int] = []
    failed: list[TestRunDeleteFailure] = []

    for run in matches:
        try:
            _delete_test_run_record(run, db)
            deleted.append(run.id)
        except Exception as exc:
            failed.append(TestRunDeleteFailure(id=run.id, error=str(exc)))

    db.commit()
    return TestRunDeleteByDateOut(
        match_count=len(matches),
        sample_ids=sample_ids,
        deleted=deleted,
        failed=failed,
    )


@router.post("/consider-for-release", response_model=TestRunConsiderOut)
def set_consider_for_release(body: TestRunConsiderRequest, db: Session = Depends(get_db)):
    updated: list[int] = []
    failed: list[TestRunDeleteFailure] = []

    for run_id in body.test_run_ids:
        run = db.get(TestRun, run_id)
        if not run:
            failed.append(TestRunDeleteFailure(id=run_id, error="Test run not found"))
            continue
        if run.status not in TERMINAL_RUN_STATUSES:
            failed.append(
                TestRunDeleteFailure(
                    id=run_id,
                    error="Only completed, failed, or stopped runs can be marked for release",
                )
            )
            continue
        run.consider_for_release = body.consider
        updated.append(run_id)

    db.commit()
    return TestRunConsiderOut(updated=updated, failed=failed)


@router.post("/{run_id}/cancel")
async def cancel_run(run_id: int, db: Session = Depends(get_db)):
    run = db.get(TestRun, run_id)
    if not run:
        raise HTTPException(404, "Test run not found")
    if run.status not in (TestRunStatus.RUNNING, TestRunStatus.PENDING, TestRunStatus.SCHEDULED):
        raise HTTPException(400, "Run cannot be cancelled")
    if run.status == TestRunStatus.SCHEDULED:
        unschedule_test_run(run_id)
    elif run.status == TestRunStatus.RUNNING:
        run_manager.cancel_run(run_id, run.pid)
    run.status = TestRunStatus.CANCELLED
    run.finished_at = datetime.utcnow()
    db.commit()

    await process_run_queue()
    db_after = SessionLocal()
    try:
        from app.services.update_manager import update_manager

        update_manager.try_apply_pending(db_after)
    finally:
        db_after.close()
    return {"ok": True}


def _metrics_snapshot_for_run(run: TestRun) -> dict:
    """Build live metrics from in-memory aggregator and/or JTL file on disk."""
    agg = _aggregator_for_run(run)
    if agg is None:
        raise HTTPException(404, "No metrics available yet")

    if run.status in (TestRunStatus.COMPLETED, TestRunStatus.FAILED, TestRunStatus.CANCELLED):
        agg.status = run.status
    elif run.status == TestRunStatus.RUNNING:
        agg.status = TestRunStatus.RUNNING

    return agg.snapshot().model_dump(mode="json")


def _aggregator_for_run(run: TestRun):
    """Resolve the best metrics aggregator for a test run.

    Completed runs use a process-wide single-flight LRU cache so parallel report
    tabs share one JTL parse instead of stampeding the CPU.
    """
    agg = run_manager.get_aggregator(run.id)
    jtl = resolve_jtl_path(run)

    if run.status == TestRunStatus.RUNNING:
        if agg is not None and agg.samples:
            return agg
        if jtl:
            file_agg = parse_jtl_file(jtl)
            file_agg.test_run_id = run.id
            return file_agg
        return agg

    if jtl:
        def _load():
            file_agg = parse_jtl_file(jtl)
            file_agg.test_run_id = run.id
            return file_agg

        file_agg = jtl_agg_cache.get_or_load(run.id, jtl, _load)
        if agg is None or len(file_agg.samples) >= len(agg.samples):
            return file_agg
        return agg
    return agg


@router.get("/{run_id}/resources", response_model=HostResourcesOut)
def get_run_resources(run_id: int, db: Session = Depends(get_db)):
    run = db.get(TestRun, run_id)
    if not run:
        raise HTTPException(404, "Test run not found")
    run_dir = ensure_run_directory(run)
    if not run_dir:
        cfg = get_system_config(db)
        return HostResourcesOut(
            interval_seconds=cfg.resource_sample_interval_seconds,
            samples=[],
        )
    data = load_host_resources(run_dir)
    return HostResourcesOut.model_validate(data)


@router.get("/{run_id}/azure-resources", response_model=AzureResourcesOut)
def get_run_azure_resources(run_id: int, db: Session = Depends(get_db)):
    """Azure VM CPU/Memory samples stored with the run (for live + past reports)."""
    run = db.get(TestRun, run_id)
    if not run:
        raise HTTPException(404, "Test run not found")
    run_dir = ensure_run_directory(run)
    if not run_dir:
        return AzureResourcesOut(interval_seconds=60, targets=[], samples=[])
    data = load_azure_resources(run_dir)
    return AzureResourcesOut.model_validate(data)


@router.get("/{run_id}/metrics")
def get_run_metrics(run_id: int, db: Session = Depends(get_db)):
    run = db.get(TestRun, run_id)
    if not run:
        raise HTTPException(404, "Test run not found")
    return _metrics_snapshot_for_run(run)


@router.get("/{run_id}/report", response_model=TestRunReportOut)
def get_run_report(
    run_id: int,
    error_limit: int = Query(default=200, ge=1, le=500),
    db: Session = Depends(get_db),
):
    """Full report in one response — preferred for finished runs / parallel tabs.

    Builds metrics, errors, and default graphs from a single aggregator load so
    browsers do not open multiple long-lived connections that time out.
    """
    run = db.get(TestRun, run_id)
    if not run:
        raise HTTPException(404, "Test run not found")
    agg = _aggregator_for_run(run)
    if agg is None:
        raise HTTPException(404, "No metrics available yet")

    if run.status in TERMINAL_RUN_STATUSES:
        agg.status = run.status
    elif run.status == TestRunStatus.RUNNING:
        agg.status = TestRunStatus.RUNNING

    metrics = agg.snapshot()
    errors = agg.search_errors(None, error_limit)
    return TestRunReportOut(
        metrics=metrics,
        errors=errors,
        response_time_graph=agg.label_graph(labels=["ALL"], cumulative=True),
        errors_graph=agg.error_graph(labels=["ALL"], cumulative=False),
    )


@router.get("/{run_id}/aggregate-total", response_model=TransactionMetric)
def get_aggregate_total(
    run_id: int,
    kind: str = Query(default="all", pattern="^(all|transaction|request)$"),
    label: str | None = Query(default=None),
    db: Session = Depends(get_db),
):
    run = db.get(TestRun, run_id)
    if not run:
        raise HTTPException(404, "Test run not found")
    agg = _aggregator_for_run(run)
    if agg is None:
        raise HTTPException(404, "No metrics available yet")
    if run.status in (TestRunStatus.COMPLETED, TestRunStatus.FAILED, TestRunStatus.CANCELLED):
        agg.status = run.status
    elif run.status == TestRunStatus.RUNNING:
        agg.status = TestRunStatus.RUNNING

    total = agg.transaction_totals(label_filter=label, kind_filter=kind)
    if total is None:
        raise HTTPException(404, "No samples match the current filters")
    return total


@router.get("/{run_id}/errors/{sample_index}", response_model=ErrorDetailOut)
def get_run_error_detail(run_id: int, sample_index: int, db: Session = Depends(get_db)):
    run = db.get(TestRun, run_id)
    if not run:
        raise HTTPException(404, "Test run not found")

    main_jtl = resolve_jtl_path(run)
    trace_jtl = resolve_errors_trace_jtl_path(run)
    agg = _aggregator_for_run(run)
    main_sample = None
    if agg and 0 <= sample_index < len(agg.samples):
        main_sample = agg.samples[sample_index]

    detail = get_error_detail_with_trace(
        main_jtl,
        trace_jtl,
        sample_index,
        main_sample=main_sample,
    )
    if detail:
        return detail

    if main_sample is not None and not main_sample.success:
        if trace_jtl:
            trace_sample = find_matching_trace_sample(trace_jtl, main_sample)
            if trace_sample is not None:
                out = sample_to_error_detail(trace_sample, from_errors_trace=True)
                out.sample_index = sample_index
                return _merge_error_detail(out, sample_to_error_detail(main_sample))
        return sample_to_error_detail(main_sample)

    raise HTTPException(404, "Error sample not found")


@router.get("/{run_id}/errors", response_model=list[ErrorSample])
def get_run_errors(
    run_id: int,
    search: str | None = Query(default=None),
    limit: int = Query(default=200, ge=1, le=500),
    db: Session = Depends(get_db),
):
    run = db.get(TestRun, run_id)
    if not run:
        raise HTTPException(404, "Test run not found")
    agg = _aggregator_for_run(run)
    if agg and (agg.samples or agg.errors):
        return agg.search_errors(search, limit)
    jtl = resolve_jtl_path(run)
    if jtl:
        return search_errors_from_jtl(jtl, search, limit)
    return []


def _read_jmeter_log(log_path: Path, offset: int) -> tuple[str, int]:
    if not log_path.is_file():
        return "", 0
    size = log_path.stat().st_size
    if offset >= size:
        return "", size
    with open(log_path, encoding="utf-8", errors="replace") as f:
        if offset == 0 and size > MAX_LOG_CHUNK_BYTES:
            f.seek(size - MAX_LOG_CHUNK_BYTES)
            content = f.read()
            nl = content.find("\n")
            if nl >= 0:
                content = content[nl + 1 :]
            return content, size
        f.seek(offset)
        content = f.read()
        if len(content.encode("utf-8", errors="replace")) > MAX_LOG_CHUNK_BYTES:
            content = content[-MAX_LOG_CHUNK_BYTES:]
            nl = content.find("\n")
            if nl >= 0:
                content = content[nl + 1 :]
        return content, size


@router.get("/{run_id}/logs", response_model=TestRunLogsOut)
def get_run_logs(
    run_id: int,
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    run = db.get(TestRun, run_id)
    if not run:
        raise HTTPException(404, "Test run not found")
    log_path = resolve_log_path(run)
    if not log_path:
        return TestRunLogsOut(content="", offset=0, size=0, complete=run.status in (
            TestRunStatus.COMPLETED, TestRunStatus.FAILED, TestRunStatus.CANCELLED
        ))

    content, size = _read_jmeter_log(log_path, offset)
    complete = run.status in (TestRunStatus.COMPLETED, TestRunStatus.FAILED, TestRunStatus.CANCELLED)
    return TestRunLogsOut(content=content, offset=size, size=size, complete=complete)


@router.get("/{run_id}/graph")
def get_run_graph(
    run_id: int,
    labels: list[str] = Query(default=[]),
    cumulative: bool = False,
    db: Session = Depends(get_db),
):
    run = db.get(TestRun, run_id)
    if not run:
        raise HTTPException(404, "Test run not found")
    agg = _aggregator_for_run(run)
    if not agg:
        raise HTTPException(404, "No graph data available")
    return agg.label_graph(labels=labels or None, cumulative=cumulative)


@router.get("/{run_id}/errors-graph")
def get_run_errors_graph(
    run_id: int,
    labels: list[str] = Query(default=[]),
    cumulative: bool = False,
    db: Session = Depends(get_db),
):
    run = db.get(TestRun, run_id)
    if not run:
        raise HTTPException(404, "Test run not found")
    agg = _aggregator_for_run(run)
    if not agg:
        raise HTTPException(404, "No error graph data available")
    return agg.error_graph(labels=labels or None, cumulative=cumulative)


@router.get("/{run_id}/artifacts", response_model=list[ArtifactInfo])
def list_artifacts(run_id: int, db: Session = Depends(get_db)):
    run = db.get(TestRun, run_id)
    root = ensure_run_directory(run)
    if not root:
        raise HTTPException(404, "Run or artifacts not found")
    items: list[ArtifactInfo] = []
    for p in sorted(root.rglob("*")):
        if p.name == ".source":
            continue
        rel = p.relative_to(root)
        items.append(
            ArtifactInfo(
                name=str(rel),
                path=str(p),
                size_bytes=p.stat().st_size if p.is_file() else 0,
                is_directory=p.is_dir(),
            )
        )
    return items


@router.get("/{run_id}/download")
def download_artifact(
    run_id: int,
    file: str = Query(..., description="Relative path within run directory"),
    db: Session = Depends(get_db),
):
    run = db.get(TestRun, run_id)
    if not run or not run.run_dir:
        raise HTTPException(404, "Run not found")
    target = resolve_run_file(run, file)
    if not target:
        raise HTTPException(404, "File not found")
    return FileResponse(target, filename=target.name)


@router.post("/compare", response_model=list[CompareRunSummary])
def compare_runs(body: CompareRequest, db: Session = Depends(get_db)):
    summaries: list[CompareRunSummary] = []
    for run_id in body.test_run_ids:
        run = db.get(TestRun, run_id)
        if not run:
            continue
        enriched = _enrich_run(run, db)
        transactions: list[TransactionMetric] = []
        agg = _aggregator_for_run(run)
        if agg is not None:
            transactions = agg.transaction_metrics()

        summaries.append(
            CompareRunSummary(
                test_run_id=run.id,
                scenario_name=enriched.scenario_name or "",
                release_name=enriched.release_name or "",
                build_name=enriched.build_name or "",
                status=run.status,
                started_at=run.started_at,
                finished_at=run.finished_at,
                transactions=transactions,
            )
        )
    return summaries
