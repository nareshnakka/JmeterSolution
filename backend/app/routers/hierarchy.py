"""Release / build / application / scenario CRUD routes."""

import json
import shutil
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from sqlalchemy.orm import Session, joinedload

from app.database import get_db
from app.models import (
    Application,
    Build,
    Release,
    Scenario,
    ScenarioFile,
    ScenarioFileKind,
    ScenarioSchedule,
    ScheduleFrequency,
    TestRun,
    TestRunStatus,
)
from app.schemas import (
    ApplicationCreate,
    ApplicationOut,
    BuildCreate,
    BuildOut,
    ReleaseCreate,
    ReleaseOut,
    ScenarioFileOut,
    ScenarioListItem,
    ScenarioOut,
    ScenarioScheduleCreate,
    ScenarioScheduleOut,
)
from app.scenario_properties import parse_jmeter_properties, properties_from_form, serialize_jmeter_properties
from app.services.jmeter_runner import run_manager
from app.services.scenario_schedule import (
    create_scenario_schedule,
    deactivate_scenario_schedule,
    parse_days_of_week,
)
from app.services.run_queue import process_run_queue
from app.services.storage import (
    ensure_application_dirs,
    resolve_scenario_file_path,
    resolve_scenario_jmx,
    scenario_dependencies_dir,
    scenario_scripts_dir,
    scenario_uploads_dir,
)

router = APIRouter(prefix="/api", tags=["hierarchy"])

MAX_SCENARIO_TAGS = 5


def _serialize_tags(tags: list[str]) -> str | None:
    unique: list[str] = []
    seen: set[str] = set()
    for raw in tags:
        tag = raw.strip()
        if not tag:
            continue
        key = tag.lower()
        if key in seen:
            continue
        seen.add(key)
        unique.append(tag)
    if len(unique) > MAX_SCENARIO_TAGS:
        raise HTTPException(400, f"Maximum {MAX_SCENARIO_TAGS} tags allowed")
    return json.dumps(unique) if unique else None


def _parse_tags(tag: str | None) -> list[str]:
    if not tag:
        return []
    try:
        parsed = json.loads(tag)
        if isinstance(parsed, list):
            return [str(t) for t in parsed]
    except json.JSONDecodeError:
        return [tag]
    return []


def _matches(text: str | None, query: str | None) -> bool:
    if not query:
        return True
    return query.lower() in (text or "").lower()


async def _save_scenario_files(
    db: Session,
    scenario: Scenario,
    release: Release,
    build: Build,
    app: Application,
    uploads: list[UploadFile],
    kind: ScenarioFileKind,
) -> list[ScenarioFile]:
    if kind == ScenarioFileKind.DEPENDENCY:
        dest_dir = scenario_dependencies_dir(release, build, app)
    else:
        dest_dir = scenario_uploads_dir(release, build, app)

    saved: list[ScenarioFile] = []
    for upload in uploads:
        if not upload.filename:
            continue
        dest = dest_dir / upload.filename
        dest.write_bytes(await upload.read())
        sf = (
            db.query(ScenarioFile)
            .filter(
                ScenarioFile.scenario_id == scenario.id,
                ScenarioFile.filename == upload.filename,
                ScenarioFile.kind == kind,
            )
            .first()
        )
        if not sf:
            sf = ScenarioFile(scenario_id=scenario.id, filename=upload.filename, kind=kind)
            db.add(sf)
        saved.append(sf)
    if saved:
        db.commit()
        for sf in saved:
            db.refresh(sf)
    return saved


def _unique_scenario_name(db: Session, application_id: int, source_name: str) -> str:
    base = f"Clone_{source_name}"
    if not db.query(Scenario).filter(Scenario.application_id == application_id, Scenario.name == base).first():
        return base
    n = 2
    while True:
        candidate = f"Clone_{source_name}_{n}"
        if not db.query(Scenario).filter(Scenario.application_id == application_id, Scenario.name == candidate).first():
            return candidate
        n += 1


