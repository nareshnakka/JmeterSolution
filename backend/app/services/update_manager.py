"""Check GitHub for updates and apply them when safe."""

from __future__ import annotations

import asyncio
import json
import subprocess
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from app.models import TestRun, TestRunStatus
from app.services.app_notifications import create_notification
from app.services.run_queue import has_active_run
from app.version import load_version, version_label

GITHUB_REPO = "nareshnakka/JmeterSolution"
GITHUB_BRANCH = "main"
REMOTE_VERSION_URL = f"https://raw.githubusercontent.com/{GITHUB_REPO}/{GITHUB_BRANCH}/version.json"

_ROOT = Path(__file__).resolve().parent.parent.parent.parent
_UPDATE_BAT = _ROOT / "scripts" / "update-services.bat"
_PENDING_FILE = _ROOT / "data" / "_pending_update.json"
_CREATE_NO_WINDOW = subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0
_DETACHED_PROCESS = 0x00000008


def _version_tuple(data: dict[str, Any]) -> tuple[int, int, int]:
    return (int(data.get("major", 0)), int(data.get("minor", 0)), int(data.get("patch", 0)))


def fetch_remote_version() -> dict[str, Any] | None:
    try:
        request = urllib.request.Request(
            REMOTE_VERSION_URL,
            headers={"User-Agent": "JMeterAgent-Server"},
        )
        with urllib.request.urlopen(request, timeout=15) as response:
            data = json.loads(response.read().decode("utf-8"))
            return data if isinstance(data, dict) else None
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError):
        return None


def compare_update(local: dict[str, Any], remote: dict[str, Any]) -> bool:
    return _version_tuple(remote) > _version_tuple(local)


def _running_run_ids(db: Session) -> list[int]:
    rows = (
        db.query(TestRun.id)
        .filter(TestRun.status.in_([TestRunStatus.RUNNING, TestRunStatus.PENDING]))
        .order_by(TestRun.id.asc())
        .all()
    )
    return [row[0] for row in rows]


def _write_pending_state(version: str, resume_run_ids: list[int]) -> None:
    _PENDING_FILE.parent.mkdir(parents=True, exist_ok=True)
    _PENDING_FILE.write_text(
        json.dumps(
            {
                "version": version,
                "resume_run_ids": resume_run_ids,
            },
            indent=2,
        ),
        encoding="utf-8",
    )


