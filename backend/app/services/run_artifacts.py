"""Resolve test run artifact paths for folders and zip archives."""

from __future__ import annotations

import shutil
import zipfile
from pathlib import Path

from app.models import TestRun
from app.services.system_config import archive_root

ARCHIVE_ZIP_SUFFIX = ".zip"
COMMON_JTL = "results.jtl"
COMMON_ERROR_TRACE_JTL = "errors-trace.jtl"
COMMON_LOG = "jmeter.log"


def archive_zip_path(run_id: int) -> Path:
    return archive_root() / f"{run_id}{ARCHIVE_ZIP_SUFFIX}"


def extract_cache_dir(run_id: int) -> Path:
    return archive_root() / ".extracted" / str(run_id)


def is_zip_archive(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() == ARCHIVE_ZIP_SUFFIX


def zip_directory(src_dir: Path, zip_path: Path) -> None:
    if not src_dir.is_dir():
        raise ValueError(f"Cannot zip missing directory: {src_dir}")
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    if zip_path.exists():
        zip_path.unlink()
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for file in sorted(src_dir.rglob("*")):
            if file.is_file():
                zf.write(file, file.relative_to(src_dir).as_posix())


def extract_zip(zip_path: Path, dest_dir: Path) -> None:
    if not zip_path.is_file():
        raise ValueError(f"Archive not found: {zip_path}")
    if dest_dir.exists():
        shutil.rmtree(dest_dir)
    dest_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path, "r") as zf:
        zf.extractall(dest_dir)


def clear_extract_cache(run_id: int) -> None:
    cache = extract_cache_dir(run_id)
    if cache.exists():
        shutil.rmtree(cache, ignore_errors=True)


def _cache_marker(cache_dir: Path) -> Path:
    return cache_dir / ".source"


def _cache_is_valid(zip_path: Path, cache_dir: Path) -> bool:
    marker = _cache_marker(cache_dir)
    if not cache_dir.is_dir() or not marker.is_file():
        return False
    try:
        stat = zip_path.stat()
        return marker.read_text(encoding="utf-8").strip() == f"{stat.st_mtime_ns}:{stat.st_size}"
    except OSError:
        return False


def _write_cache_marker(zip_path: Path, cache_dir: Path) -> None:
    stat = zip_path.stat()
    cache_dir.mkdir(parents=True, exist_ok=True)
    _cache_marker(cache_dir).write_text(f"{stat.st_mtime_ns}:{stat.st_size}", encoding="utf-8")


def ensure_run_directory(run: TestRun) -> Path | None:
    """Return a directory containing run artifacts, extracting zip archives on demand."""
    if not run.run_dir:
        return None

    root = Path(run.run_dir)
    if root.is_dir():
        return root
    if is_zip_archive(root):
        cache = extract_cache_dir(run.id)
        if not _cache_is_valid(root, cache):
            clear_extract_cache(run.id)
            extract_zip(root, cache)
            _write_cache_marker(root, cache)
        return cache
    if root.is_file():
        return None
    return None


def resolve_run_file(run: TestRun, relative_path: str) -> Path | None:
    run_dir = ensure_run_directory(run)
    if not run_dir:
        return None
    target = (run_dir / relative_path).resolve()
    run_root = run_dir.resolve()
    if not str(target).startswith(str(run_root)) or not target.is_file():
        return None
    return target


def resolve_jtl_path(run: TestRun) -> Path | None:
    if run.jtl_path:
        jtl = Path(run.jtl_path)
        if jtl.is_file():
            return jtl
    return resolve_run_file(run, COMMON_JTL)


def resolve_errors_trace_jtl_path(run: TestRun) -> Path | None:
    return resolve_run_file(run, COMMON_ERROR_TRACE_JTL)


def resolve_log_path(run: TestRun) -> Path | None:
    if run.log_path:
        log = Path(run.log_path)
        if log.is_file():
            return log
    return resolve_run_file(run, COMMON_LOG)


def list_run_files(run: TestRun) -> list[tuple[str, int]]:
    """Return (relative_path, size_bytes) for files in the run artifact tree."""
    run_dir = ensure_run_directory(run)
    if not run_dir:
        return []
    items: list[tuple[str, int]] = []
    for path in sorted(run_dir.rglob("*")):
        if path.is_file() and path.name != ".source":
            rel = path.relative_to(run_dir).as_posix()
            items.append((rel, path.stat().st_size))
    return items


def remove_run_artifacts(run: TestRun) -> None:
    """Delete on-disk artifacts for a test run (folder, zip, and extract cache)."""
    clear_extract_cache(run.id)
    if not run.run_dir:
        return
    root = Path(run.run_dir)
    if is_zip_archive(root):
        root.unlink(missing_ok=True)
    elif root.is_dir():
        shutil.rmtree(root, ignore_errors=True)
    legacy_zip = archive_zip_path(run.id)
    if legacy_zip.is_file() and legacy_zip != root:
        legacy_zip.unlink(missing_ok=True)


def update_run_paths_for_directory(run: TestRun, directory: Path) -> None:
    run.run_dir = str(directory)
    jtl = directory / COMMON_JTL
    log = directory / COMMON_LOG
    run.jtl_path = str(jtl) if jtl.is_file() else None
    run.log_path = str(log) if log.is_file() else None
