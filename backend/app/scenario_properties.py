"""Serialize and validate JMeter -J properties stored on scenarios."""

from __future__ import annotations

import json
import re
from typing import Any

from fastapi import HTTPException

PROPERTY_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_.-]*$")
MAX_PROPERTIES = 50
MAX_NAME_LEN = 128
MAX_VALUE_LEN = 4096

RESERVED_EXACT = frozenset({"RUN_DIR", "RUN_ID", "JTL_PATH", "JMETER_LOG"})
RESERVED_PREFIXES = ("jmeter.save.saveservice.",)


def parse_jmeter_properties(raw: str | None) -> list[dict[str, str]]:
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return []
    if not isinstance(parsed, list):
        return []
    result: list[dict[str, str]] = []
    for item in parsed:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name", "")).strip()
        value = str(item.get("value", ""))
        if name:
            result.append({"name": name, "value": value})
    return result


def serialize_jmeter_properties(properties: list[dict[str, str]]) -> str | None:
    cleaned: list[dict[str, str]] = []
    seen: set[str] = set()
    for prop in properties:
        name = prop.get("name", "").strip()
        value = str(prop.get("value", ""))
        if not name:
            continue
        key = name.lower()
        if key in seen:
            raise HTTPException(400, f"Duplicate JMeter property name: {name}")
        seen.add(key)
        _validate_property_name(name)
        if len(value) > MAX_VALUE_LEN:
            raise HTTPException(400, f"Property value too long for '{name}' (max {MAX_VALUE_LEN} chars)")
        cleaned.append({"name": name, "value": value})
    if len(cleaned) > MAX_PROPERTIES:
        raise HTTPException(400, f"Maximum {MAX_PROPERTIES} JMeter properties allowed")
    return json.dumps(cleaned) if cleaned else None


def properties_from_form(names: list[str], values: list[str]) -> list[dict[str, str]]:
    pairs: list[dict[str, str]] = []
    for idx, raw_name in enumerate(names):
        name = raw_name.strip()
        if not name:
            continue
        value = values[idx] if idx < len(values) else ""
        pairs.append({"name": name, "value": value})
    return pairs


def _validate_property_name(name: str) -> None:
    if len(name) > MAX_NAME_LEN:
        raise HTTPException(400, f"Property name too long: {name[:32]}…")
    if not PROPERTY_NAME_RE.match(name):
        raise HTTPException(
            400,
            f"Invalid property name '{name}'. Use letters, numbers, dots, dashes, and underscores.",
        )
    upper = name.upper()
    if upper in RESERVED_EXACT:
        raise HTTPException(400, f"Property name '{name}' is reserved by the test runner")
    lowered = name.lower()
    for prefix in RESERVED_PREFIXES:
        if lowered.startswith(prefix):
            raise HTTPException(400, f"Property name '{name}' is reserved by the test runner")


def jmeter_cli_args(properties: list[dict[str, str]]) -> list[str]:
    args: list[Any] = []
    for prop in properties:
        name = prop.get("name", "").strip()
        if not name:
            continue
        args.append(f"-J{name}={prop.get('value', '')}")
    return args
