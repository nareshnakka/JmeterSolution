"""Tests for aggregate TOTAL row calculations."""

from app.models import TestRunStatus
from app.services.jtl_parser import MetricsAggregator, Sample


def _sample(**kwargs) -> Sample:
    defaults = dict(
        sample_index=0,
        timestamp_ms=1_000_000,
        elapsed_ms=100.0,
        label="A",
        response_code="200",
        response_message="OK",
        thread_name="TG 1-1",
        success=True,
        failure_message="",
        data_type="text",
        url="http://example.com/a",
    )
    defaults.update(kwargs)
    return Sample(**defaults)


def test_transaction_totals_pools_samples_for_true_average():
    agg = MetricsAggregator(test_run_id=1)
    agg.status = TestRunStatus.COMPLETED
    agg.start_wall_time = 0
    agg.samples = [
        _sample(label="Fast", elapsed_ms=100, timestamp_ms=5_000),
        _sample(label="Fast", elapsed_ms=200, timestamp_ms=6_000),
        _sample(label="Slow", elapsed_ms=900, timestamp_ms=7_000),
        _sample(label="Slow", elapsed_ms=800, timestamp_ms=8_000),
    ]

    total = agg.transaction_totals()
    assert total is not None
    assert total.samples == 4
    assert total.avg_ms == 500.0
    assert total.min_ms == 100.0
    assert total.max_ms == 900.0
    assert total.median_ms == 500.0


def test_transaction_totals_respects_kind_filter():
    agg = MetricsAggregator(test_run_id=1)
    agg.status = TestRunStatus.COMPLETED
    agg.start_wall_time = 0
    agg.samples = [
        _sample(
            label="Login",
            response_message="Number of samples in transaction : 1",
            data_type="",
            url="",
            elapsed_ms=300,
            timestamp_ms=5_000,
        ),
        _sample(label="GET /login", elapsed_ms=100, timestamp_ms=6_000),
    ]

    tx_total = agg.transaction_totals(kind_filter="transaction")
    req_total = agg.transaction_totals(kind_filter="request")

    assert tx_total is not None and tx_total.samples == 1 and tx_total.avg_ms == 300.0
    assert req_total is not None and req_total.samples == 1 and req_total.avg_ms == 100.0


def test_elapsed_seconds_uses_sample_span_for_completed_runs():
    agg = MetricsAggregator(test_run_id=1)
    agg.status = TestRunStatus.COMPLETED
    agg.start_wall_time = 0
    agg.samples = [
        _sample(timestamp_ms=0),
        _sample(timestamp_ms=10_000),
    ]
    assert agg._elapsed_seconds() == 10.0