def _unique_filename(directory: Path, filename: str, prefix: str = "Clone_") -> str:
    candidate = f"{prefix}{filename}" if not filename.startswith(prefix) else f"{prefix}copy_{filename}"
    if not (directory / candidate).exists():
        return candidate
    stem = Path(filename).stem
    suffix = Path(filename).suffix
    n = 2
    while True:
        candidate = f"{prefix}{stem}_{n}{suffix}"
        if not (directory / candidate).exists():
            return candidate
        n += 1


def _clone_scenario_record(
    db: Session,
    source: Scenario,
    release: Release,
    build: Build,
    app: Application,
) -> Scenario:
    scripts_dir = scenario_scripts_dir(release, build, app)
    uploads_dir = scenario_uploads_dir(release, build, app)
    scripts_dir.mkdir(parents=True, exist_ok=True)
    uploads_dir.mkdir(parents=True, exist_ok=True)

    source_jmx = resolve_scenario_jmx(release, build, app, source)
    if not source_jmx.is_file():
        raise HTTPException(404, f"JMX file not found: {source.jmx_filename}")

    new_jmx_name = _unique_filename(scripts_dir, source.jmx_filename)
    shutil.copy2(source_jmx, scripts_dir / new_jmx_name)

    clone = Scenario(
        application_id=source.application_id,
        name=_unique_scenario_name(db, source.application_id, source.name),
        tag=source.tag,
        jmx_filename=new_jmx_name,
        description=source.description,
        jmeter_properties_json=source.jmeter_properties_json,
    )
    db.add(clone)
    db.commit()
    db.refresh(clone)

    source_files = db.query(ScenarioFile).filter(ScenarioFile.scenario_id == source.id).all()
    for sf in source_files:
        src_path = resolve_scenario_file_path(release, build, app, sf.filename, sf.kind)
        if sf.kind == ScenarioFileKind.UPLOAD:
            if src_path.is_file():
                new_name = _unique_filename(uploads_dir, sf.filename)
                shutil.copy2(src_path, uploads_dir / new_name)
                db.add(ScenarioFile(scenario_id=clone.id, filename=new_name, kind=sf.kind))
            continue
        if src_path.is_file() or (scripts_dir / sf.filename).is_file():
            db.add(ScenarioFile(scenario_id=clone.id, filename=sf.filename, kind=sf.kind))

    db.commit()
    db.refresh(clone)
    return clone


# --- Releases ---

@router.get("/releases", response_model=list[ReleaseOut])
def list_releases(db: Session = Depends(get_db)):
    return db.query(Release).order_by(Release.created_at.desc()).all()


@router.post("/releases", response_model=ReleaseOut, status_code=201)
def create_release(body: ReleaseCreate, db: Session = Depends(get_db)):
    existing = db.query(Release).filter(Release.name == body.name).first()
    if existing:
        raise HTTPException(409, f"Release '{body.name}' already exists")
    release = Release(name=body.name, description=body.description)
    db.add(release)
    db.commit()
    db.refresh(release)
    return release


@router.get("/releases/{release_id}", response_model=ReleaseOut)
def get_release(release_id: int, db: Session = Depends(get_db)):
    release = db.get(Release, release_id)
    if not release:
        raise HTTPException(404, "Release not found")
    return release


# --- Builds ---

@router.get("/releases/{release_id}/builds", response_model=list[BuildOut])
def list_builds(release_id: int, db: Session = Depends(get_db)):
    return db.query(Build).filter(Build.release_id == release_id).order_by(Build.created_at.desc()).all()


@router.post("/releases/{release_id}/builds", response_model=BuildOut, status_code=201)
def create_build(release_id: int, body: BuildCreate, db: Session = Depends(get_db)):
    release = db.get(Release, release_id)
    if not release:
        raise HTTPException(404, "Release not found")
    build = Build(release_id=release_id, name=body.name, description=body.description)
    db.add(build)
    db.commit()
    db.refresh(build)
    return build


# --- Applications ---

@router.get("/builds/{build_id}/applications", response_model=list[ApplicationOut])
def list_applications(build_id: int, db: Session = Depends(get_db)):
    return db.query(Application).filter(Application.build_id == build_id).order_by(Application.created_at.desc()).all()


