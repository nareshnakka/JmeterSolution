"""WebSocket endpoint for live test metrics."""

import asyncio

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.database import SessionLocal
from app.models import TestRun
from app.routers.test_runs import _metrics_snapshot_for_run
from app.services.jmeter_runner import run_manager

router = APIRouter(tags=["websocket"])


@router.websocket("/ws/test-runs/{run_id}")
async def test_run_ws(websocket: WebSocket, run_id: int):
    await websocket.accept()
    run_manager.subscribe(run_id, websocket)

    async def push_metrics() -> None:
        db = SessionLocal()
        try:
            run = db.get(TestRun, run_id)
            if not run:
                return
            data = _metrics_snapshot_for_run(run)
            await websocket.send_json({"type": "metrics", "data": data})
        except Exception:
            pass
        finally:
            db.close()

    await push_metrics()

    try:
        while True:
            try:
                msg = await asyncio.wait_for(websocket.receive_json(), timeout=30.0)
                if msg.get("type") == "graph":
                    agg = run_manager.get_aggregator(run_id)
                    if agg:
                        labels = msg.get("labels", [])
                        cumulative = msg.get("cumulative", False)
                        data = agg.label_graph(labels=labels, cumulative=cumulative)
                        await websocket.send_json({"type": "graph", "data": data})
            except asyncio.TimeoutError:
                # Keepalive — client may only listen for server pushes
                continue
    except WebSocketDisconnect:
        pass
    finally:
        run_manager.unsubscribe(run_id, websocket)
