"""Persist Azure VM CPU/Memory samples beside each test run (like host_resources.json)."""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from app.services.azure_monitor import sample_configured_targets

AZURE_RESOURCES_FILENAME = "azure_resources.json"
# Azure metrics resolution is often ~1 minute; polling can still be every 10s
# so charts update promptly (values may repeat until Azure publishes a new point).
MIN_AZURE_SAMPLE_INTERVAL_SECONDS = 10
MAX_AZURE_SAMPLE_INTERVAL_SECONDS = 300
DEFAULT_AZURE_SAMPLE_INTERVAL_SECONDS = 10


def azure_resources_path(run_dir: Path) -> Path:
    return run_dir / AZURE_RESOURCES_FILENAME


def load_azure_resources(run_dir: Path) -> dict:
    path = azure_resources_path(run_dir)
    if not path.is_file():
        return {
            "interval_seconds": DEFAULT_AZURE_SAMPLE_INTERVAL_SECONDS,
            "targets": [],
            "samples": [],
        }
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("samples"), list):
            return data
    except (json.JSONDecodeError, OSError):
        pass
    return {
        "interval_seconds": DEFAULT_AZURE_SAMPLE_INTERVAL_SECONDS,
        "targets": [],
        "samples": [],
    }


def save_azure_resources(
    run_dir: Path,
    *,
    samples: list[dict],
    targets: list[dict[str, str]],
    interval_seconds: int,
) -> None:
    run_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "interval_seconds": interval_seconds,
        "targets": [{"name": t["name"], "resource_id": t["resource_id"]} for t in targets],
        "samples": samples,
    }
    azure_resources_path(run_dir).write_text(
        json.dumps(payload, indent=2),
        encoding="utf-8",
    )


def normalize_azure_interval(seconds: int) -> int:
    base = seconds if isinstance(seconds, int) and seconds > 0 else DEFAULT_AZURE_SAMPLE_INTERVAL_SECONDS
    return max(MIN_AZURE_SAMPLE_INTERVAL_SECONDS, min(MAX_AZURE_SAMPLE_INTERVAL_SECONDS, base))


def append_azure_sample(
    run_dir: Path,
    started_at: datetime,
    samples: list[dict],
    targets: list[dict[str, str]],
    interval_seconds: int,
) -> dict:
    elapsed = max(0.0, (datetime.utcnow() - started_at).total_seconds())
    servers = sample_configured_targets(targets)
    sample = {
        "t": round(elapsed, 1),
        "recorded_at": datetime.utcnow().isoformat(),
        "servers": servers,
    }
    samples.append(sample)
    if len(samples) == 1 or len(samples) % 2 == 0:
        save_azure_resources(
            run_dir,
            samples=samples,
            targets=targets,
            interval_seconds=interval_seconds,
        )
    return sample
