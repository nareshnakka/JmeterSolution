"""Application version from repo-root version.json."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

_VERSION_FILE = Path(__file__).resolve().parent.parent.parent / "version.json"


@lru_cache(maxsize=1)
def load_version() -> dict:
    if not _VERSION_FILE.is_file():
        return {"major": 1, "minor": 2, "patch": 0}
    data = json.loads(_VERSION_FILE.read_text(encoding="utf-8"))
    return {
        "major": int(data.get("major", 1)),
        "minor": int(data.get("minor", 2)),
        "patch": int(data.get("patch", 0)),
    }


def version_label() -> str:
    v = load_version()
    return f"v{v['major']}.{v['minor']}.{v['patch']}"


def version_full() -> str:
    v = load_version()
    return f"{v['major']}.{v['minor']}.{v['patch']}"
