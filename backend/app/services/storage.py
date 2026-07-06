"""Filesystem helpers for release/build/application/scenario layout."""

import re
import shutil
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


def test_run_dir(release: Release, build: Build, application: Application, run_id: int) -> Path:
    return application_dir(release, build, application) / "runs" / str(run_id)


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
