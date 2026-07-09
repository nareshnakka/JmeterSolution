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
from app.services.jtl_parser import MetricsAggregator, parse_jtl_file
from app.scenario_properties import jmeter_cli_args, parse_jmeter_properties
from app.services.host_resources import (
    append_host_sample,
    load_host_resources,
    save_host_resources,
)
from app.services.system_config import get_system_config
from app.services.process_utils import (
    ensure_jmeter_stopped,
    is_process_alive,
    kill_process_tree,
    resolve_jmeter_pid,
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
        self._jmeter_pids: dict[int, int] = {}
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

    def is_tracked_run_active(self, run_id: int, pid: int | None) -> bool:
        proc = self._processes.get(run_id)
        if proc is not None and self._is_run_active(run_id, proc):
            return True
        return bool(pid and is_process_alive(pid))

    async def start_run(self, db: Session, test_run: TestRun) -> None:
        from app.services.run_queue import reconcile_stale_runs

        reconcile_stale_runs(db)
        other_running = (
            db.query(TestRun)
            .filter(TestRun.status == TestRunStatus.RUNNING, TestRun.id != test_run.id)
            .first()
        )
        if other_running:
            test_run.status = TestRunStatus.PENDING
            db.commit()
            return

        console_f = None
        try:
            get_system_config(db)

            scenario = db.get(Scenario, test_run.scenario_id)
            if not scenario:
                raise ValueError("Scenario not found")

            app = db.get(Application, scenario.application_id)
            if not app:
                raise ValueError("Application not found for scenario")
            build = db.get(Build, app.build_id)
            if not build:
                raise ValueError("Build not found for scenario")
            release = db.get(Release, build.release_id)
            if not release:
                raise ValueError("Release not found for scenario")

            if not settings.jmeter_bin.is_file():
                raise FileNotFoundError(f"JMeter not found at {settings.jmeter_bin}")

            run_path = test_run_dir(release, build, app, scenario, test_run.id)
            run_path.mkdir(parents=True, exist_ok=True)

            migrate_legacy_dependencies(release, build, app)

            jmx = resolve_scenario_jmx(release, build, app, scenario)
            if not jmx.exists():
                test_run.status = TestRunStatus.FAILED
                test_run.error_message = f"JMX not found: {jmx}"
                test_run.finished_at = datetime.utcnow()
                db.commit()
                from app.services.run_queue import process_run_queue

                await process_run_queue()
                return

            jtl = run_path / "results.jtl"
            log_file = run_path / "jmeter.log"
            console_log = run_path / "jmeter-console.log"
            scripts_dir = scenario_scripts_dir(release, build, app)

            test_run.run_dir = str(run_path)
            test_run.jtl_path = str(jtl)
            test_run.log_path = str(log_file)
            db.commit()

            cmd = [
                str(settings.jmeter_bin),
                "-n",
                "-t", str(jmx),
                "-l", str(jtl),
                "-j", str(log_file),
            ]
            cmd.extend(jmeter_cli_args(parse_jmeter_properties(scenario.jmeter_properties_json)))
            cmd.extend([
                "-Jjmeter.save.saveservice.output_format=csv",
                "-Jjmeter.save.saveservice.autoflush=true",
                "-Jjmeter.save.saveservice.response_data=true",
                "-Jjmeter.save.saveservice.response_data.on_error=true",
                "-Jjmeter.save.saveservice.response_data.max_size=1048576",
                "-Jjmeter.save.saveservice.responseHeaders=true",
                "-Jjmeter.save.saveservice.requestHeaders=true",
                "-Jjmeter.save.saveservice.assertion_results_failure_message=true",
                "-Jjmeter.save.saveservice.url=true",
                "-Jjmeter.save.saveservice.sample_type=true",
                "-Jjmeter.save.saveservice.subresults=false",
                f"-JRUN_DIR={run_path}",
                f"-JRUN_ID={test_run.id}",
                f"-JJTL_PATH={jtl}",
                f"-JJMETER_LOG={log_file}",
            ])

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
            await asyncio.sleep(0.75)
            jmeter_pid = resolve_jmeter_pid(proc.pid)
            self._jmeter_pids[test_run.id] = jmeter_pid

            started_at = datetime.utcnow()
            test_run.status = TestRunStatus.RUNNING
            test_run.started_at = started_at
            test_run.pid = jmeter_pid
            db.commit()

            agg = MetricsAggregator(
                test_run_id=test_run.id,
                bucket_seconds=settings.metrics_bucket_seconds,
            )
            self._aggregators[test_run.id] = agg

            loop = asyncio.get_event_loop()
            self._tail_tasks[test_run.id] = loop.create_task(
                self._tail_and_monitor(
                    test_run.id, jtl, proc, run_path, scripts_dir, started_at, console_f
                )
            )
            self._resource_tasks[test_run.id] = loop.create_task(
                self._sample_host_resources(test_run.id, run_path, started_at, proc)
            )
        except Exception as exc:
            if console_f:
                try:
                    console_f.close()
                except Exception:
                    pass
            test_run.status = TestRunStatus.FAILED
            test_run.error_message = str(exc)[:2000]
            test_run.finished_at = datetime.utcnow()
            db.commit()
            self.cleanup_run(test_run.id)
            from app.services.run_queue import process_run_queue

            await process_run_queue()

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
        interval = existing.get("interval_seconds")
        if not isinstance(interval, int) or interval <= 0:
            db = SessionLocal()
            try:
                interval = get_system_config(db).resource_sample_interval_seconds
            finally:
                db.close()

        loop = asyncio.get_event_loop()
        try:
            while self._is_run_active(run_id, proc):
                await loop.run_in_executor(
                    None, append_host_sample, run_path, started_at, samples, interval
                )
                await asyncio.sleep(interval)
        except asyncio.CancelledError:
            pass
        finally:
            if samples:
                save_host_resources(run_path, samples, interval)

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

        while self._is_run_active(run_id, proc):
            if jtl_path.exists():
                size = jtl_path.stat().st_size
                if size > last_size:
                    refreshed = parse_jtl_file(jtl_path)
                    refreshed.test_run_id = run_id
                    refreshed.status = agg.status
                    self._aggregators[run_id] = refreshed
                    agg = refreshed
                    last_size = size
            snap = agg.snapshot()
            await self.broadcast(run_id, {"type": "metrics", "data": snap.model_dump(mode="json")})
            await asyncio.sleep(1)

        # Final read
        if jtl_path.exists():
            refreshed = parse_jtl_file(jtl_path)
            refreshed.test_run_id = run_id
            refreshed.status = agg.status
            self._aggregators[run_id] = refreshed
            agg = refreshed

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

            scenario = db.get(Scenario, run.scenario_id)
            from app.services.app_notifications import notify_test_run_finished

            notify_test_run_finished(
                db,
                run_id=run.id,
                scenario_name=scenario.name if scenario else f"Run #{run.id}",
                status=run.status.value,
            )
        finally:
            db.close()

        snap = agg.snapshot()
        await self.broadcast(run_id, {"type": "metrics", "data": snap.model_dump(mode="json")})
        await self.broadcast(run_id, {"type": "finished", "data": {"status": agg.status.value}})

        from app.services.run_queue import process_run_queue
        from app.services.update_manager import update_manager

        await process_run_queue()
        db_after = SessionLocal()
        try:
            update_manager.try_apply_pending(db_after)
        finally:
            db_after.close()
        self._finalize_run_process(run_id)

    def _refresh_jmeter_pid(self, run_id: int, proc: subprocess.Popen) -> int | None:
        jmeter_pid = self._jmeter_pids.get(run_id)
        if jmeter_pid and is_process_alive(jmeter_pid):
            return jmeter_pid
        refreshed = resolve_jmeter_pid(proc.pid)
        if refreshed > 0:
            self._jmeter_pids[run_id] = refreshed
            return refreshed
        return jmeter_pid

    def _is_run_active(self, run_id: int, proc: subprocess.Popen) -> bool:
        jmeter_pid = self._refresh_jmeter_pid(run_id, proc)
        if jmeter_pid and is_process_alive(jmeter_pid):
            return True
        return proc.poll() is None

    def _finalize_run_process(self, run_id: int) -> None:
        """Ensure JMeter/Java is dead and drop process handles after a run ends."""
        proc = self._processes.pop(run_id, None)
        jmeter_pid = self._jmeter_pids.pop(run_id, None)
        root_pid = proc.pid if proc else 0
        if root_pid or jmeter_pid:
            ensure_jmeter_stopped(root_pid, jmeter_pid)

        resource_task = self._resource_tasks.pop(run_id, None)
        if resource_task and not resource_task.done():
            resource_task.cancel()

    def _force_stop_jmeter(self, run_id: int, fallback_pid: int | None = None) -> bool:
        proc = self._processes.get(run_id)
        jmeter_pid = self._jmeter_pids.get(run_id) or fallback_pid
        root_pid = proc.pid if proc else 0

        task = self._tail_tasks.get(run_id)
        if task and not task.done():
            task.cancel()

        if root_pid <= 0 and not jmeter_pid:
            return False

        if root_pid > 0:
            kill_process_tree(root_pid, force=True)
        if jmeter_pid and jmeter_pid != root_pid:
            kill_process_tree(jmeter_pid, force=True)
        ensure_jmeter_stopped(root_pid, jmeter_pid)

        if proc and proc.poll() is None:
            try:
                proc.kill()
                proc.wait(timeout=3)
            except (ProcessLookupError, subprocess.TimeoutExpired, OSError):
                pass

        agg = self._aggregators.get(run_id)
        if agg and agg.status == TestRunStatus.RUNNING:
            agg.status = TestRunStatus.CANCELLED

        self._processes.pop(run_id, None)
        self._jmeter_pids.pop(run_id, None)
        resource_task = self._resource_tasks.pop(run_id, None)
        if resource_task and not resource_task.done():
            resource_task.cancel()
        return True

    def cancel_run(self, run_id: int, fallback_pid: int | None = None) -> bool:
        return self._force_stop_jmeter(run_id, fallback_pid)

    def cleanup_run(self, run_id: int) -> None:
        """Stop process/tail task and drop in-memory state for a test run."""
        self._force_stop_jmeter(run_id)
        task = self._tail_tasks.pop(run_id, None)
        if task and not task.done():
            task.cancel()
        resource_task = self._resource_tasks.pop(run_id, None)
        if resource_task and not resource_task.done():
            resource_task.cancel()
        self._processes.pop(run_id, None)
        self._jmeter_pids.pop(run_id, None)
        self._aggregators.pop(run_id, None)
        self._ws_subscribers.pop(run_id, None)


run_manager = RunManager()