@router.post("/builds/{build_id}/applications", response_model=ApplicationOut, status_code=201)
def create_application(build_id: int, body: ApplicationCreate, db: Session = Depends(get_db)):
    build = db.get(Build, build_id)
    if not build:
        raise HTTPException(404, "Build not found")
    release = db.get(Release, build.release_id)
    app = Application(
        build_id=build_id,
        name=body.name,
        app_type=body.app_type,
        description=body.description,
    )
    db.add(app)
    db.commit()
    db.refresh(app)
    ensure_application_dirs(release, build, app)
    return app


# --- Scenarios ---

@router.get("/scenarios", response_model=list[ScenarioListItem])
def list_all_scenarios(
    release: str | None = Query(None, description="Filter by release name (contains)"),
    build: str | None = Query(None, description="Filter by build name (contains)"),
    application: str | None = Query(None, description="Filter by application name (contains)"),
    name: str | None = Query(None, description="Filter by scenario name (contains)"),
    tag: str | None = Query(None, description="Filter by tag (contains)"),
    run_from: datetime | None = Query(None, description="Last run started on or after"),
    run_to: datetime | None = Query(None, description="Last run started on or before"),
    last_run_status: TestRunStatus | None = Query(None, description="Filter by last run status"),
    db: Session = Depends(get_db),
):
    scenarios = (
        db.query(Scenario)
        .options(
            joinedload(Scenario.application)
            .joinedload(Application.build)
            .joinedload(Build.release)
        )
        .order_by(Scenario.created_at.desc())
        .all()
    )

    scenario_ids = [s.id for s in scenarios]
    latest_run: dict[int, TestRun] = {}
    active_run: dict[int, TestRun] = {}
    if scenario_ids:
        runs = (
            db.query(TestRun)
            .filter(TestRun.scenario_id.in_(scenario_ids))
            .order_by(TestRun.created_at.desc())
            .all()
        )
        for run in runs:
            if run.scenario_id not in latest_run:
                latest_run[run.scenario_id] = run
            if run.status == TestRunStatus.RUNNING:
                active_run[run.scenario_id] = run

    schedule_by_scenario: dict[int, ScenarioSchedule] = {}
    queued_by_scenario: dict[int, TestRun] = {}
    if scenario_ids:
        for schedule in (
            db.query(ScenarioSchedule)
            .filter(ScenarioSchedule.scenario_id.in_(scenario_ids), ScenarioSchedule.is_active.is_(True))
            .all()
        ):
            schedule_by_scenario[schedule.scenario_id] = schedule
        for run in (
            db.query(TestRun)
            .filter(TestRun.scenario_id.in_(scenario_ids), TestRun.status == TestRunStatus.PENDING)
            .order_by(TestRun.created_at.asc())
            .all()
        ):
            if run.scenario_id not in queued_by_scenario:
                queued_by_scenario[run.scenario_id] = run

    items: list[ScenarioListItem] = []
    for scenario in scenarios:
        app = scenario.application
        build_obj = app.build
        release_obj = build_obj.release
        tags = _parse_tags(scenario.tag)
        last = latest_run.get(scenario.id)
        active = active_run.get(scenario.id)
        schedule = schedule_by_scenario.get(scenario.id)
        queued = queued_by_scenario.get(scenario.id)

        if not _matches(release_obj.name, release):
            continue
        if not _matches(build_obj.name, build):
            continue
        if not _matches(app.name, application):
            continue
        if not _matches(scenario.name, name):
            continue
        if tag and not any(tag.lower() in t.lower() for t in tags):
            continue
        if last_run_status:
            if last_run_status == TestRunStatus.RUNNING:
                if not active:
                    continue
            elif not last or last.status != last_run_status:
                continue
        if run_from or run_to:
            run_date = last.started_at if last and last.started_at else None
            if not run_date:
                continue
            if run_from and run_date < run_from:
                continue
            if run_to and run_date > run_to:
                continue

        items.append(
            ScenarioListItem(
                id=scenario.id,
                name=scenario.name,
                tags=tags,
                jmx_filename=scenario.jmx_filename,
                jmeter_properties=parse_jmeter_properties(scenario.jmeter_properties_json),
                release_id=release_obj.id,
                release_name=release_obj.name,
                build_id=build_obj.id,
                build_name=build_obj.name,
                application_id=app.id,
                application_name=app.name,
                application_type=app.app_type,
                created_at=scenario.created_at,
                last_run_id=last.id if last else None,
                last_run_status=last.status if last else None,
                last_run_started_at=last.started_at if last else None,
                last_run_finished_at=last.finished_at if last else None,
                active_run_id=active.id if active else None,
                is_running=active is not None,
                schedule_id=schedule.id if schedule else None,
                schedule_frequency=(
                    schedule.frequency.value if schedule and hasattr(schedule.frequency, "value")
                    else str(schedule.frequency) if schedule else None
                ),
                next_run_at=schedule.next_run_at if schedule else None,
                queued_run_id=queued.id if queued else None,
                is_queued=queued is not None,
            )
        )
    return items


