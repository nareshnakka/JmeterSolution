"""Tests for response code aggregation."""

from app.services.jtl_parser import MetricsAggregator, Sample


def _sample(**kwargs) -> Sample:
    defaults = dict(
        sample_index=0,
        timestamp_ms=1_000,
        elapsed_ms=100.0,
        label="GET /home",
        response_code="200",
        response_message="OK",
        thread_name="TG 1-1",
        success=True,
        failure_message="",
    )
    defaults.update(kwargs)
    return Sample(**defaults)


def test_response_code_counts_sorted_by_count():
    agg = MetricsAggregator(test_run_id=1)
    agg._ingest_sample(_sample(response_code="200"))
    agg._ingest_sample(_sample(response_code="200"))
    agg._ingest_sample(_sample(response_code="500", success=False))

    counts = agg.response_code_counts()
    assert [(c.response_code, c.count, c.pct) for c in counts] == [
        ("200", 2, 66.67),
        ("500", 1, 33.33),
    ]
