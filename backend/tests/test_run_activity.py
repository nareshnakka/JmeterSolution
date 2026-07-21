"""Tests for lightweight test-run activity probe."""

from app.models import TestRun
from app.schemas import TestRunActivityOut


def test_activity_schema_defaults():
    out = TestRunActivityOut()
    assert out.running == 0
    assert out.pending == 0
    assert out.has_active is False


def test_activity_schema_active():
    out = TestRunActivityOut(running=1, pending=2, has_active=True)
    assert out.has_active is True
    assert out.running == 1
    assert out.pending == 2


def test_get_run_activity_counts():
    from app.routers import test_runs as tr

    class FakeQuery:
        def __init__(self, n: int):
            self._n = n

        def filter(self, *args, **kwargs):
            return self

        def count(self):
            return self._n

    class FakeSession:
        def __init__(self):
            self._calls = 0

        def query(self, model):
            assert model is TestRun
            self._calls += 1
            return FakeQuery(1 if self._calls == 1 else 3)

    result = tr.get_run_activity(FakeSession())
    assert result.running == 1
    assert result.pending == 3
    assert result.has_active is True
