"""Run JMeter in non-GUI mode and tail JTL for live metrics."""

from __future__ import annotations

import asyncio
import subprocess
import threading
from collections import defaultdict
from datetime import datetime
from pathlib import Path

from sqlalchemy.orm import Session

from app.config import settings
from app.database import SessionLocal
from app.models import Application, Build, Release, Scenario, TestRun, TestRunStatus
from app.services.jtl_parser import MetricsAggregator
from app.services.host_resources import (
    SAMPLE_INTERVAL_SECONDS,
    append_host_sample,
    load_host_resources,
    save_host_resources,
)
from app.services.storage import (
    collect_run_artifacts,
    migrate_legacy_dependencies,
    resolve_scenario_jmx,
    scenario_scripts_dir,
    test_run_dir,
)


class RunManager:
    """Singleton managing active test runs and live aggregators."""

    def __init__(self) -> None:
        self._aggregators: dict[int, MetricsAggregator] = {}
        self._processes: dict[int, subprocess.Popen] = {}
        self._tail_tasks: dict[int, asyncio.Task] = {}
        self._resource_tasks: dict[int, asyncio.Task] = {}
        self._ws_subscribers: dict[int, set] = defaultdict(set)
        self._lock = threading.Lock()

    def get_aggregator(self, run_id: int) -> MetricsAggregator | None:
        return self._aggregators.get(run_id)

    def subscribe(self, run_id: int, ws) -> None:
        self._ws_subscribers[run_id].add(ws)

    def unsubscribe(self, run_id: int, ws) -> None:
        self._ws_subscribers[run_id].discard(ws)

    async def broadcast(self, run_id: int, message: dict) -> None:
        dead = []
        for ws in list(self._ws_subscribers.get(run_id, set())):
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.unsubscribe(run_id, ws)

    async def start_run(self, db: Session, test_run: TestRun) -> None:
        other_running = (
            db.query(TestRun)
            .filter(TestRun.status == TestRunStatus.RUNNING, TestRun.id != test_run.id)
            .first()
        )
        if other_running:
            test_run.status = TestRunStatus.PENDING
            db.commit()
            return

        scenario = db.get(Scenario, test_run.scenario_id)
        if not scenario:
            raise ValueError("Scenario not found")

        app = db.get(Application, scenario.application_id)
        build = db.get(Build, app.build_id)
        release = db.get(Release, build.release_id)

        run_path = test_run_dir(release, build, app, scenario, test_run.id)
        run_path.mkdir(parents=True, exist_ok=True)

        migrate_legacy_dependencies(release, build, app)

        jmx = resolve_scenario_jmx(release, build, app, scenario)
        if not jmx.exists():
            test_run.status = TestRunStatus.FAILED
            test_run.error_message = f"JMX not found: {jmx}"
            db.commit()
            return

        jtl = run_path / "results.jtl"
        log_file = run_path / "jmeter.log"
        console_log = run_path / "jmeter-console.log"
        scripts_dir = scenario_scripts_dir(release, build, app)
        started_at = datetime.utcnow()

        test_run.run_dir = str(run_path)
        test_run.jtl_path = str(jtl)
        test_run.log_path = str(log_file)
        test_run.status = TestRunStatus.RUNNING
        test_run.started_at = started_at
        db.commit()

        agg = MetricsAggregator(
            test_run_id=test_run.id,
            bucket_seconds=settings.metrics_bucket_seconds,
        )
        self._aggregators[test_run.id] = agg

        cmd = [
            str(settings.jmeter_bin),
            "-n",
            "-t", str(jmx),
            "-l", str(jtl),
            "-j", str(log_file),
            "-Jjmeter.save.saveservice.output_format=csv",
            "-Jjmeter.save.saveservice.autoflush=true",
            f"-JRUN_DIR={run_path}",
            f"-JRUN_ID={test_run.id}",
            f"-JJTL_PATH={jtl}",
            f"-JJMETER_LOG={log_file}",
        ]

        # Run from the scripts folder — JMX and CSV dependencies live together
        cwd = scripts_dir

        console_f = open(console_log, "w", encoding="utf-8", errors="replace")
        proc = subprocess.Popen(
            cmd,
            cwd=str(cwd),
            stdout=console_f,
            stderr=subprocess.STDOUT,
            creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0,
        )
        self._processes[test_run.id] = proc
        test_run.pid = proc.pid
        db.commit()

        loop = asyncio.get_event_loop()
        self._tail_tasks[test_run.id] = loop.create_task(
            self._tail_and_monitor(
                test_run.id, jtl, proc, run_path, scripts_dir, started_at, console_f
            )
        )
        self._resource_tasks[test_run.id] = loop.create_task(
            self._sample_host_resources(test_run.id, run_path, started_at, proc)
        )

    async def _sample_host_resources(
        self,
        run_id: int,
        run_path: Path,
        started_at: datetime,
        proc: subprocess.Popen,
    ) -> None:
        samples: list[dict] = []
        existing = load_host_resources(run_path)
        if isinstance(existing.get("samples"), list):
            samples = list(existing["samples"])

        loop = asyncio.get_event_loop()
        try:
            while proc.poll() is None:
                await loop.run_in_executor(
                    None, append_host_sample, run_path, started_at, samples
                )
                await asyncio.sleep(SAMPLE_INTERVAL_SECONDS)
        except asyncio.CancelledError:
            pass
        finally:
            if samples:
                save_host_resources(run_path, samples)

    async def _tail_and_monitor(
        self,
        run_id: int,
        jtl_path: Path,
        proc: subprocess.Popen,
        run_path: Path,
        scripts_dir: Path,
        started_at: datetime,
        console_f,
    ) -> None:
        agg = self._aggregators[run_id]
        last_size = 0

        while proc.poll() is None:
            if jtl_path.exists():
                size = jtl_path.stat().st_size
                if size > last_size:
                    with open(jtl_path, encoding="utf-8", errors="replace") as f:
                        f.seek(last_size)
                        for line in f:
                            agg.ingest_line(line)
                    last_size = size
            snap = agg.snapshot()
            await self.broadcast(run_id, {"type": "metrics", "data": snap.model_dump(mode="json")})
            await asyncio.sleep(1)

        # Final read
        if jtl_path.exists():
            with open(jtl_path, encoding="utf-8", errors="replace") as f:
                f.seek(last_size)
                for line in f:
                    agg.ingest_line(line)

        exit_code = proc.returncode
        try:
            console_f.close()
        except Exception:
            pass

        collected = collect_run_artifacts(run_path, [scripts_dir, scripts_dir.parent], started_at)

        db = SessionLocal()
        try:
            run = db.get(TestRun, run_id)
            if not run:
                return
            run.finished_at = datetime.utcnow()
            if collected:
                note = f"Collected artifacts: {', '.join(collected)}"
                run.notes = f"{run.notes}\n{note}".strip() if run.notes else note
            if run.status == TestRunStatus.CANCELLED:
                agg.status = TestRunStatus.CANCELLED
            elif exit_code == 0:
                run.status = TestRunStatus.COMPLETED
                agg.status = TestRunStatus.COMPLETED
            else:
                run.status = TestRunStatus.FAILED
                run.error_message = f"JMeter exited with code {exit_code}"
                agg.status = TestRunStatus.FAILED
            db.commit()
        finally:
            db.close()

        snap = agg.snapshot()
        await self.broadcast(run_id, {"type": "metrics", "data": snap.model_dump(mode="json")})
        await self.broadcast(run_id, {"type": "finished", "data": {"status": agg.status.value}})

        from app.services.run_queue import process_run_queue

        await process_run_queue()

    def cancel_run(self, run_id: int) -> bool:
        proc = self._processes.get(run_id)
        if proc and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=3)
            agg = self._aggregators.get(run_id)
            if agg:
                agg.status = TestRunStatus.CANCELLED
            return True
        return False

    def cleanup_run(self, run_id: int) -> None:
        """Stop process/tail task and drop in-memory state for a test run."""
        self.cancel_run(run_id)
        task = self._tail_tasks.pop(run_id, None)
        if task and not task.done():
            task.cancel()
        resource_task = self._resource_tasks.pop(run_id, None)
        if resource_task and not resource_task.done():
            resource_task.cancel()
        self._aggregators.pop(run_id, None)
        self._processes.pop(run_id, None)
        self._ws_subscribers.pop(run_id, None)


run_manager = RunManager()
