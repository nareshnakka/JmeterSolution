"""Tests for Report Bug helpers (no live GitHub calls)."""

from app.logging_setup import read_log_tail, server_log_path, setup_logging
from app.services.bug_report import _slug, github_configured


def test_slug_sanitizes_title():
    assert _slug("UI freezes!! during run") == "ui-freezes-during-run"
    assert _slug("") == "bug"


def test_github_configured_false_without_token(monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "github_token", "")
    assert github_configured() is False
    monkeypatch.setattr(settings, "github_token", "  ghp_test  ")
    assert github_configured() is True


def test_setup_logging_writes_file(tmp_path, monkeypatch):
    from app.config import settings
    import logging
    import app.logging_setup as logging_setup

    monkeypatch.setattr(settings, "data_root", tmp_path)
    monkeypatch.setattr(logging_setup, "_configured", False)
    path = setup_logging()
    assert path == tmp_path / "logs" / "server.log"
    assert path == server_log_path()
    logging.getLogger("test.bug.report").info("hello-from-test")
    for h in logging.getLogger().handlers:
        h.flush()
    text = read_log_tail(path, 10_000)
    assert "hello-from-test" in text
