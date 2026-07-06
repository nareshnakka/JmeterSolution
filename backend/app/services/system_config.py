"""Runtime system configuration stored in the database."""

from __future__ import annotations

from pathlib import Path

from sqlalchemy.orm import Session

from app.config import settings
from app.models import SystemConfig


def apply_runtime_paths(jmeter_home: str, data_root: str) -> None:
    settings.jmeter_home = Path(jmeter_home)
    settings.data_root = Path(data_root)
    settings.data_root.mkdir(parents=True, exist_ok=True)


def get_system_config(db: Session) -> SystemConfig:
    cfg = db.get(SystemConfig, 1)
    if cfg is None:
        cfg = SystemConfig(
            id=1,
            jmeter_home=str(settings.jmeter_home),
            data_root=str(settings.data_root),
            archive_retention_months=3,
            auto_archive_enabled=True,
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
) -> SystemConfig:
    jmeter_path = Path(jmeter_home)
    data_path = Path(data_root)
    if not jmeter_path.is_dir():
        raise ValueError(f"JMeter home not found: {jmeter_home}")
    if not (jmeter_path / "bin" / "jmeter.bat").is_file():
        raise ValueError(f"jmeter.bat not found under {jmeter_home}\\bin")

    data_path.mkdir(parents=True, exist_ok=True)

    cfg = get_system_config(db)
    cfg.jmeter_home = str(jmeter_path)
    cfg.data_root = str(data_path)
    cfg.archive_retention_months = max(1, min(archive_retention_months, 120))
    cfg.auto_archive_enabled = auto_archive_enabled
    db.commit()
    db.refresh(cfg)
    apply_runtime_paths(cfg.jmeter_home, cfg.data_root)
    return cfg


def archive_root() -> Path:
    return settings.data_root / "_archive" / "runs"


def seed_system_config(db: Session) -> None:
    get_system_config(db)