def _schedule_to_out(schedule: ScenarioSchedule) -> ScenarioScheduleOut:
    frequency = schedule.frequency.value if hasattr(schedule.frequency, "value") else str(schedule.frequency)
    return ScenarioScheduleOut(
        id=schedule.id,
        scenario_id=schedule.scenario_id,
        frequency=frequency,
        run_at=schedule.run_at,
        days_of_week=parse_days_of_week(schedule.days_of_week),
        next_run_at=schedule.next_run_at,
        is_active=schedule.is_active,
        notes=schedule.notes,
        created_at=schedule.created_at,
    )


@router.get("/scenarios/{scenario_id}/schedule", response_model=ScenarioScheduleOut | None)
def get_scenario_schedule(scenario_id: int, db: Session = Depends(get_db)):
    scenario = db.get(Scenario, scenario_id)
    if not scenario:
        raise HTTPException(404, "Scenario not found")
    schedule = (
        db.query(ScenarioSchedule)
        .filter(ScenarioSchedule.scenario_id == scenario_id, ScenarioSchedule.is_active.is_(True))
        .first()
    )
    if not schedule:
        return None
    return _schedule_to_out(schedule)


@router.post("/scenarios/{scenario_id}/schedule", response_model=ScenarioScheduleOut, status_code=201)
def create_scenario_schedule_route(
    scenario_id: int,
    body: ScenarioScheduleCreate,
    db: Session = Depends(get_db),
):
    scenario = db.get(Scenario, scenario_id)
    if not scenario:
        raise HTTPException(404, "Scenario not found")
    try:
        frequency = ScheduleFrequency(body.frequency)
    except ValueError as exc:
        raise HTTPException(400, "Invalid schedule frequency") from exc

    try:
        schedule = create_scenario_schedule(
            db,
            scenario_id,
            frequency,
            body.run_at,
            body.days_of_week,
            body.notes,
        )
        return _schedule_to_out(schedule)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(500, f"Failed to save schedule: {exc}") from exc


@router.delete("/scenarios/{scenario_id}/schedule")
async def cancel_scenario_schedule(scenario_id: int, db: Session = Depends(get_db)):
    scenario = db.get(Scenario, scenario_id)
    if not scenario:
        raise HTTPException(404, "Scenario not found")
    schedule = (
        db.query(ScenarioSchedule)
        .filter(ScenarioSchedule.scenario_id == scenario_id, ScenarioSchedule.is_active.is_(True))
        .first()
    )
    if schedule:
        deactivate_scenario_schedule(db, schedule)

    pending_runs = (
        db.query(TestRun)
        .filter(TestRun.scenario_id == scenario_id, TestRun.status == TestRunStatus.PENDING)
        .all()
    )
    now = datetime.utcnow()
    for run in pending_runs:
        run.status = TestRunStatus.CANCELLED
        run.finished_at = now
    db.commit()
    await process_run_queue()
    return {"ok": True}


