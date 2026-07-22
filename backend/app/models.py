"""SQLAlchemy ORM models."""

import enum
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class TestRunStatus(str, enum.Enum):
    PENDING = "pending"
    SCHEDULED = "scheduled"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class TestRunType(str, enum.Enum):
    ADHOC = "adhoc"
    SCHEDULED = "scheduled"


class ScheduleFrequency(str, enum.Enum):
    ONCE = "once"
    DAILY = "daily"
    WEEKLY = "weekly"


class Release(Base):
    __tablename__ = "releases"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    builds: Mapped[list["Build"]] = relationship(back_populates="release", cascade="all, delete-orphan")


class Build(Base):
    __tablename__ = "builds"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    release_id: Mapped[int] = mapped_column(ForeignKey("releases.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    release: Mapped["Release"] = relationship(back_populates="builds")
    applications: Mapped[list["Application"]] = relationship(back_populates="build", cascade="all, delete-orphan")


class Application(Base):
    __tablename__ = "applications"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    build_id: Mapped[int] = mapped_column(ForeignKey("builds.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    app_type: Mapped[str | None] = mapped_column(String(64))
    description: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    build: Mapped["Build"] = relationship(back_populates="applications")
    scenarios: Mapped[list["Scenario"]] = relationship(back_populates="application", cascade="all, delete-orphan")


class Scenario(Base):
    __tablename__ = "scenarios"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    application_id: Mapped[int] = mapped_column(ForeignKey("applications.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    tag: Mapped[str | None] = mapped_column(String(128))
    jmx_filename: Mapped[str] = mapped_column(String(512), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    jmeter_properties_json: Mapped[str | None] = mapped_column("jmeter_properties", Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    application: Mapped["Application"] = relationship(back_populates="scenarios")
    files: Mapped[list["ScenarioFile"]] = relationship(back_populates="scenario", cascade="all, delete-orphan")
    test_runs: Mapped[list["TestRun"]] = relationship(back_populates="scenario")
    schedules: Mapped[list["ScenarioSchedule"]] = relationship(back_populates="scenario", cascade="all, delete-orphan")


class ScenarioSchedule(Base):
    __tablename__ = "scenario_schedules"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    scenario_id: Mapped[int] = mapped_column(ForeignKey("scenarios.id"), nullable=False)
    frequency: Mapped[ScheduleFrequency] = mapped_column(Enum(ScheduleFrequency), nullable=False)
    run_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    days_of_week: Mapped[str | None] = mapped_column(String(64))
    next_run_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    scenario: Mapped["Scenario"] = relationship(back_populates="schedules")


class ScenarioFileKind(str, enum.Enum):
    DEPENDENCY = "dependency"
    UPLOAD = "upload"


class ScenarioFile(Base):
    __tablename__ = "scenario_files"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    scenario_id: Mapped[int] = mapped_column(ForeignKey("scenarios.id"), nullable=False)
    filename: Mapped[str] = mapped_column(String(512), nullable=False)
    kind: Mapped[ScenarioFileKind] = mapped_column(Enum(ScenarioFileKind), default=ScenarioFileKind.DEPENDENCY)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    scenario: Mapped["Scenario"] = relationship(back_populates="files")


class SystemConfig(Base):
    __tablename__ = "system_config"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    jmeter_home: Mapped[str] = mapped_column(String(1024), nullable=False)
    data_root: Mapped[str] = mapped_column(String(1024), nullable=False)
    archive_retention_months: Mapped[int] = mapped_column(Integer, default=3, nullable=False)
    auto_archive_enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    resource_sample_interval_seconds: Mapped[int] = mapped_column(Integer, default=10, nullable=False)
    live_dashboard_refresh_interval_seconds: Mapped[int] = mapped_column(Integer, default=10, nullable=False)
    aggregate_total_avg_title: Mapped[str] = mapped_column(String(128), default="Total Avg", nullable=False)
    aggregate_total_avg_filter: Mapped[str] = mapped_column(String(256), default="", nullable=False)
    aggregate_total_avg_exclude: Mapped[str] = mapped_column(String(2048), default="", nullable=False)
    aggregate_load_avg_title: Mapped[str] = mapped_column(String(128), default="Load Avg", nullable=False)
    aggregate_load_avg_filter: Mapped[str] = mapped_column(String(256), default="_L_", nullable=False)
    aggregate_submit_avg_title: Mapped[str] = mapped_column(String(128), default="Submit Avg", nullable=False)
    aggregate_submit_avg_filter: Mapped[str] = mapped_column(String(256), default="_S_", nullable=False)
    azure_monitor_enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    azure_monitor_targets_json: Mapped[str] = mapped_column(Text, default="[]", nullable=False)
    azure_monitor_sample_interval_seconds: Mapped[int] = mapped_column(Integer, default=10, nullable=False)
    azure_monitor_resource_group: Mapped[str] = mapped_column(String(256), default="", nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class TestRun(Base):
    __tablename__ = "test_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    scenario_id: Mapped[int] = mapped_column(ForeignKey("scenarios.id"), nullable=False)
    run_type: Mapped[TestRunType] = mapped_column(Enum(TestRunType), default=TestRunType.ADHOC)
    status: Mapped[TestRunStatus] = mapped_column(Enum(TestRunStatus), default=TestRunStatus.PENDING)
    scheduled_at: Mapped[datetime | None] = mapped_column(DateTime)
    started_at: Mapped[datetime | None] = mapped_column(DateTime)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime)
    run_dir: Mapped[str | None] = mapped_column(String(1024))
    jtl_path: Mapped[str | None] = mapped_column(String(1024))
    log_path: Mapped[str | None] = mapped_column(String(1024))
    pid: Mapped[int | None] = mapped_column(Integer)
    error_message: Mapped[str | None] = mapped_column(Text)
    notes: Mapped[str | None] = mapped_column(Text)
    is_archived: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime)
    pre_archive_run_dir: Mapped[str | None] = mapped_column(String(1024))
    consider_for_release: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    scenario: Mapped["Scenario"] = relationship(back_populates="test_runs")


class AppNotification(Base):
    __tablename__ = "app_notifications"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    kind: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    payload_json: Mapped[str | None] = mapped_column(Text)
    dedupe_key: Mapped[str | None] = mapped_column(String(128), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), index=True)
