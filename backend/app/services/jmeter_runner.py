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
from app.services.app_notifications import notify_host_resource_alert
from app.services.host_resource_alerts import (
    CPU_DURATION_SECONDS,
    HostResourceAlertState,
    MEMORY_DURATION_SECONDS,
    evaluate_host_resource_alerts,
)
from app.services.jtl_parser import MetricsAggregator, append_jtl_file, parse_jtl_file
from app.scenario_properties import jmeter_cli_args, parse_jmeter_properties
from app.services.host_resources import (
    append_host_sample,
    load_host_resources,
    save_host_resources,
)
from app.services.azure_resources import (
    append_azure_sample,
    load_azure_resources,
    normalize_azure_interval,
    save_azure_resources,
)
from app.services.azure_monitor import azure_credentials_configured
from app.services.system_config import get_enabled_azure_targets, get_system_config
from app.services.process_utils import (
    detached_creation_flags,
    ensure_jmeter_stopped,
    is_process_alive,
    kill_process_tree,
    resolve_jmeter_pid,
)
from app.services.jmeter_jmx import prepare_jmx_with_error_trace
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
        self._azure_resource_tasks: dict[int, asyncio.Task] = {}
        self._resource_alert_state: dict[int, HostResourceAlertState] = {}
        self._ws_subscribers: dict[int, set] = defaultdict(set)
        self._lock = threading.Lock()

    def get_aggregator(self, run_id: int) -> MetricsAggregator | None:
        return self._aggregators.get(run_id)

    def subscribe(self, run_id: int, ws) -> None:
        self._ws_subscribers[run_id].add(ws)

    def unsubscribe(self, run_id: int, ws) -> None:
        self._ws_subscribers[run_id].discard(ws)

    async def broadcast(self, run_id: int, message: dict) -> None:
        subscribers = self._ws_subscribers.get(run_id)
        if not subscribers:
            return
        dead = []
        for ws in list(subscribers):
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

            prepared_jmx, error_trace_jtl = prepare_jmx_with_error_trace(jmx, run_path)

            test_run.run_dir = str(run_path)
            test_run.jtl_path = str(jtl)
            test_run.log_path = str(log_file)
            db.commit()

            cmd = [
                str(settings.jmeter_bin),
                "-n",
                "-t", str(prepared_jmx),
                "-l", str(jtl),
                "-j", str(log_file),
            ]
            cmd.extend(jmeter_cli_args(parse_jmeter_properties(scenario.jmeter_properties_json)))
            cmd.extend([
                "-Jjmeter.save.saveservice.output_format=csv",
                "-Jjmeter.save.saveservice.autoflush=true",
                # Main results.jtl stays CSV (no bodies). Full traces go to errors-trace.jtl (XML listener).
                "-Jjmeter.save.saveservice.response_data.max_size=2097152",
                "-Jjmeter.save.saveservice.assertion_results_failure_message=true",
                "-Jjmeter.save.saveservice.url=true",
                "-Jjmeter.save.saveservice.sample_type=true",
                "-Jjmeter.save.saveservice.subresults=false",
                "-Jjmeter.save.saveservice.default_encoding=UTF-8",
                f"-JRUN_DIR={run_path}",
                f"-JRUN_ID={test_run.id}",
                f"-JJTL_PATH={jtl}",
                f"-JERROR_TRACE_JTL={error_trace_jtl}",
                f"-JJMETER_LOG={log_file}",
            ])

            cwd = scripts_dir
            console_f = open(console_log, "w", encoding="utf-8", errors="replace")
            # Detached: server stop/update must not kill the load test.
            proc = subprocess.Popen(
                cmd,
                cwd=str(cwd),
                stdout=console_f,
                stderr=subprocess.STDOUT,
                creationflags=detached_creation_flags(),
                close_fds=True,
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
                timeline_bucket_seconds=1,
            )
            self._aggregators[test_run.id] = agg

            loop = asyncio.get_event_loop()
            self._tail_tasks[test_run.id] = loop.create_task(
                self._tail_and_monitor(
                    test_run.id,
                    jtl,
                    proc,
                    run_path,
                    scripts_dir,
                    started_at,
                    console_f,
                )
            )
            self._resource_tasks[test_run.id] = loop.create_task(
                self._sample_host_resources(test_run.id, run_path, started_at, proc)
            )
            self._azure_resource_tasks[test_run.id] = loop.create_task(
                self._sample_azure_resources(test_run.id, run_path, started_at, proc)
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
        proc: subprocess.Popen | None,
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
        alert_state = self._resource_alert_state.setdefault(run_id, HostResourceAlertState())
        try:
            while self._is_run_active(run_id, proc):
                sample = await loop.run_in_executor(
                    None, append_host_sample, run_path, started_at, samples, interval
                )
                alert_kinds = evaluate_host_resource_alerts(
                    alert_state,
                    cpu_percent=float(sample["cpu_percent"]),
                    memory_percent=float(sample["memory_percent"]),
                    interval_seconds=interval,
                )
                if alert_kinds:
                    db = SessionLocal()
                    try:
                        run = db.get(TestRun, run_id)
                        scenario = db.get(Scenario, run.scenario_id) if run else None
                        scenario_name = scenario.name if scenario else f"Run #{run_id}"
                        for kind in alert_kinds:
                            notify_host_resource_alert(
                                db,
                                run_id=run_id,
                                scenario_name=scenario_name,
                                kind=kind,
                                cpu_percent=float(sample["cpu_percent"]),
                                memory_percent=float(sample["memory_percent"]),
                                duration_seconds=(
                                    CPU_DURATION_SECONDS
                                    if kind == "host_cpu_high"
                                    else MEMORY_DURATION_SECONDS
                                ),
                            )
                    finally:
                        db.close()
                await asyncio.sleep(interval)
        except asyncio.CancelledError:
            pass
        finally:
            self._resource_alert_state.pop(run_id, None)
            if samples:
                save_host_resources(run_path, samples, interval)

    async def _sample_azure_resources(
        self,
        run_id: int,
        run_path: Path,
        started_at: datetime,
        proc: subprocess.Popen | None,
    ) -> None:
        """Poll Azure Monitor CPU/Memory for configured VMs and store with the run."""
        samples: list[dict] = []
        existing = load_azure_resources(run_path)
        if isinstance(existing.get("samples"), list):
            samples = list(existing["samples"])

        db = SessionLocal()
        try:
            cfg = get_system_config(db)
            targets = get_enabled_azure_targets(cfg)
            interval = normalize_azure_interval(cfg.resource_sample_interval_seconds)
        finally:
            db.close()

        if not targets or not azure_credentials_configured():
            return

        loop = asyncio.get_event_loop()
        try:
            while self._is_run_active(run_id, proc):
                await loop.run_in_executor(
                    None,
                    append_azure_sample,
                    run_path,
                    started_at,
                    samples,
                    targets,
                    interval,
                )
                await asyncio.sleep(interval)
        except asyncio.CancelledError:
            pass
        finally:
            if samples:
                save_azure_resources(
                    run_path,
                    samples=samples,
                    targets=targets,
                    interval_seconds=interval,
                )

    async def _tail_and_monitor(
        self,
        run_id: int,
        jtl_path: Path,
        proc: subprocess.Popen | None,
        run_path: Path,
        scripts_dir: Path,
        started_at: datetime,
        console_f,
    ) -> None:
        agg = self._aggregators[run_id]
        last_size = jtl_path.stat().st_size if jtl_path.exists() else 0
        # Seed aggregator from existing JTL when reattaching after a server restart/update.
        if last_size > 0 and not agg.samples:
            try:
                seeded = parse_jtl_file(jtl_path)
                seeded.test_run_id = run_id
                seeded.status = TestRunStatus.RUNNING
                self._aggregators[run_id] = seeded
                agg = seeded
            except Exception:
                append_jtl_file(agg, jtl_path)

        tail_interval = max(settings.metrics_tail_interval_seconds, 1)
        heartbeat_ticks = max(1, round(10 / tail_interval))
        tick = 0
        pid_check_interval = 5
        pid_check_counter = 0

        while self._is_run_active(run_id, proc, refresh_pid=(pid_check_counter == 0)):
            pid_check_counter = (pid_check_counter + 1) % pid_check_interval
            changed = False
            if jtl_path.exists():
                size = jtl_path.stat().st_size
                if size > last_size:
                    await asyncio.sleep(0.05)
                    stable_size = jtl_path.stat().st_size
                    if stable_size >= size:
                        _, changed = append_jtl_file(agg, jtl_path)
                        last_size = stable_size
                elif size < last_size:
                    # File truncated/replaced — resync
                    last_size = 0
                    _, changed = append_jtl_file(agg, jtl_path)
                    last_size = jtl_path.stat().st_size if jtl_path.exists() else 0

            tick += 1
            subscribers = self._ws_subscribers.get(run_id)
            if subscribers and (changed or tick % heartbeat_ticks == 0):
                snap = agg.snapshot()
                await self.broadcast(run_id, {"type": "metrics", "data": snap.model_dump(mode="json")})
            await asyncio.sleep(tail_interval)

        # Final read
        if jtl_path.exists():
            append_jtl_file(agg, jtl_path)

        exit_code = proc.returncode if proc is not None else 0
        if console_f:
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

            # Keep finished-run metrics warm for fast multi-tab report opens (no re-parse).
            from app.services.jtl_agg_cache import jtl_agg_cache

            jtl_agg_cache.put(run_id, jtl_path if jtl_path.exists() else None, agg)

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

    def _refresh_jmeter_pid(self, run_id: int, proc: subprocess.Popen | None) -> int | None:
        jmeter_pid = self._jmeter_pids.get(run_id)
        if jmeter_pid and is_process_alive(jmeter_pid):
            return jmeter_pid
        if proc is not None:
            refreshed = resolve_jmeter_pid(proc.pid)
            if refreshed > 0:
                self._jmeter_pids[run_id] = refreshed
                return refreshed
        return jmeter_pid

    def _is_run_active(
        self,
        run_id: int,
        proc: subprocess.Popen | None,
        *,
        refresh_pid: bool = True,
    ) -> bool:
        if refresh_pid:
            jmeter_pid = self._refresh_jmeter_pid(run_id, proc)
        else:
            jmeter_pid = self._jmeter_pids.get(run_id)
        if jmeter_pid and is_process_alive(jmeter_pid):
            return True
        if proc is not None:
            return proc.poll() is None
        return False

    async def reattach_running_runs(self) -> list[int]:
        """
        After a server restart/update, resume monitoring for RUNNING tests whose
        JMeter process is still alive. Does not start a new JMeter instance.
        """
        db = SessionLocal()
        resumed: list[int] = []
        try:
            running = (
                db.query(TestRun)
                .filter(TestRun.status == TestRunStatus.RUNNING)
                .order_by(TestRun.id.asc())
                .all()
            )
            for run in running:
                if run.id in self._tail_tasks and not self._tail_tasks[run.id].done():
                    continue
                if not run.pid or not is_process_alive(run.pid):
                    continue

                jtl = Path(run.jtl_path) if run.jtl_path else None
                run_path = Path(run.run_dir) if run.run_dir else (jtl.parent if jtl else None)
                if not jtl or not run_path or not run_path.is_dir():
                    continue

                scenario = db.get(Scenario, run.scenario_id)
                scripts_dir = run_path
                if scenario:
                    application = db.get(Application, scenario.application_id)
                    build = db.get(Build, application.build_id) if application else None
                    release = db.get(Release, build.release_id) if build else None
                    if release and build and application:
                        scripts_dir = scenario_scripts_dir(release, build, application)
                started_at = run.started_at or datetime.utcnow()

                self._jmeter_pids[run.id] = run.pid
                if jtl.exists():
                    try:
                        agg = parse_jtl_file(jtl)
                    except Exception:
                        agg = MetricsAggregator(
                            test_run_id=run.id,
                            bucket_seconds=settings.metrics_bucket_seconds,
                            timeline_bucket_seconds=1,
                        )
                else:
                    agg = MetricsAggregator(
                        test_run_id=run.id,
                        bucket_seconds=settings.metrics_bucket_seconds,
                        timeline_bucket_seconds=1,
                    )
                agg.test_run_id = run.id
                agg.status = TestRunStatus.RUNNING
                self._aggregators[run.id] = agg

                console_log = run_path / "jmeter-console.log"
                console_f = open(console_log, "a", encoding="utf-8", errors="replace")
                loop = asyncio.get_event_loop()
                self._tail_tasks[run.id] = loop.create_task(
                    self._tail_and_monitor(
                        run.id,
                        jtl,
                        None,
                        run_path,
                        scripts_dir,
                        started_at,
                        console_f,
                    )
                )
                self._resource_tasks[run.id] = loop.create_task(
                    self._sample_host_resources(run.id, run_path, started_at, None)
                )
                self._azure_resource_tasks[run.id] = loop.create_task(
                    self._sample_azure_resources(run.id, run_path, started_at, None)
                )
                resumed.append(run.id)
        finally:
            db.close()
        return resumed

    def _cancel_resource_tasks(self, run_id: int) -> None:
        resource_task = self._resource_tasks.pop(run_id, None)
        if resource_task and not resource_task.done():
            resource_task.cancel()
        azure_task = self._azure_resource_tasks.pop(run_id, None)
        if azure_task and not azure_task.done():
            azure_task.cancel()

    def _finalize_run_process(self, run_id: int) -> None:
        """Ensure JMeter/Java is dead and drop process handles after a run ends."""
        proc = self._processes.pop(run_id, None)
        jmeter_pid = self._jmeter_pids.pop(run_id, None)
        root_pid = proc.pid if proc else 0
        if root_pid or jmeter_pid:
            ensure_jmeter_stopped(root_pid, jmeter_pid)

        self._cancel_resource_tasks(run_id)

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
        self._cancel_resource_tasks(run_id)
        return True

    def cancel_run(self, run_id: int, fallback_pid: int | None = None) -> bool:
        return self._force_stop_jmeter(run_id, fallback_pid)

    def cleanup_run(self, run_id: int) -> None:
        """Stop process/tail task and drop in-memory state for a test run."""
        self._force_stop_jmeter(run_id)
        task = self._tail_tasks.pop(run_id, None)
        if task and not task.done():
            task.cancel()
        self._cancel_resource_tasks(run_id)
        self._processes.pop(run_id, None)
        self._jmeter_pids.pop(run_id, None)
        self._aggregators.pop(run_id, None)
        self._resource_alert_state.pop(run_id, None)
        self._ws_subscribers.pop(run_id, None)


run_manager = RunManager()
