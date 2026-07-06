"""Filesystem helpers for release/build/application/scenario layout."""

import re
import shutil
from datetime import datetime
from pathlib import Path

from app.config import settings
from app.models import Application, Build, Release, Scenario, ScenarioFileKind


def _safe_name(name: str) -> str:
    return re.sub(r'[<>:"/\\|?*]', "_", name.strip())


def release_dir(release: Release) -> Path:
    return settings.data_root / _safe_name(release.name)


def build_dir(release: Release, build: Build) -> Path:
    return release_dir(release) / _safe_name(build.name)


def application_dir(release: Release, build: Build, application: Application) -> Path:
    return build_dir(release, build) / _safe_name(application.name)


def scenario_scripts_dir(release: Release, build: Build, application: Application) -> Path:
    """JMX scripts and CSV dependencies share this folder so JMeter resolves relative paths."""
    return application_dir(release, build, application) / "scripts"


def scenario_dependencies_dir(release: Release, build: Build, application: Application) -> Path:
    """Dependencies are stored alongside JMX in scripts/."""
    return scenario_scripts_dir(release, build, application)


def scenario_uploads_dir(release: Release, build: Build, application: Application) -> Path:
    return application_dir(release, build, application) / "uploads"


def legacy_dependencies_dir(release: Release, build: Build, application: Application) -> Path:
    return application_dir(release, build, application) / "dependencies"


def resolve_scenario_file_path(
    release: Release,
    build: Build,
    application: Application,
    filename: str,
    kind: ScenarioFileKind,
) -> Path:
    if kind == ScenarioFileKind.DEPENDENCY:
        scripts_path = scenario_scripts_dir(release, build, application) / filename
        if scripts_path.is_file():
            return scripts_path
        legacy_path = legacy_dependencies_dir(release, build, application) / filename
        return legacy_path
    return scenario_uploads_dir(release, build, application) / filename


def scenario_dir(release: Release, build: Build, application: Application, scenario: Scenario) -> Path:
    """Per-scenario folder under the application."""
    label = f"{scenario.id}-{_safe_name(scenario.name)}"
    return application_dir(release, build, application) / "scenarios" / label


def test_run_dir(
    release: Release,
    build: Build,
    application: Application,
    scenario: Scenario,
    run_id: int,
) -> Path:
    """Each test run stores all artifacts under its scenario: .../scenarios/{id-name}/runs/{run_id}/"""
    return scenario_dir(release, build, application, scenario) / "runs" / str(run_id)


def collect_run_artifacts(run_path: Path, scan_dirs: list[Path], started_at: datetime) -> list[str]:
    """Move JTL and log files created during a run into the run folder."""
    run_path.mkdir(parents=True, exist_ok=True)
    cutoff = started_at.timestamp() - 2
    collected: list[str] = []
    run_resolved = run_path.resolve()

    for scan_dir in scan_dirs:
        if not scan_dir.is_dir():
            continue
        for item in scan_dir.iterdir():
            if not item.is_file():
                continue
            if item.suffix.lower() not in (".jtl", ".log"):
                continue
            try:
                if item.resolve().parent == run_resolved:
                    continue
                if item.stat().st_mtime < cutoff:
                    continue
            except OSError:
                continue

            dest = run_path / item.name
            if dest.exists():
                stamp = int(item.stat().st_mtime)
                dest = run_path / f"{item.stem}_{stamp}{item.suffix}"
            shutil.move(str(item), str(dest))
            collected.append(dest.name)

    return collected


def ensure_application_dirs(release: Release, build: Build, application: Application) -> None:
    for d in (
        scenario_scripts_dir(release, build, application),
        scenario_uploads_dir(release, build, application),
    ):
        d.mkdir(parents=True, exist_ok=True)


def resolve_scenario_jmx(release: Release, build: Build, application: Application, scenario: Scenario) -> Path:
    return scenario_scripts_dir(release, build, application) / scenario.jmx_filename


def migrate_legacy_dependencies(release: Release, build: Build, application: Application) -> None:
    """Copy CSV files from legacy dependencies/ into scripts/ if needed."""
    legacy = legacy_dependencies_dir(release, build, application)
    if not legacy.is_dir():
        return
    scripts = scenario_scripts_dir(release, build, application)
    scripts.mkdir(parents=True, exist_ok=True)
    for item in legacy.iterdir():
        if item.is_file():
            target = scripts / item.name
            if not target.exists():
                shutil.copy2(item, target)
