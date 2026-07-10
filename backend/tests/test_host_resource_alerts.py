"""Tests for host CPU/memory threshold alerts."""

from app.services.host_resource_alerts import (
    CPU_DURATION_SECONDS,
    CPU_THRESHOLD_PERCENT,
    MEMORY_DURATION_SECONDS,
    MEMORY_THRESHOLD_PERCENT,
    HostResourceAlertState,
    evaluate_host_resource_alerts,
)


def test_cpu_alert_after_one_minute_at_default_interval():
    state = HostResourceAlertState()
    interval = 10
    alerts: list[str] = []
    for _ in range(5):
        alerts.extend(
            evaluate_host_resource_alerts(
                state,
                cpu_percent=CPU_THRESHOLD_PERCENT + 1,
                memory_percent=10,
                interval_seconds=interval,
            )
        )
    assert alerts == []
    alerts = evaluate_host_resource_alerts(
        state,
        cpu_percent=CPU_THRESHOLD_PERCENT + 1,
        memory_percent=10,
        interval_seconds=interval,
    )
    assert alerts == ["host_cpu_high"]


def test_memory_alert_after_three_minutes_at_default_interval():
    state = HostResourceAlertState()
    interval = 10
    needed = MEMORY_DURATION_SECONDS // interval
    alerts: list[str] = []
    for _ in range(needed - 1):
        alerts.extend(
            evaluate_host_resource_alerts(
                state,
                cpu_percent=10,
                memory_percent=MEMORY_THRESHOLD_PERCENT + 0.5,
                interval_seconds=interval,
            )
        )
    assert alerts == []
    alerts = evaluate_host_resource_alerts(
        state,
        cpu_percent=10,
        memory_percent=MEMORY_THRESHOLD_PERCENT + 0.5,
        interval_seconds=interval,
    )
    assert alerts == ["host_memory_high"]


def test_consecutive_counter_resets_when_usage_drops():
    state = HostResourceAlertState()
    interval = 10
    for _ in range(4):
        evaluate_host_resource_alerts(
            state,
            cpu_percent=95,
            memory_percent=10,
            interval_seconds=interval,
        )
    evaluate_host_resource_alerts(
        state,
        cpu_percent=50,
        memory_percent=10,
        interval_seconds=interval,
    )
    alerts: list[str] = []
    for _ in range(6):
        alerts.extend(
            evaluate_host_resource_alerts(
                state,
                cpu_percent=95,
                memory_percent=10,
                interval_seconds=interval,
            )
        )
    assert alerts == ["host_cpu_high"]


def test_threshold_is_strictly_greater_than_limit():
    state = HostResourceAlertState()
    interval = 10
    alerts: list[str] = []
    for _ in range(10):
        alerts.extend(
            evaluate_host_resource_alerts(
                state,
                cpu_percent=CPU_THRESHOLD_PERCENT,
                memory_percent=MEMORY_THRESHOLD_PERCENT,
                interval_seconds=interval,
            )
        )
    assert alerts == []
