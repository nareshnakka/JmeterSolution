"""Runtime system configuration stored in the database."""

from __future__ import annotations

from pathlib import Path

from sqlalchemy.orm import Session

from app.config import settings
from app.models import SystemConfig

DEFAULT_RESOURCE_SAMPLE_INTERVAL_SECONDS = 10
MIN_RESOURCE_SAMPLE_INTERVAL_SECONDS = 5
MAX_RESOURCE_SAMPLE_INTERVAL_SECONDS = 300

DEFAULT_LIVE_DASHBOARD_REFRESH_INTERVAL_SECONDS = 10
MIN_LIVE_DASHBOARD_REFRESH_INTERVAL_SECONDS = 5
MAX_LIVE_DASHBOARD_REFRESH_INTERVAL_SECONDS = 300


def normalize_resource_sample_interval(seconds: int) -> int:
    return max(MIN_RESOURCE_SAMPLE_INTERVAL_SECONDS, min(MAX_RESOURCE_SAMPLE_INTERVAL_SECONDS, seconds))


def normalize_live_dashboard_refresh_interval(seconds: int) -> int:
    return max(
        MIN_LIVE_DASHBOARD_REFRESH_INTERVAL_SECONDS,
        min(MAX_LIVE_DASHBOARD_REFRESH_INTERVAL_SECONDS, seconds),
    )


def apply_runtime_paths(jmeter_home: str, data_root: str) -> None:
    settings.jmeter_home = Path(jmeter_home)
    settings.data_root = Path(data_root)
    settings.data_root.mkdir(parents=True, exist_ok=True)


DEFAULT_AGGREGATE_TOTAL_AVG_TITLE = "Total Avg"
DEFAULT_AGGREGATE_LOAD_AVG_TITLE = "Load Avg"
DEFAULT_AGGREGATE_LOAD_AVG_FILTER = "_L_"
DEFAULT_AGGREGATE_SUBMIT_AVG_TITLE = "Submit Avg"
DEFAULT_AGGREGATE_SUBMIT_AVG_FILTER = "_S_"


def normalize_aggregate_title(title: str, *, fallback: str) -> str:
    trimmed = title.strip()
    return trimmed if trimmed else fallback


def normalize_aggregate_filter(value: str) -> str:
    return value.strip()


def normalize_aggregate_exclude_list(value: str) -> str:
    return value.strip()


def get_system_config(db: Session) -> SystemConfig:
    cfg = db.get(SystemConfig, 1)
    if cfg is None:
        cfg = SystemConfig(
            id=1,
            jmeter_home=str(settings.jmeter_home),
            data_root=str(settings.data_root),
            archive_retention_months=3,
            auto_archive_enabled=True,
            resource_sample_interval_seconds=DEFAULT_RESOURCE_SAMPLE_INTERVAL_SECONDS,
            live_dashboard_refresh_interval_seconds=DEFAULT_LIVE_DASHBOARD_REFRESH_INTERVAL_SECONDS,
            aggregate_total_avg_title=DEFAULT_AGGREGATE_TOTAL_AVG_TITLE,
            aggregate_total_avg_filter="",
            aggregate_total_avg_exclude="",
            aggregate_load_avg_title=DEFAULT_AGGREGATE_LOAD_AVG_TITLE,
            aggregate_load_avg_filter=DEFAULT_AGGREGATE_LOAD_AVG_FILTER,
            aggregate_submit_avg_title=DEFAULT_AGGREGATE_SUBMIT_AVG_TITLE,
            aggregate_submit_avg_filter=DEFAULT_AGGREGATE_SUBMIT_AVG_FILTER,
        )
        db.add(cfg)
        db.commit()
        db.refresh(cfg)
    apply_runtime_paths(cfg.jmeter_home, cfg.data_root)
    return cfg


