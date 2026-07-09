"""Tests for run queue stale-run reconciliation."""

from datetime import datetime

from app.models import TestRun, TestRunStatus, TestRunType
from app.services.run_queue import reconcile_stale_runs, has_active_run


class _FakeRunManager:
    def __init__(self, alive: bool) -> None:
        self._alive = alive

    def is_tracked_run_active(self, run_id: int, pid: int | None) -> bool:
        return self._alive

    def cleanup_run(self, run_id: int) -> None:
        pass


def test_reconcile_marks_stale_running_as_failed(monkeypatch):
    import app.services.run_queue as run_queue

    run = TestRun(
        id=1,
        scenario_id=1,
        run_type=TestRunType.ADHOC,
        status=TestRunStatus.RUNNING,
        pid=99999,
        started_at=datetime.utcnow(),
        created_at=datetime.utcnow(),
    )

    class FakeQuery:
        def filter(self, *args, **kwargs):
            return self

        def all(self):
            return [run]

    class FakeSession:
        def query(self, model):
            return FakeQuery()

        def commit(self):
            pass

    monkeypatch.setattr(run_queue, "run_manager", _FakeRunManager(alive=False))
    updated = reconcile_stale_runs(FakeSession())  # type: ignore[arg-type]
    assert updated == 1
    assert run.status == TestRunStatus.FAILED
    assert run.error_message


def test_has_active_run_false_after_reconcile(monkeypatch):
    import app.services.run_queue as run_queue

    monkeypatch.setattr(run_queue, "reconcile_stale_runs", lambda db: 0)

    class FakeQuery:
        def filter(self, *args, **kwargs):
            return self

        def first(self):
            return None

    class FakeSession:
        def query(self, model):
            return FakeQuery()

    assert has_active_run(FakeSession()) is False  # type: ignore[arg-type]
