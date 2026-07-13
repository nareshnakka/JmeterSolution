"""SQLAlchemy database setup."""

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from app.config import settings

connect_args = {"check_same_thread": False} if settings.database_url.startswith("sqlite") else {}
engine = create_engine(settings.database_url, connect_args=connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _migrate_schema() -> None:
    """Lightweight SQLite migrations for columns added after first release."""
    from sqlalchemy import inspect, text

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

    if "scenarios" in insp.get_table_names():
        scenario_cols = {c["name"] for c in insp.get_columns("scenarios")}
        if "jmeter_properties" not in scenario_cols:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE scenarios ADD COLUMN jmeter_properties TEXT"))


def init_db():
    from app import models  # noqa: F401
    from app.services.system_config import seed_system_config

    Base.metadata.create_all(bind=engine)
    _migrate_schema()

    db = SessionLocal()
    try:
        seed_system_config(db)
    finally:
        db.close()
