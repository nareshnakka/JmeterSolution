"""Datetime helpers for API and scheduling."""

from __future__ import annotations

from datetime import datetime, timezone


def utc_now() -> datetime:
    """Current time as naive UTC (matches stored schedule timestamps)."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def naive_utc(dt: datetime) -> datetime:
    """Convert aware datetimes to naive UTC; leave naive values unchanged."""
    if dt.tzinfo is not None:
        return dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def ensure_utc_aware(dt: datetime) -> datetime:
    """Treat naive datetimes as UTC and return timezone-aware UTC."""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def to_utc_iso(dt: datetime | None) -> str | None:
    """Serialize a stored UTC datetime for JSON (always ends with Z)."""
    if dt is None:
        return None
    return ensure_utc_aware(dt).isoformat().replace("+00:00", "Z")
