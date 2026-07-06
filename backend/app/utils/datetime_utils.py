"""Datetime helpers for API and scheduling."""

from __future__ import annotations

from datetime import datetime, timezone


def naive_utc(dt: datetime) -> datetime:
    """Convert aware datetimes to naive UTC; leave naive values unchanged."""
    if dt.tzinfo is not None:
        return dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt
