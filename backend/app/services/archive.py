"""Archive and restore test run result folders as zip files to save disk space."""

from __future__ import annotations

import shutil
from datetime import datetime, timedelta
from pathlib import Path

from sqlalchemy.orm import Session

from app.models import Application, Build, Release, Scenario, SystemConfig, TestRun, TestRunStatus
from app.services.run_artifacts import (
    archive_zip_path,
    clear_extract_cache,
    extract_zip,
    is_zip_archive,
    remove_run_artifacts,
    update_run_paths_for_directory,
    zip_directory,
)
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


def _compress_run_folder(src: Path, run_id: int) -> Path:
    zip_path = archive_zip_path(run_id)
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    zip_directory(src, zip_path)
    shutil.rmtree(src)
    return zip_path


def _upgrade_legacy_archive(run: TestRun) -> None:
    """Convert an older folder-based archive to a zip file."""
    root = Path(run.run_dir) if run.run_dir else None
    if root is None or is_zip_archive(root):
        return
    if not root.is_dir():
        return
    zip_path = _compress_run_folder(root, run.id)
    run.run_dir = str(zip_path)
    run.jtl_path = None
    run.log_path = None


def archive_test_run(db: Session, run: TestRun) -> None:
    if run.is_archived:
        _upgrade_legacy_archive(run)
        return
    if run.status in _ACTIVE:
        raise ValueError(f"Run #{run.id} is active and cannot be archived")

    src = Path(run.run_dir) if run.run_dir else None
    if src is None or not src.exists():
        run.is_archived = True
        run.archived_at = datetime.utcnow()
        return

    if is_zip_archive(src):
        run.is_archived = True
        run.archived_at = datetime.utcnow()
        return

    run.pre_archive_run_dir = str(src)
    archive_root().mkdir(parents=True, exist_ok=True)

    if src.is_dir():
        zip_path = _compress_run_folder(src, run.id)
    else:
        raise ValueError(f"Run #{run.id} artifacts are not a directory: {src}")

    clear_extract_cache(run.id)
    run.run_dir = str(zip_path)
    run.jtl_path = None
    run.log_path = None
    run.is_archived = True
    run.archived_at = datetime.utcnow()


def restore_test_run(db: Session, run: TestRun) -> None:
    if not run.is_archived:
        return

    release, build, app = _resolve_hierarchy(db, run)
    scenario = db.get(Scenario, run.scenario_id)
    if not scenario:
        raise ValueError(f"Scenario not found for run #{run.id}")
    target = test_run_dir(release, build, app, scenario, run.id)
    target.parent.mkdir(parents=True, exist_ok=True)

    src = Path(run.run_dir) if run.run_dir else None
    if src is None or not src.exists():
        run.is_archived = False
        run.archived_at = None
        run.pre_archive_run_dir = None
        update_run_paths_for_directory(run, target)
        return

    if target.exists():
        shutil.rmtree(target)

    if is_zip_archive(src):
        extract_zip(src, target)
        src.unlink(missing_ok=True)
        clear_extract_cache(run.id)
    elif src.is_dir():
        shutil.move(str(src), str(target))
    else:
        raise ValueError(f"Run #{run.id} archive format is not supported: {src}")

    update_run_paths_for_directory(run, target)
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
