"""Runtime system configuration stored in the database."""

from __future__ import annotations

import json
from pathlib import Path

from sqlalchemy.orm import Session

from app.config import settings
from app.models import SystemConfig
from app.services.azure_monitor import parse_azure_targets

DEFAULT_RESOURCE_SAMPLE_INTERVAL_SECONDS = 10
MIN_RESOURCE_SAMPLE_INTERVAL_SECONDS = 5
MAX_RESOURCE_SAMPLE_INTERVAL_SECONDS = 300

DEFAULT_LIVE_DASHBOARD_REFRESH_INTERVAL_SECONDS = 10
MIN_LIVE_DASHBOARD_REFRESH_INTERVAL_SECONDS = 5
MAX_LIVE_DASHBOARD_REFRESH_INTERVAL_SECONDS = 300

DEFAULT_AZURE_MONITOR_TARGETS = [
    {"name": "PQSQCSQL2016N01", "resource_id": ""},
    {"name": "PQSQCVAL2022N01", "resource_id": ""},
    {"name": "PQSQCVAL2016N03", "resource_id": ""},
]
DEFAULT_AZURE_MONITOR_TARGETS_JSON = json.dumps(DEFAULT_AZURE_MONITOR_TARGETS, indent=2)

DEFAULT_AGGREGATE_TOTAL_AVG_TITLE = "Total Avg"
DEFAULT_AGGREGATE_LOAD_AVG_TITLE = "Load Avg"
DEFAULT_AGGREGATE_LOAD_AVG_FILTER = "_L_"
DEFAULT_AGGREGATE_SUBMIT_AVG_TITLE = "Submit Avg"
DEFAULT_AGGREGATE_SUBMIT_AVG_FILTER = "_S_"


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


def normalize_aggregate_title(title: str, *, fallback: str) -> str:
    trimmed = title.strip()
    return trimmed if trimmed else fallback


def normalize_aggregate_filter(value: str) -> str:
    return value.strip()


def normalize_aggregate_exclude_list(value: str) -> str:
    return value.strip()


def normalize_azure_targets_for_storage(targets: list[dict[str, str]] | None) -> str:
    cleaned: list[dict[str, str]] = []
    for item in targets or []:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        resource_id = str(item.get("resource_id") or "").strip()
        if name:
            cleaned.append({"name": name, "resource_id": resource_id})
    return json.dumps(cleaned, indent=2)


def list_azure_targets_from_config(cfg: SystemConfig) -> list[dict[str, str]]:
    raw = getattr(cfg, "azure_monitor_targets_json", None) or "[]"
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return list(DEFAULT_AZURE_MONITOR_TARGETS)
    if not isinstance(data, list):
        return list(DEFAULT_AZURE_MONITOR_TARGETS)
    out: list[dict[str, str]] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        resource_id = str(item.get("resource_id") or "").strip()
        if name:
            out.append({"name": name, "resource_id": resource_id})
    return out or list(DEFAULT_AZURE_MONITOR_TARGETS)


def get_enabled_azure_targets(cfg: SystemConfig) -> list[dict[str, str]]:
    """Targets ready to sample (enabled + non-empty resource_id)."""
    if not getattr(cfg, "azure_monitor_enabled", False):
        return []
    return [t for t in parse_azure_targets(getattr(cfg, "azure_monitor_targets_json", "[]")) if t.get("resource_id")]


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
            azure_monitor_enabled=False,
            azure_monitor_targets_json=DEFAULT_AZURE_MONITOR_TARGETS_JSON,
            azure_monitor_sample_interval_seconds=10,
            azure_monitor_resource_group="",
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
    azure_monitor_enabled: bool = False,
    azure_monitor_targets: list[dict[str, str]] | None = None,
    azure_monitor_sample_interval_seconds: int = 10,
    azure_monitor_resource_group: str = "",
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
    cfg.azure_monitor_enabled = bool(azure_monitor_enabled)
    if azure_monitor_targets is not None:
        # Auto-fill blank resource IDs from subscription (.env) + default resource group.
        from app.config import settings as app_settings
        from app.services.azure_monitor import fill_missing_resource_ids

        filled = fill_missing_resource_ids(
            azure_monitor_targets,
            subscription_id=app_settings.azure_subscription_id,
            resource_group=azure_monitor_resource_group
            or getattr(cfg, "azure_monitor_resource_group", ""),
        )
        cfg.azure_monitor_targets_json = normalize_azure_targets_for_storage(filled)
    cfg.azure_monitor_sample_interval_seconds = max(10, min(300, int(azure_monitor_sample_interval_seconds or 10)))
    cfg.azure_monitor_resource_group = (azure_monitor_resource_group or "").strip()
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
