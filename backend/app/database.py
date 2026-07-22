"""SQLAlchemy database setup."""

from __future__ import annotations

import logging

from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from app.config import settings
from app.db_paths import resolve_database_url

logger = logging.getLogger(__name__)

_resolved_url = resolve_database_url(settings.database_url, data_root=settings.data_root)
if _resolved_url != settings.database_url:
    logger.info("Resolved database URL to %s", _resolved_url)
    settings.database_url = _resolved_url

_is_sqlite = settings.database_url.startswith("sqlite")
connect_args: dict = {}
if _is_sqlite:
    # check_same_thread=False: FastAPI/thread pool may share connections.
    # timeout: wait up to 30s on write locks instead of failing immediately.
    connect_args = {"check_same_thread": False, "timeout": 30.0}

engine = create_engine(
    settings.database_url,
    connect_args=connect_args,
    pool_pre_ping=True,
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


if _is_sqlite:

    @event.listens_for(engine, "connect")
    def _sqlite_on_connect(dbapi_connection, _connection_record) -> None:  # noqa: ANN001
        cursor = dbapi_connection.cursor()
        # Safe performance PRAGMAs — do not rewrite or delete application data.
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA busy_timeout=30000")
        cursor.execute("PRAGMA temp_store=MEMORY")
        cursor.execute("PRAGMA cache_size=-65536")  # ~64 MiB page cache
        cursor.execute("PRAGMA mmap_size=268435456")  # 256 MiB mmap when supported
        cursor.close()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# Indexes for hot filter/order paths. CREATE INDEX IF NOT EXISTS is additive and safe.
_SQLITE_INDEXES = (
    "CREATE INDEX IF NOT EXISTS ix_test_runs_status ON test_runs (status)",
    "CREATE INDEX IF NOT EXISTS ix_test_runs_scenario_id ON test_runs (scenario_id)",
    "CREATE INDEX IF NOT EXISTS ix_test_runs_created_at ON test_runs (created_at)",
    "CREATE INDEX IF NOT EXISTS ix_test_runs_finished_at ON test_runs (finished_at)",
    "CREATE INDEX IF NOT EXISTS ix_test_runs_is_archived ON test_runs (is_archived)",
    "CREATE INDEX IF NOT EXISTS ix_test_runs_status_created ON test_runs (status, created_at)",
    "CREATE INDEX IF NOT EXISTS ix_builds_release_id ON builds (release_id)",
    "CREATE INDEX IF NOT EXISTS ix_applications_build_id ON applications (build_id)",
    "CREATE INDEX IF NOT EXISTS ix_scenarios_application_id ON scenarios (application_id)",
    "CREATE INDEX IF NOT EXISTS ix_scenario_files_scenario_id ON scenario_files (scenario_id)",
    "CREATE INDEX IF NOT EXISTS ix_scenario_schedules_scenario_id ON scenario_schedules (scenario_id)",
    "CREATE INDEX IF NOT EXISTS ix_scenario_schedules_active_next ON scenario_schedules (is_active, next_run_at)",
)


def _ensure_performance_indexes() -> None:
    if not _is_sqlite:
        return
    with engine.begin() as conn:
        for stmt in _SQLITE_INDEXES:
            conn.execute(text(stmt))
        # Refresh planner stats (no data changes).
        conn.execute(text("ANALYZE"))
    logger.info("SQLite performance indexes verified")


def _migrate_schema() -> None:
    """Additive-only SQLite migrations. Never drops tables or rewrites existing rows."""
    from sqlalchemy import inspect

    insp = inspect(engine)
    if "test_runs" in insp.get_table_names():
        cols = {c["name"] for c in insp.get_columns("test_runs")}
        alters: list[str] = []
        if "is_archived" not in cols:
            alters.append("ALTER TABLE test_runs ADD COLUMN is_archived BOOLEAN NOT NULL DEFAULT 0")
        if "archived_at" not in cols:
            alters.append("ALTER TABLE test_runs ADD COLUMN archived_at DATETIME")
        if "pre_archive_run_dir" not in cols:
            alters.append("ALTER TABLE test_runs ADD COLUMN pre_archive_run_dir VARCHAR(1024)")
        if "consider_for_release" not in cols:
            alters.append(
                "ALTER TABLE test_runs ADD COLUMN consider_for_release BOOLEAN NOT NULL DEFAULT 0"
            )
        if alters:
            with engine.begin() as conn:
                for stmt in alters:
                    conn.execute(text(stmt))
                    logger.info("Applied schema migration: %s", stmt)

    if "system_config" in insp.get_table_names():
        cfg_cols = {c["name"] for c in insp.get_columns("system_config")}
        if "resource_sample_interval_seconds" not in cfg_cols:
            with engine.begin() as conn:
                conn.execute(
                    text(
                        "ALTER TABLE system_config "
                        "ADD COLUMN resource_sample_interval_seconds INTEGER NOT NULL DEFAULT 10"
                    )
                )
        if "live_dashboard_refresh_interval_seconds" not in cfg_cols:
            with engine.begin() as conn:
                conn.execute(
                    text(
                        "ALTER TABLE system_config "
                        "ADD COLUMN live_dashboard_refresh_interval_seconds INTEGER NOT NULL DEFAULT 10"
                    )
                )
        # Re-read columns after prior ALTERs in this process
        cfg_cols = {c["name"] for c in inspect(engine).get_columns("system_config")}
        aggregate_columns = {
            "aggregate_total_avg_title": "VARCHAR(128) NOT NULL DEFAULT 'Total Avg'",
            "aggregate_total_avg_filter": "VARCHAR(256) NOT NULL DEFAULT ''",
            "aggregate_total_avg_exclude": "VARCHAR(2048) NOT NULL DEFAULT ''",
            "aggregate_load_avg_title": "VARCHAR(128) NOT NULL DEFAULT 'Load Avg'",
            "aggregate_load_avg_filter": "VARCHAR(256) NOT NULL DEFAULT '_L_'",
            "aggregate_submit_avg_title": "VARCHAR(128) NOT NULL DEFAULT 'Submit Avg'",
            "aggregate_submit_avg_filter": "VARCHAR(256) NOT NULL DEFAULT '_S_'",
        }
        for col_name, col_def in aggregate_columns.items():
            if col_name not in cfg_cols:
                with engine.begin() as conn:
                    conn.execute(text(f"ALTER TABLE system_config ADD COLUMN {col_name} {col_def}"))
                    logger.info("Added system_config.%s", col_name)

        cfg_cols = {c["name"] for c in inspect(engine).get_columns("system_config")}
        if "azure_monitor_enabled" not in cfg_cols:
            with engine.begin() as conn:
                conn.execute(
                    text(
                        "ALTER TABLE system_config "
                        "ADD COLUMN azure_monitor_enabled BOOLEAN NOT NULL DEFAULT 0"
                    )
                )
                logger.info("Added system_config.azure_monitor_enabled")
        if "azure_monitor_targets_json" not in cfg_cols:
            with engine.begin() as conn:
                conn.execute(
                    text(
                        "ALTER TABLE system_config "
                        "ADD COLUMN azure_monitor_targets_json TEXT NOT NULL DEFAULT '[]'"
                    )
                )
                logger.info("Added system_config.azure_monitor_targets_json")

    if "scenarios" in insp.get_table_names():
        scenario_cols = {c["name"] for c in insp.get_columns("scenarios")}
        if "jmeter_properties" not in scenario_cols:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE scenarios ADD COLUMN jmeter_properties TEXT"))


def init_db():
    """Create missing tables and apply additive migrations. Never wipes existing data."""
    from app import models  # noqa: F401
    from app.services.system_config import seed_system_config

    Base.metadata.create_all(bind=engine)
    _migrate_schema()
    _ensure_performance_indexes()

    db = SessionLocal()
    try:
        seed_system_config(db)
    finally:
        db.close()
