"""Unit tests for Azure metric payload helpers."""

from app.services.azure_monitor import _latest_metric_field


def test_latest_metric_field_prefers_newest_non_null():
    payload = {
        "value": [
            {
                "timeseries": [
                    {
                        "data": [
                            {"average": 10.0, "maximum": 20.0},
                            {"average": 30.0, "maximum": 45.5},
                            {"average": None, "maximum": None},
                        ]
                    }
                ]
            }
        ]
    }
    assert _latest_metric_field(payload, "average") == 30.0
    assert _latest_metric_field(payload, "maximum") == 45.5