@router.post("/scenarios/{scenario_id}/stop")
async def stop_scenario_run(scenario_id: int, db: Session = Depends(get_db)):
    scenario = db.get(Scenario, scenario_id)
    if not scenario:
        raise HTTPException(404, "Scenario not found")
    run = (
        db.query(TestRun)
        .filter(
            TestRun.scenario_id == scenario_id,
            TestRun.status.in_([TestRunStatus.RUNNING, TestRunStatus.PENDING]),
        )
        .order_by(TestRun.created_at.desc())
        .first()
    )
    if not run:
        raise HTTPException(404, "No active run for this scenario")
    if run.status == TestRunStatus.RUNNING:
        run_manager.cancel_run(run.id, run.pid)
    run.status = TestRunStatus.CANCELLED
    run.finished_at = datetime.utcnow()
    db.commit()
    await process_run_queue()
    return {"ok": True, "test_run_id": run.id}


def _scenario_context(db: Session, scenario_id: int):
    scenario = db.get(Scenario, scenario_id)
    if not scenario:
        raise HTTPException(404, "Scenario not found")
    app = db.get(Application, scenario.application_id)
    build = db.get(Build, app.build_id)
    release = db.get(Release, build.release_id)
    return scenario, release, build, app


def _ensure_scenario_editable(db: Session, scenario_id: int) -> None:
    active = (
        db.query(TestRun)
        .filter(
            TestRun.scenario_id == scenario_id,
            TestRun.status.in_([TestRunStatus.RUNNING, TestRunStatus.PENDING]),
        )
        .first()
    )
    if active:
        raise HTTPException(409, "Cannot edit scenario while a test is running")


@router.get("/scenarios/{scenario_id}", response_model=ScenarioOut)
def get_scenario(scenario_id: int, db: Session = Depends(get_db)):
    scenario = db.get(Scenario, scenario_id)
    if not scenario:
        raise HTTPException(404, "Scenario not found")
    return scenario


@router.post("/scenarios/{scenario_id}/clone", response_model=ScenarioOut, status_code=201)
def clone_scenario(scenario_id: int, db: Session = Depends(get_db)):
    scenario, release, build, app = _scenario_context(db, scenario_id)
    ensure_application_dirs(release, build, app)
    return _clone_scenario_record(db, scenario, release, build, app)


@router.post("/scenarios/{scenario_id}/update", response_model=ScenarioOut)
async def update_scenario(
    scenario_id: int,
    name: str | None = Form(default=None),
    update_tags: bool = Form(default=False),
    tags: list[str] = Form(default=[]),
    update_jmeter_properties: bool = Form(default=False),
    property_names: list[str] = Form(default=[]),
    property_values: list[str] = Form(default=[]),
    jmx: UploadFile | None = File(default=None),
    dependencies: list[UploadFile] = File(default=[]),
    remove_file_ids: list[int] = Form(default=[]),
    db: Session = Depends(get_db),
):
    _ensure_scenario_editable(db, scenario_id)
    scenario, release, build, app = _scenario_context(db, scenario_id)

    valid_deps = [d for d in dependencies if d.filename and (d.size or 0) > 0]
    has_jmx = jmx is not None and bool(jmx.filename) and (jmx.size or 0) > 0
    has_changes = (
        name is not None
        or update_tags
        or update_jmeter_properties
        or has_jmx
        or bool(valid_deps)
        or bool(remove_file_ids)
    )
    if not has_changes:
        raise HTTPException(400, "No changes to save")

    if name is not None:
        stripped = name.strip()
        if not stripped:
            raise HTTPException(400, "Scenario name cannot be empty")
        scenario.name = stripped

    if update_tags:
        scenario.tag = _serialize_tags(tags)

    if update_jmeter_properties:
        props = properties_from_form(property_names, property_values)
        scenario.jmeter_properties_json = serialize_jmeter_properties(props)

    if has_jmx:
        assert jmx is not None and jmx.filename
        if not jmx.filename.lower().endswith(".jmx"):
            raise HTTPException(400, "Upload must be a .jmx file")
        scripts_dir = scenario_scripts_dir(release, build, app)
        old_path = scripts_dir / scenario.jmx_filename
        new_path = scripts_dir / jmx.filename
        new_path.write_bytes(await jmx.read())
        if old_path.resolve() != new_path.resolve() and old_path.exists():
            old_path.unlink()
        scenario.jmx_filename = jmx.filename

    for file_id in remove_file_ids:
        sf = db.query(ScenarioFile).filter(
            ScenarioFile.id == file_id,
            ScenarioFile.scenario_id == scenario_id,
        ).first()
        if not sf:
            continue
        disk_path = resolve_scenario_file_path(release, build, app, sf.filename, sf.kind)
        if disk_path.is_file():
            disk_path.unlink()
        db.delete(sf)

    if valid_deps:
        await _save_scenario_files(db, scenario, release, build, app, valid_deps, ScenarioFileKind.DEPENDENCY)

    db.commit()
    db.refresh(scenario)
    return scenario


