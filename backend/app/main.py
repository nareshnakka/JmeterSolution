"""JMeter Agent Server — FastAPI application entry point."""

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.staticfiles import StaticFiles

from app.config import settings
from app.database import init_db
from app.routers import hierarchy, test_runs, websocket
from app.services.scheduler import shutdown_scheduler, start_scheduler

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
    init_db()
    start_scheduler()
    yield
    shutdown_scheduler()


app = FastAPI(title="JMeter Agent Server", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(hierarchy.router)
app.include_router(test_runs.router)
app.include_router(websocket.router)


@app.get("/api/health")
def health():
    jmeter_ok = settings.jmeter_bin.exists()
    return {
        "status": "ok" if jmeter_ok else "degraded",
        "jmeter_home": str(settings.jmeter_home),
        "jmeter_found": jmeter_ok,
        "data_root": str(settings.data_root),
    }


# SPA client-side routes (must be registered before static mount)
if _frontend_dist.is_dir():
    @app.get("/live/{run_id}")
    @app.get("/runs")
    @app.get("/scenarios")
    @app.get("/compare")
    async def spa_routes():
        return FileResponse(_frontend_dist / "index.html")

    app.mount("/", SPAStaticFiles(directory=str(_frontend_dist), html=True), name="frontend")
