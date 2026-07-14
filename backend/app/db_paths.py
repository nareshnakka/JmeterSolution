"""Resolve a stable absolute SQLite path so updates / cwd changes never open a new empty DB."""

from __future__ import annotations

import logging
import shutil
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

_BACKEND_DIR = Path(__file__).resolve().parent.parent
_PROJECT_ROOT = _BACKEND_DIR.parent
_DEFAULT_DB_NAME = "jmeter_agent.db"


def backend_dir() -> Path:
    return _BACKEND_DIR


def project_root() -> Path:
    return _PROJECT_ROOT


def default_database_path() -> Path:
    """Canonical DB location — always absolute under backend/."""
    return (_BACKEND_DIR / _DEFAULT_DB_NAME).resolve()


def _sqlite_path_from_url(url: str) -> Path | None:
    if not url.startswith("sqlite:///"):
        return None
    raw = url[len("sqlite:///"):]
    # sqlite:////abs (4 slashes) → /abs on Unix; SQLAlchemy uses sqlite:///C:/... on Windows
    if raw.startswith("/") and not (len(raw) > 2 and raw[2] == ":"):
        # May be ////unc or //absolute — strip extra slash if present as ////path
        return Path(raw)
    return Path(raw)


def _is_absolute_sqlite_path(path: Path) -> bool:
    return path.is_absolute() or (len(str(path)) > 1 and str(path)[1] == ":")


def _table_count(db_path: Path, table: str) -> int:
    try:
        if not db_path.is_file() or db_path.stat().st_size == 0:
            return -1
        uri = db_path.resolve().as_uri() + "?mode=ro"
        conn = sqlite3.connect(uri, uri=True)
        try:
            row = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
                (table,),
            ).fetchone()
            if not row:
                return 0
            return int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
        finally:
            conn.close()
    except Exception:
        return -1


def _quarantine_empty_db(path: Path) -> None:
    """Rename empty / schema-less accidental DB files so they cannot be opened again."""
    if not path.is_file():
        return
    if path.resolve() == default_database_path():
        return
    tables = _table_count(path, "test_runs")
    if path.stat().st_size == 0 or tables <= 0:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        dest = path.with_name(f"{path.name}.empty-quarantine-{stamp}")
        try:
            path.rename(dest)
            logger.warning("Quarantined empty accidental database %s -> %s", path, dest)
        except OSError as exc:
            logger.warning("Could not quarantine empty database %s: %s", path, exc)


def resolve_database_url(configured_url: str, *, data_root: Path | None = None) -> str:
    """
    Resolve DATABASE_URL to an absolute sqlite URL.

    Relative paths are always anchored to backend/ so starting the server from a
    different working directory (or during updates) cannot create a second empty DB.
    """
    if not configured_url.startswith("sqlite"):
        return configured_url

    path = _sqlite_path_from_url(configured_url)
    if path is None:
        return configured_url

    if not _is_absolute_sqlite_path(path):
        path = (default_database_path().parent / path.name).resolve()
    else:
        path = path.resolve()

    # Prefer the existing DB that already holds test run history.
    candidates = [path, default_database_path()]
    if data_root is not None:
        candidates.append((Path(data_root) / _DEFAULT_DB_NAME).resolve())

    scored: list[tuple[int, Path]] = []
    seen: set[Path] = set()
    for candidate in candidates:
        if candidate in seen:
            continue
        seen.add(candidate)
        score = _table_count(candidate, "test_runs")
        if score >= 0:
            scored.append((score, candidate))

    if scored:
        scored.sort(key=lambda item: (item[0], item[1] == default_database_path()), reverse=True)
        best_score, best_path = scored[0]
        if best_score > 0 and best_path != path and _table_count(path, "test_runs") <= 0:
            logger.warning(
                "Using existing database with %s test run(s) at %s "
                "(configured path %s was empty or missing)",
                best_score,
                best_path,
                path,
            )
            path = best_path

    # Quarantine known accidental empty copies under data/
    if data_root is not None:
        _quarantine_empty_db((Path(data_root) / _DEFAULT_DB_NAME).resolve())

    path.parent.mkdir(parents=True, exist_ok=True)
    # SQLAlchemy Windows absolute: sqlite:///C:/path/to.db
    return f"sqlite:///{path.as_posix()}"


def backup_databases(backup_root: Path | None = None) -> Path:
    """Copy live SQLite files (and WAL/SHM) into a timestamped backup folder."""
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    root = backup_root or (_PROJECT_ROOT / "data" / "_db_backups" / stamp)
    root.mkdir(parents=True, exist_ok=True)

    sources = [
        default_database_path(),
        _PROJECT_ROOT / "data" / _DEFAULT_DB_NAME,
    ]
    copied = 0
    for src in sources:
        if not src.is_file() or src.stat().st_size == 0:
            continue
        for suffix in ("", "-wal", "-shm"):
            file_path = Path(str(src) + suffix) if suffix else src
            if file_path.is_file():
                dest = root / file_path.name
                shutil.copy2(file_path, dest)
                copied += 1
                logger.info("Backed up %s -> %s", file_path, dest)

    marker = root / "README.txt"
    marker.write_text(
        "JMeter Agent database backup created before an update.\n"
        "Restore by stopping the server and copying jmeter_agent.db back to backend\\.\n",
        encoding="utf-8",
    )
    if copied == 0:
        logger.warning("No database files found to back up into %s", root)
    return root


def checkpoint_sqlite(db_path: Path | None = None) -> None:
    """Flush WAL into the main DB file when possible (best-effort before updates)."""
    path = db_path or default_database_path()
    if not path.is_file():
        return
    try:
        conn = sqlite3.connect(str(path), timeout=5)
        try:
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            conn.commit()
        finally:
            conn.close()
    except sqlite3.Error as exc:
        logger.warning("SQLite checkpoint skipped for %s: %s", path, exc)