def _read_pending_state() -> dict[str, Any] | None:
    if not _PENDING_FILE.is_file():
        return None
    try:
        data = json.loads(_PENDING_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def _clear_pending_state() -> None:
    try:
        if _PENDING_FILE.is_file():
            _PENDING_FILE.unlink()
    except OSError:
        pass


def clear_pending_update_marker() -> None:
    """Call after a successful server boot so the same update is not re-applied."""
    _clear_pending_state()


class UpdateManager:
    def __init__(self) -> None:
        self._pending_version: str | None = None
        self._update_started = False
        self._background_task: asyncio.Task | None = None
        pending = _read_pending_state()
        if pending and pending.get("version"):
            self._pending_version = str(pending["version"])

    @property
    def pending_version(self) -> str | None:
        return self._pending_version

    @property
    def update_started(self) -> bool:
        return self._update_started

    def is_repo_available(self) -> bool:
        return (_ROOT / ".git").is_dir() and _UPDATE_BAT.is_file()

    def tests_blocking_update(self, db: Session) -> bool:
        return has_active_run(db)

    def check_for_updates(self, db: Session, *, notify: bool = True) -> dict[str, Any]:
        local = load_version()
        current_label = version_label()
        remote = fetch_remote_version()
        if not remote:
            return {
                "current_version": current_label,
                "latest_version": None,
                "update_available": False,
                "remote_commit": None,
                "repo_available": self.is_repo_available(),
            }

        latest_label = f"v{remote['major']}.{remote['minor']}.{remote['patch']}"
        available = compare_update(local, remote)
        remote_commit = str(remote.get("lastCommit") or "")[:12] or None

        if available and notify:
            create_notification(
                db,
                kind="update_available",
                title="Update available",
                message=f"Version {latest_label} is available on GitHub (current: {current_label}).",
                payload={
                    "current_version": current_label,
                    "latest_version": latest_label,
                    "remote_commit": remote_commit,
                },
                dedupe_key=f"update_available:{latest_label}",
            )

        return {
            "current_version": current_label,
            "latest_version": latest_label,
            "update_available": available,
            "remote_commit": remote_commit,
            "repo_available": self.is_repo_available(),
            "pending_version": self._pending_version,
            "update_started": self._update_started,
        }

    def schedule_or_apply(self, db: Session, *, latest_version: str | None = None) -> dict[str, str]:
        if self._update_started:
            return {
                "status": "already_running",
                "message": "An update is already in progress. The server will restart shortly.",
            }

        if not self.is_repo_available():
            return {
                "status": "unavailable",
                "message": "This installation is not a git repository. Update manually with git pull.",
            }

        check = self.check_for_updates(db, notify=False)
        if not check.get("update_available"):
            self._pending_version = None
            _clear_pending_state()
            return {
                "status": "unavailable",
                "message": "You are already on the latest version.",
            }

        target_version = latest_version or str(check.get("latest_version") or "")
        resume_run_ids = _running_run_ids(db)
        running = bool(resume_run_ids)

        # Always install now. JMeter is detached from the API process, so an
        # in-progress test keeps generating JTL data; the restarted server
        # reattaches monitoring and the Live Dashboard can reopen the same run.
        self._pending_version = None
        self._spawn_update(db, target_version, resume_run_ids=resume_run_ids)
        if running:
            return {
                "status": "started",
                "message": (
                    f"Installing {target_version}. Running test(s) "
                    f"{', '.join(f'#{i}' for i in resume_run_ids)} will continue without interruption. "
                    "After the brief UI restart, reopen the Live Dashboard for the same run."
                ),
            }
        return {
            "status": "started",
            "message": f"Installing {target_version}. The server will restart in a moment.",
        }

    def try_apply_pending(self, db: Session) -> bool:
        if self._update_started:
            return False
        pending = _read_pending_state()
        version = self._pending_version or (str(pending["version"]) if pending and pending.get("version") else None)
        if not version:
            return False
        # Pending from a previous defer (older builds) — apply when idle only.
        if self.tests_blocking_update(db):
            return False
        self._pending_version = None
        resume_ids = list(pending.get("resume_run_ids") or []) if pending else []
        self._spawn_update(db, version, resume_run_ids=resume_ids)
        return True

    def _spawn_update(self, db: Session, version: str, *, resume_run_ids: list[int] | None = None) -> None:
        self._update_started = True
        resume_run_ids = resume_run_ids or []
        _write_pending_state(version, resume_run_ids)
        message = f"Installing {version} from GitHub. Services will restart shortly."
        if resume_run_ids:
            message = (
                f"Installing {version}. Running test(s) "
                f"{', '.join(f'#{i}' for i in resume_run_ids)} stay active; "
                "Live Dashboard reconnects after restart."
            )
        create_notification(
            db,
            kind="update_started",
            title="Update started",
            message=message,
            payload={
                "latest_version": version,
                "resume_run_ids": resume_run_ids,
            },
            dedupe_key=f"update_started:{version}",
        )
        subprocess.Popen(
            ["cmd", "/c", str(_UPDATE_BAT)],
            cwd=str(_ROOT),
            creationflags=_DETACHED_PROCESS | _CREATE_NO_WINDOW,
            close_fds=True,
        )

    async def start_background_checks(self, interval_seconds: int = 300) -> None:
        if self._background_task and not self._background_task.done():
            return

        async def _loop() -> None:
            from app.database import SessionLocal

            while True:
                await asyncio.sleep(interval_seconds)
                db = SessionLocal()
                try:
                    self.check_for_updates(db, notify=True)
                    # Prefer idle apply for any leftover deferred state file.
                    self.try_apply_pending(db)
                finally:
                    db.close()

        self._background_task = asyncio.create_task(_loop())

    def stop_background_checks(self) -> None:
        if self._background_task and not self._background_task.done():
            self._background_task.cancel()
            self._background_task = None


update_manager = UpdateManager()
