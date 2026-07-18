"""JMeter Agent Server — FastAPI application entry point."""

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.staticfiles import StaticFiles

from app.config import settings
from app.database import SessionLocal, init_db
from app.services.system_config import get_system_config
from app.services.run_queue import reconcile_stale_runs, process_run_queue
from app.services.jmeter_runner import run_manager
from app.routers import bug_reports, config, hierarchy, notifications, test_runs, websocket
from app.services.scheduler import shutdown_scheduler, start_scheduler
from app.services.update_manager import update_manager
from app.logging_setup import setup_logging
from app.version import version_full, version_label

_frontend_dist = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"


class SPAStaticFiles(StaticFiles):
    """Serve static assets and fall back to index.html for client-side routes."""

    async def get_response(self, path: str, scope):
        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            if exc.status_code == 404 and not path.startswith("api"):
                index = Path(self.directory) / "index.html"
                if index.is_file():
                    return FileResponse(index)
            raise


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging()
    init_db()
    db = SessionLocal()
    resumed_runs: list[int] = []
    try:
        get_system_config(db)
        # Resume live JMeter processes that survived a server update/restart first,
        # then mark only truly dead RUNNING rows as failed.
        resumed_runs = await run_manager.reattach_running_runs()
        reconcile_stale_runs(db)
        if resumed_runs:
            from app.services.app_notifications import create_notification

            for run_id in resumed_runs:
                create_notification(
                    db,
                    kind="run_resumed",
                    title="Test resumed after update",
                    message=(
                        f"Live monitoring reconnected for run #{run_id}. "
                        "Open the Live Dashboard to continue watching — JMeter kept running."
                    ),
                    payload={"run_id": run_id},
                    dedupe_key=f"run_resumed:{run_id}",
                )
    finally:
        db.close()
    await process_run_queue()
    start_scheduler()
    db2 = SessionLocal()
    try:
        update_manager.check_for_updates(db2, notify=True)
        # Successful boot after update — clear install marker (do not re-run the same update).
        from app.services.update_manager import clear_pending_update_marker

        clear_pending_update_marker()
    finally:
        db2.close()
    await update_manager.start_background_checks()
    yield
    update_manager.stop_background_checks()
    shutdown_scheduler()


app = FastAPI(title="JMeter Agent Server", version=version_full(), lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(hierarchy.router)
app.include_router(test_runs.router)
app.include_router(config.router)
app.include_router(notifications.router)
app.include_router(bug_reports.router)
app.include_router(websocket.router)


@app.get("/api/health")
def health():
    db = SessionLocal()
    try:
        cfg = get_system_config(db)
        jmeter_path = Path(cfg.jmeter_home)
        jmeter_ok = (jmeter_path / "bin" / "jmeter.bat").is_file()
        return {
            "status": "ok" if jmeter_ok else "degraded",
            "version": version_label(),
            "jmeter_home": cfg.jmeter_home,
            "jmeter_found": jmeter_ok,
            "data_root": cfg.data_root,
        }
    finally:
        db.close()


# SPA client-side routes (must be registered before static mount)
if _frontend_dist.is_dir():
    @app.get("/live/{run_id}")
    @app.get("/runs")
    @app.get("/scenarios")
    @app.get("/compare")
    @app.get("/config")
    async def spa_routes():
        return FileResponse(_frontend_dist / "index.html")

    app.mount("/", SPAStaticFiles(directory=str(_frontend_dist), html=True), name="frontend")