@router.delete("/scenarios/{scenario_id}/files/{file_id}", status_code=204)
def delete_scenario_file(scenario_id: int, file_id: int, db: Session = Depends(get_db)):
    _ensure_scenario_editable(db, scenario_id)
    scenario, release, build, app = _scenario_context(db, scenario_id)
    sf = db.query(ScenarioFile).filter(
        ScenarioFile.id == file_id,
        ScenarioFile.scenario_id == scenario_id,
    ).first()
    if not sf:
        raise HTTPException(404, "File not found")
    disk_path = resolve_scenario_file_path(release, build, app, sf.filename, sf.kind)
    if disk_path.is_file():
        disk_path.unlink()
    db.delete(sf)
    db.commit()


@router.get("/applications/{app_id}/scenarios", response_model=list[ScenarioOut])
def list_scenarios(app_id: int, db: Session = Depends(get_db)):
    return db.query(Scenario).filter(Scenario.application_id == app_id).order_by(Scenario.created_at.desc()).all()


@router.post("/applications/{app_id}/scenarios", response_model=ScenarioOut, status_code=201)
async def create_scenario(
    app_id: int,
    name: str = Form(...),
    tags: list[str] = Form(default=[]),
    description: str | None = Form(None),
    property_names: list[str] = Form(default=[]),
    property_values: list[str] = Form(default=[]),
    jmx: UploadFile = File(...),
    dependencies: list[UploadFile] = File(default=[]),
    db: Session = Depends(get_db),
):
    app = db.get(Application, app_id)
    if not app:
        raise HTTPException(404, "Application not found")
    build = db.get(Build, app.build_id)
    release = db.get(Release, build.release_id)
    ensure_application_dirs(release, build, app)

    if not jmx.filename or not jmx.filename.lower().endswith(".jmx"):
        raise HTTPException(400, "Upload must be a .jmx file")

    dest = scenario_scripts_dir(release, build, app) / jmx.filename
    content = await jmx.read()
    dest.write_bytes(content)

    scenario = Scenario(
        application_id=app_id,
        name=name,
        tag=_serialize_tags(tags),
        jmx_filename=jmx.filename,
        description=description,
        jmeter_properties_json=serialize_jmeter_properties(
            properties_from_form(property_names, property_values)
        ),
    )
    db.add(scenario)
    db.commit()
    db.refresh(scenario)

    if dependencies:
        await _save_scenario_files(db, scenario, release, build, app, dependencies, ScenarioFileKind.DEPENDENCY)

    return scenario


@router.get("/scenarios/{scenario_id}/files", response_model=list[ScenarioFileOut])
def list_scenario_files(scenario_id: int, db: Session = Depends(get_db)):
    return db.query(ScenarioFile).filter(ScenarioFile.scenario_id == scenario_id).all()


@router.post("/scenarios/{scenario_id}/files", response_model=list[ScenarioFileOut], status_code=201)
async def upload_scenario_files(
    scenario_id: int,
    kind: ScenarioFileKind = Form(ScenarioFileKind.DEPENDENCY),
    files: list[UploadFile] = File(...),
    db: Session = Depends(get_db),
):
    if not files:
        raise HTTPException(400, "At least one file is required")

    scenario = db.get(Scenario, scenario_id)
    if not scenario:
        raise HTTPException(404, "Scenario not found")
    app = db.get(Application, scenario.application_id)
    build = db.get(Build, app.build_id)
    release = db.get(Release, build.release_id)

    saved = await _save_scenario_files(db, scenario, release, build, app, files, kind)
    return saved
