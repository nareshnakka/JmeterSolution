"""Tests for BlazeMeter-style timeline charts (active users + throughput)."""

from app.models import TestRunStatus
from app.services.jtl_parser import MetricsAggregator, Sample


def _sample(**kwargs) -> Sample:
    defaults = dict(
        sample_index=0,
        timestamp_ms=1_000_000,
        elapsed_ms=100.0,
        label="GET /home",
        response_code="200",
        response_message="OK",
        thread_name="TG 1-1",
        success=True,
        failure_message="",
        all_threads=1,
        data_type="text",
        url="http://example.com/home",
    )
    defaults.update(kwargs)
    return Sample(**defaults)


def _ingest(agg: MetricsAggregator, **kwargs) -> None:
    agg._ingest_sample(_sample(**kwargs))


def test_active_users_series_uses_one_second_buckets_with_step_hold():
    agg = MetricsAggregator(test_run_id=1, start_wall_time=0, timeline_bucket_seconds=1)
    agg.status = TestRunStatus.COMPLETED
    _ingest(agg, timestamp_ms=0, all_threads=1)
    _ingest(agg, timestamp_ms=1_000, all_threads=2)
    _ingest(agg, timestamp_ms=2_000, all_threads=5)

    series = agg._filled_active_users_series()
    assert [p["users"] for p in series] == [1, 2, 5]
    assert series[0]["t"] == 0.0
    assert series[-1]["t"] == 2.0


def test_throughput_series_counts_successful_hits_per_second():
    agg = MetricsAggregator(test_run_id=1, start_wall_time=0, timeline_bucket_seconds=1)
    agg.status = TestRunStatus.COMPLETED
    for i in range(4):
        _ingest(agg, timestamp_ms=i * 200, all_threads=1)
    _ingest(agg, timestamp_ms=1_200, all_threads=1, success=False)

    series = agg._filled_throughput_series()
    assert len(series) == 1
    assert series[0]["hits_per_sec"] == 4.0


def test_label_graph_capped_to_active_test_window():
    agg = MetricsAggregator(test_run_id=1, start_wall_time=0, bucket_seconds=5, timeline_bucket_seconds=1)
    agg.status = TestRunStatus.COMPLETED
    _ingest(agg, timestamp_ms=0, elapsed_ms=100, all_threads=5, label="Login")
    _ingest(agg, timestamp_ms=200_000, elapsed_ms=110, all_threads=3, label="Login")
    _ingest(agg, timestamp_ms=270_000, elapsed_ms=120, all_threads=0, label="Login")
    _ingest(agg, timestamp_ms=3_600_000, elapsed_ms=500, all_threads=0, label="Login")

    graph = agg.label_graph(["ALL"], cumulative=True)
    points = graph["series"][0]["points"]
    assert points
    assert max(p["t"] for p in points) <= 270.1
    assert graph["test_window_end"] <= 270.1


def test_label_graph_uses_throughput_end_when_users_stay_high():
    agg = MetricsAggregator(test_run_id=1, start_wall_time=0, bucket_seconds=5, timeline_bucket_seconds=1)
    agg.status = TestRunStatus.COMPLETED
    _ingest(agg, timestamp_ms=0, elapsed_ms=100, all_threads=10, label="Login")
    _ingest(agg, timestamp_ms=270_000, elapsed_ms=120, all_threads=10, label="Login")
    _ingest(agg, timestamp_ms=3_600_000, elapsed_ms=500, all_threads=10, label="Login", success=False)

    graph = agg.label_graph(["ALL"], cumulative=True)
    points = graph["series"][0]["points"]
    assert max(p["t"] for p in points) <= 270.1


def test_running_timeline_stops_at_last_sample_not_wall_clock(monkeypatch):
    agg = MetricsAggregator(test_run_id=1, start_wall_time=100.0, timeline_bucket_seconds=1)
    agg.status = TestRunStatus.RUNNING
    _ingest(agg, timestamp_ms=100_000, all_threads=3)
    _ingest(agg, timestamp_ms=370_000, all_threads=0)

    monkeypatch.setattr("app.services.jtl_parser.time.time", lambda: 1500.0)
    series = agg._filled_active_users_series()
    assert series[-1]["t"] == 270.0
    assert agg._elapsed_seconds() == 270.0
