"""System configuration and archive management."""

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models import TestRun
from app.schemas import (
    ArchiveActionOut,
    ArchiveActionRequest,
    ArchiveRunItem,
    AutoArchiveOut,
    SystemConfigOut,
    SystemConfigUpdate,
    TestRunDeleteFailure,
)
from app.services.archive import archive_test_run, auto_archive_old_runs, restore_test_run
from app.services.system_config import get_system_config, update_system_config
from app.routers.test_runs import _enrich_run

router = APIRouter(prefix="/api/config", tags=["config"])


def _to_config_out(cfg) -> SystemConfigOut:
    jmeter_path = Path(cfg.jmeter_home)
    return SystemConfigOut(
        jmeter_home=cfg.jmeter_home,
        data_root=cfg.data_root,
        archive_retention_months=cfg.archive_retention_months,
        auto_archive_enabled=cfg.auto_archive_enabled,
        jmeter_found=(jmeter_path / "bin" / "jmeter.bat").is_file(),
        updated_at=cfg.updated_at,
    )


@router.get("", response_model=SystemConfigOut)
def read_config(db: Session = Depends(get_db)):
    cfg = get_system_config(db)
    return _to_config_out(cfg)


@router.put("", response_model=SystemConfigOut)
def save_config(body: SystemConfigUpdate, db: Session = Depends(get_db)):
    try:
        cfg = update_system_config(
            db,
            jmeter_home=body.jmeter_home,
            data_root=body.data_root,
            archive_retention_months=body.archive_retention_months,
            auto_archive_enabled=body.auto_archive_enabled,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return _to_config_out(cfg)


@router.get("/archive-runs", response_model=list[ArchiveRunItem])
def list_archive_runs(
    archived_only: bool = False,
    include_archived: bool = True,
    db: Session = Depends(get_db),
):
    q = db.query(TestRun).order_by(TestRun.finished_at.desc().nullslast(), TestRun.created_at.desc())
    if archived_only:
        q = q.filter(TestRun.is_archived.is_(True))
    elif not include_archived:
        q = q.filter(TestRun.is_archived.is_(False))

    items: list[ArchiveRunItem] = []
    for run in q.limit(500).all():
        enriched = _enrich_run(run, db)
        items.append(
            ArchiveRunItem(
                id=run.id,
                scenario_name=enriched.scenario_name,
                release_name=enriched.release_name,
                build_name=enriched.build_name,
                application_name=enriched.application_name,
                status=run.status,
                finished_at=run.finished_at,
                is_archived=run.is_archived,
                archived_at=run.archived_at,
                run_dir=run.run_dir,
            )
        )
    return items


@router.post("/archive", response_model=ArchiveActionOut)
def archive_runs(body: ArchiveActionRequest, db: Session = Depends(get_db)):
    succeeded: list[int] = []
    failed: list[TestRunDeleteFailure] = []

    for run_id in body.test_run_ids:
        run = db.get(TestRun, run_id)
        if not run:
            failed.append(TestRunDeleteFailure(id=run_id, error="Test run not found"))
            continue
        try:
            archive_test_run(db, run)
            succeeded.append(run_id)
        except Exception as exc:
            failed.append(TestRunDeleteFailure(id=run_id, error=str(exc)))

    db.commit()
    return ArchiveActionOut(succeeded=succeeded, failed=failed)


@router.post("/restore", response_model=ArchiveActionOut)
def restore_runs(body: ArchiveActionRequest, db: Session = Depends(get_db)):
    succeeded: list[int] = []
    failed: list[TestRunDeleteFailure] = []

    for run_id in body.test_run_ids:
        run = db.get(TestRun, run_id)
        if not run:
            failed.append(TestRunDeleteFailure(id=run_id, error="Test run not found"))
            continue
        try:
            restore_test_run(db, run)
            succeeded.append(run_id)
        except Exception as exc:
            failed.append(TestRunDeleteFailure(id=run_id, error=str(exc)))

    db.commit()
    return ArchiveActionOut(succeeded=succeeded, failed=failed)


@router.post("/auto-archive", response_model=AutoArchiveOut)
def run_auto_archive(db: Session = Depends(get_db)):
    cfg = get_system_config(db)
    archived = auto_archive_old_runs(db)
    return AutoArchiveOut(archived=archived, retention_months=cfg.archive_retention_months)
