"""Threshold alerts for host CPU and memory during active test runs."""

from __future__ import annotations

from dataclasses import dataclass, field

CPU_THRESHOLD_PERCENT = 90.0
CPU_DURATION_SECONDS = 60
MEMORY_THRESHOLD_PERCENT = 95.0
MEMORY_DURATION_SECONDS = 180


@dataclass
class HostResourceAlertState:
    cpu_consecutive: int = 0
    memory_consecutive: int = 0


def _required_samples(duration_seconds: int, interval_seconds: int) -> int:
    interval = max(interval_seconds, 1)
    return max(1, (duration_seconds + interval - 1) // interval)


def evaluate_host_resource_alerts(
    state: HostResourceAlertState,
    *,
    cpu_percent: float,
    memory_percent: float,
    interval_seconds: int,
) -> list[str]:
    """
    Update consecutive high-usage counters and return alert kinds to fire.

    Returns zero or more of: ``host_cpu_high``, ``host_memory_high``.
    """
    alerts: list[str] = []

    if cpu_percent > CPU_THRESHOLD_PERCENT:
        state.cpu_consecutive += 1
    else:
        state.cpu_consecutive = 0

    if memory_percent > MEMORY_THRESHOLD_PERCENT:
        state.memory_consecutive += 1
    else:
        state.memory_consecutive = 0

    cpu_needed = _required_samples(CPU_DURATION_SECONDS, interval_seconds)
    mem_needed = _required_samples(MEMORY_DURATION_SECONDS, interval_seconds)

    if state.cpu_consecutive >= cpu_needed:
        alerts.append("host_cpu_high")
        state.cpu_consecutive = 0

    if state.memory_consecutive >= mem_needed:
        alerts.append("host_memory_high")
        state.memory_consecutive = 0

    return alerts
