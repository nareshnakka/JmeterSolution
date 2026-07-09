"""Host system CPU and memory sampling during test runs."""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

import psutil

from app.services.system_config import DEFAULT_RESOURCE_SAMPLE_INTERVAL_SECONDS

HOST_RESOURCES_FILENAME = "host_resources.json"
_cpu_initialized = False


def read_host_sample() -> dict:
    global _cpu_initialized
    # Non-blocking after first call — avoids 100ms sleep on every sample.
    cpu = psutil.cpu_percent(interval=0.1 if not _cpu_initialized else None)
    _cpu_initialized = True
    vm = psutil.virtual_memory()
    return {
        "cpu_percent": round(cpu, 1),
        "memory_percent": round(vm.percent, 1),
        "memory_used_mb": round(vm.used / (1024 * 1024), 1),
        "memory_total_mb": round(vm.total / (1024 * 1024), 1),
    }


def resources_path(run_dir: Path) -> Path:
    return run_dir / HOST_RESOURCES_FILENAME


def load_host_resources(run_dir: Path) -> dict:
    path = resources_path(run_dir)
    if not path.is_file():
        return {"interval_seconds": DEFAULT_RESOURCE_SAMPLE_INTERVAL_SECONDS, "samples": []}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("samples"), list):
            return data
    except (json.JSONDecodeError, OSError):
        pass
    return {"interval_seconds": DEFAULT_RESOURCE_SAMPLE_INTERVAL_SECONDS, "samples": []}


def save_host_resources(
    run_dir: Path,
    samples: list[dict],
    interval_seconds: int = DEFAULT_RESOURCE_SAMPLE_INTERVAL_SECONDS,
) -> None:
    run_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "interval_seconds": interval_seconds,
        "samples": samples,
    }
    resources_path(run_dir).write_text(
        json.dumps(payload, indent=2),
        encoding="utf-8",
    )


def append_host_sample(
    run_dir: Path,
    started_at: datetime,
    samples: list[dict],
    interval_seconds: int,
) -> dict:
    elapsed = max(0.0, (datetime.utcnow() - started_at).total_seconds())
    sample = {
        "t": round(elapsed, 1),
        **read_host_sample(),
        "recorded_at": datetime.utcnow().isoformat(),
    }
    samples.append(sample)
    if len(samples) == 1 or len(samples) % 6 == 0:
        save_host_resources(run_dir, samples, interval_seconds)
    return sample
