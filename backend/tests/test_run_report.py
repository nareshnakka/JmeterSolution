"""Tests for single-connection finished report payload."""

from app.schemas import LiveMetricsSnapshot, TestRunReportOut, TestRunStatus


def test_report_out_preserves_metrics_and_graphs():
    metrics = LiveMetricsSnapshot(
        test_run_id=1,
        status=TestRunStatus.COMPLETED,
        total_samples=10,
        total_errors=1,
    )
    out = TestRunReportOut(
        metrics=metrics,
        errors=[],
        response_time_graph={"mode": "cumulative", "series": [{"label": "ALL", "points": []}]},
        errors_graph={"mode": "all", "series": [{"label": "ALL", "points": []}]},
    )
    assert out.metrics.total_samples == 10
    assert out.response_time_graph["mode"] == "cumulative"
    assert out.errors_graph["mode"] == "all"
