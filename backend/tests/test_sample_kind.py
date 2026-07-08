"""Tests for JTL sample kind classification."""

from app.services.jtl_parser import Sample, _sample_kind, MetricsAggregator


def _sample(**kwargs) -> Sample:
    defaults = dict(
        sample_index=0,
        timestamp_ms=0,
        elapsed_ms=1.0,
        label="Test",
        response_code="200",
        response_message="OK",
        thread_name="TG 1-1",
        success=True,
        failure_message="",
    )
    defaults.update(kwargs)
    return Sample(**defaults)


def test_transaction_controller_by_response_message():
    s = _sample(
        label="Login",
        response_message="Number of samples in transaction : 2, number of failing samples : 0",
        data_type="",
        url="",
    )
    assert _sample_kind(s) == "transaction"


def test_http_sampler_by_data_type():
    s = _sample(label="GET /api/users", data_type="text", url="http://example.com/api/users")
    assert _sample_kind(s) == "request"


def test_transaction_empty_data_type_without_url():
    s = _sample(label="Checkout", response_code="200", response_message="", data_type="", url="")
    assert _sample_kind(s) == "transaction"


def test_transaction_message_wins_over_url():
    s = _sample(
        label="Login",
        response_message="Number of samples in transaction : 1, number of failing samples : 0",
        data_type="",
        url="http://example.com/login",
    )
    assert _sample_kind(s) == "transaction"


def test_empty_data_type_without_url_is_transaction():
    s = _sample(label="Flow", response_code="200", response_message="OK", data_type="", url="")
    assert _sample_kind(s) == "transaction"


def test_request_rows_skipped_when_label_has_transaction():
    agg = MetricsAggregator(test_run_id=1)
    agg.samples = [
        _sample(
            label="Login",
            response_message="Number of samples in transaction : 1",
            data_type="",
            url="",
        ),
        _sample(
            label="Login",
            data_type="text",
            url="http://example.com/login",
            response_message="OK",
        ),
        _sample(label="GET /home", data_type="text", url="http://example.com/home"),
    ]
    metrics = agg.transaction_metrics()
    labels = {m.label: m.kind for m in metrics}
    assert labels == {"Login": "transaction", "GET /home": "request"}
