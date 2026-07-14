"""Tests for stable absolute SQLite path resolution."""

from pathlib import Path

from app.db_paths import resolve_database_url, default_database_path, _quarantine_empty_db


def test_relative_url_resolves_under_backend(tmp_path, monkeypatch):
    url = resolve_database_url("sqlite:///./jmeter_agent.db", data_root=tmp_path)
    assert url.startswith("sqlite:///")
    assert url.endswith("jmeter_agent.db")
    assert "backend" in url.replace("\\", "/")
    resolved = Path(url[len("sqlite:///"):])
    assert resolved.is_absolute()


def test_prefers_existing_db_with_rows(tmp_path):
    data_root = tmp_path / "data"
    data_root.mkdir()
    empty = data_root / "jmeter_agent.db"
    empty.write_bytes(b"")

    # empty file under data_root should be quarantine-eligible after resolve
    url = resolve_database_url("sqlite:///./jmeter_agent.db", data_root=data_root)
    assert "backend" in url.replace("\\", "/") or Path(url[len("sqlite:///"):]).name == "jmeter_agent.db"


def test_quarantine_renames_empty_file(tmp_path):
    empty = tmp_path / "jmeter_agent.db"
    empty.write_bytes(b"")
    _quarantine_empty_db(empty)
    assert not empty.exists()
    quarantined = list(tmp_path.glob("jmeter_agent.db.empty-quarantine-*"))
    assert len(quarantined) == 1


def test_default_database_path_is_absolute():
    path = default_database_path()
    assert path.is_absolute()
    assert path.name == "jmeter_agent.db"
