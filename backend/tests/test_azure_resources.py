"""Tests for Azure Monitor target parsing and resource file storage."""

import json
from datetime import datetime
from pathlib import Path

from app.services.azure_monitor import parse_azure_targets
from app.services.azure_resources import (
    load_azure_resources,
    normalize_azure_interval,
    save_azure_resources,
)


def test_parse_azure_targets_skips_blank_resource_ids_for_sampling():
    raw = json.dumps(
        [
            {"name": "PQSQCSQL2016N01", "resource_id": "/subscriptions/x/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/PQSQCSQL2016N01"},
            {"name": "QCApplicationInsight", "resource_id": ""},
            {"name": "", "resource_id": "/subscriptions/x/..."},
        ]
    )
    targets = parse_azure_targets(raw)
    assert len(targets) == 1
    assert targets[0]["name"] == "PQSQCSQL2016N01"


def test_normalize_azure_interval_allows_ten_seconds():
    assert normalize_azure_interval(10) == 10
    assert normalize_azure_interval(5) == 10
    assert normalize_azure_interval(90) == 90
    assert normalize_azure_interval(400) == 300


def test_build_vm_resource_id():
    from app.services.azure_monitor import build_vm_resource_id, fill_missing_resource_ids

    rid = build_vm_resource_id(
        subscription_id="sub-1",
        resource_group="MyRG",
        vm_name="PQSQCVAL2022N01",
    )
    assert rid.endswith("/virtualMachines/PQSQCVAL2022N01")
    assert "resourceGroups/MyRG" in rid

    filled = fill_missing_resource_ids(
        [{"name": "PQSQCVAL2022N01", "resource_id": ""}],
        subscription_id="sub-1",
        resource_group="MyRG",
    )
    assert filled[0]["resource_id"] == rid


def test_save_and_load_azure_resources(tmp_path: Path):
    targets = [
        {
            "name": "PQSQCVAL2022N01",
            "resource_id": "/subscriptions/x/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/PQSQCVAL2022N01",
        }
    ]
    samples = [
        {
            "t": 0.0,
            "recorded_at": datetime.utcnow().isoformat(),
            "servers": {
                "PQSQCVAL2022N01": {
                    "cpu_percent": 12.5,
                    "cpu_max_percent": 28.0,
                    "memory_percent": 44.0,
                },
            },
        }
    ]
    save_azure_resources(tmp_path, samples=samples, targets=targets, interval_seconds=60)
    loaded = load_azure_resources(tmp_path)
    assert loaded["interval_seconds"] == 60
    assert loaded["targets"][0]["name"] == "PQSQCVAL2022N01"
    assert loaded["samples"][0]["servers"]["PQSQCVAL2022N01"]["cpu_percent"] == 12.5
