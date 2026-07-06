"""Archive and restore test run result folders."""

from __future__ import annotations

import shutil
from datetime import datetime, timedelta
from pathlib import Path

from sqlalchemy.orm import Session

from app.models import Application, Build, Release, Scenario, SystemConfig, TestRun, TestRunStatus
from app.services.storage import test_run_dir
from app.services.system_config import archive_root, get_system_config


_ARCHIVABLE = (
    TestRunStatus.COMPLETED,
    TestRunStatus.FAILED,
    TestRunStatus.CANCELLED,
)

_ACTIVE = (
    TestRunStatus.RUNNING,
    TestRunStatus.PENDING,
    TestRunStatus.SCHEDULED,
)


def _resolve_hierarchy(db: Session, run: TestRun) -> tuple[Release, Build, Application]:
    scenario = db.get(Scenario, run.scenario_id)
    if not scenario:
        raise ValueError(f"Scenario not found for run #{run.id}")
    app = db.get(Application, scenario.application_id)
    if not app:
        raise ValueError(f"Application not found for run #{run.id}")
    build = db.get(Build, app.build_id)
    if not build:
        raise ValueError(f"Build not found for run #{run.id}")
    release = db.get(Release, build.release_id)
    if not release:
        raise ValueError(f"Release not found for run #{run.id}")
    return release, build, app


def archive_test_run(db: Session, run: TestRun) -> None:
    if run.is_archived:
        return
    if run.status in _ACTIVE:
        raise ValueError(f"Run #{run.id} is active and cannot be archived")

    src = Path(run.run_dir) if run.run_dir else None
    if src is None or not src.exists():
        run.is_archived = True
        run.archived_at = datetime.utcnow()
        return

    dest = archive_root() / str(run.id)
    if dest.exists():
        shutil.rmtree(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)

    run.pre_archive_run_dir = str(src)
    shutil.move(str(src), str(dest))

    run.run_dir = str(dest)
    run.jtl_path = str(dest / "results.jtl") if (dest / "results.jtl").exists() else run.jtl_path
    run.log_path = str(dest / "jmeter.log") if (dest / "jmeter.log").exists() else run.log_path
    run.is_archived = True
    run.archived_at = datetime.utcnow()


def restore_test_run(db: Session, run: TestRun) -> None:
    if not run.is_archived:
        return

    release, build, app = _resolve_hierarchy(db, run)
    target = test_run_dir(release, build, app, run.id)
    target.parent.mkdir(parents=True, exist_ok=True)

    src = Path(run.run_dir) if run.run_dir else None
    if src is None or not src.exists():
        run.is_archived = False
        run.archived_at = None
        run.run_dir = str(target)
        return

    if target.exists():
        shutil.rmtree(target)

    shutil.move(str(src), str(target))

    run.run_dir = str(target)
    run.jtl_path = str(target / "results.jtl") if (target / "results.jtl").exists() else None
    run.log_path = str(target / "jmeter.log") if (target / "jmeter.log").exists() else None
    run.is_archived = False
    run.archived_at = None
    run.pre_archive_run_dir = None


def auto_archive_old_runs(db: Session) -> list[int]:
    cfg = db.get(SystemConfig, 1)
    if cfg is None or not cfg.auto_archive_enabled:
        return []

    cutoff = datetime.utcnow() - timedelta(days=cfg.archive_retention_months * 30)
    runs = (
        db.query(TestRun)
        .filter(
            TestRun.is_archived.is_(False),
            TestRun.status.in_(_ARCHIVABLE),
            TestRun.finished_at.isnot(None),
            TestRun.finished_at < cutoff,
        )
        .all()
    )

    archived_ids: list[int] = []
    for run in runs:
        try:
            archive_test_run(db, run)
            archived_ids.append(run.id)
        except Exception:
            continue

    if archived_ids:
        db.commit()
    return archived_ids
