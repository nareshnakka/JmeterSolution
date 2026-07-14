"""CLI: backup SQLite DB + checkpoint before software updates."""

from __future__ import annotations

import sys
from pathlib import Path

# Allow running as `python scripts/backup-user-data.py` from repo root
_BACKEND = Path(__file__).resolve().parent.parent / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from app.db_paths import backup_databases, checkpoint_sqlite, default_database_path  # noqa: E402


def main() -> int:
    print(f"Canonical database: {default_database_path()}")
    print("Checkpointing SQLite (best effort)...")
    checkpoint_sqlite()
    print("Creating database backup...")
    dest = backup_databases()
    print(f"Backup saved to: {dest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