def update_system_config(
    db: Session,
    *,
    jmeter_home: str,
    data_root: str,
    archive_retention_months: int,
    auto_archive_enabled: bool,
    resource_sample_interval_seconds: int,
    live_dashboard_refresh_interval_seconds: int,
    aggregate_total_avg_title: str,
    aggregate_total_avg_filter: str,
    aggregate_total_avg_exclude: str,
    aggregate_load_avg_title: str,
    aggregate_load_avg_filter: str,
    aggregate_submit_avg_title: str,
    aggregate_submit_avg_filter: str,
) -> SystemConfig:
    cfg = get_system_config(db)
    jmeter_path = Path(jmeter_home)
    data_path = Path(data_root)
    jmeter_changed = str(jmeter_path) != cfg.jmeter_home
    data_root_changed = str(data_path) != cfg.data_root

    if jmeter_changed:
        if not jmeter_path.is_dir():
            raise ValueError(f"JMeter home not found: {jmeter_home}")
        if not (jmeter_path / "bin" / "jmeter.bat").is_file():
            raise ValueError(f"jmeter.bat not found under {jmeter_home}\\bin")

    if data_root_changed:
        data_path.mkdir(parents=True, exist_ok=True)

    cfg = get_system_config(db)
    cfg.jmeter_home = str(jmeter_path)
    cfg.data_root = str(data_path)
    cfg.archive_retention_months = max(1, min(archive_retention_months, 120))
    cfg.auto_archive_enabled = auto_archive_enabled
    cfg.resource_sample_interval_seconds = normalize_resource_sample_interval(resource_sample_interval_seconds)
    cfg.live_dashboard_refresh_interval_seconds = normalize_live_dashboard_refresh_interval(
        live_dashboard_refresh_interval_seconds
    )
    cfg.aggregate_total_avg_title = normalize_aggregate_title(
        aggregate_total_avg_title,
        fallback=DEFAULT_AGGREGATE_TOTAL_AVG_TITLE,
    )
    cfg.aggregate_total_avg_filter = normalize_aggregate_filter(aggregate_total_avg_filter)
    cfg.aggregate_total_avg_exclude = normalize_aggregate_exclude_list(aggregate_total_avg_exclude)
    cfg.aggregate_load_avg_title = normalize_aggregate_title(
        aggregate_load_avg_title,
        fallback=DEFAULT_AGGREGATE_LOAD_AVG_TITLE,
    )
    cfg.aggregate_load_avg_filter = normalize_aggregate_filter(aggregate_load_avg_filter)
    cfg.aggregate_submit_avg_title = normalize_aggregate_title(
        aggregate_submit_avg_title,
        fallback=DEFAULT_AGGREGATE_SUBMIT_AVG_TITLE,
    )
    cfg.aggregate_submit_avg_filter = normalize_aggregate_filter(aggregate_submit_avg_filter)
    db.commit()
    db.refresh(cfg)
    apply_runtime_paths(cfg.jmeter_home, cfg.data_root)
    return cfg


def update_aggregate_summary_config(
    db: Session,
    *,
    aggregate_total_avg_title: str,
    aggregate_total_avg_filter: str,
    aggregate_total_avg_exclude: str,
    aggregate_load_avg_title: str,
    aggregate_load_avg_filter: str,
    aggregate_submit_avg_title: str,
    aggregate_submit_avg_filter: str,
) -> SystemConfig:
    cfg = get_system_config(db)
    cfg.aggregate_total_avg_title = normalize_aggregate_title(
        aggregate_total_avg_title,
        fallback=DEFAULT_AGGREGATE_TOTAL_AVG_TITLE,
    )
    cfg.aggregate_total_avg_filter = normalize_aggregate_filter(aggregate_total_avg_filter)
    cfg.aggregate_total_avg_exclude = normalize_aggregate_exclude_list(aggregate_total_avg_exclude)
    cfg.aggregate_load_avg_title = normalize_aggregate_title(
        aggregate_load_avg_title,
        fallback=DEFAULT_AGGREGATE_LOAD_AVG_TITLE,
    )
    cfg.aggregate_load_avg_filter = normalize_aggregate_filter(aggregate_load_avg_filter)
    cfg.aggregate_submit_avg_title = normalize_aggregate_title(
        aggregate_submit_avg_title,
        fallback=DEFAULT_AGGREGATE_SUBMIT_AVG_TITLE,
    )
    cfg.aggregate_submit_avg_filter = normalize_aggregate_filter(aggregate_submit_avg_filter)
    db.commit()
    db.refresh(cfg)
    return cfg


def archive_root() -> Path:
    return settings.data_root / "_archive" / "runs"


def seed_system_config(db: Session) -> None:
    get_system_config(db)
