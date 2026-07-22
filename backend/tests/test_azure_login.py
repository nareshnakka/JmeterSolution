"""Tests for Azure interactive login helpers (no live Microsoft calls)."""

from pathlib import Path

from app.services import azure_login


def test_status_payload_not_signed_in(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(azure_login.settings, "data_root", tmp_path)
    monkeypatch.setattr(azure_login.settings, "azure_subscription_id", "sub-123")
    payload = azure_login.status_payload()
    assert payload["signed_in"] is False
    assert payload["subscription_id_set"] is True
    assert payload["subscription_id"] == "sub-123"


def test_clear_login_removes_files(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(azure_login.settings, "data_root", tmp_path)
    secrets = tmp_path / "_secrets"
    secrets.mkdir(parents=True)
    (secrets / "azure_auth_record.json").write_text("{}", encoding="utf-8")
    (secrets / "azure_account.json").write_text('{"username":"u"}', encoding="utf-8")
    assert azure_login.is_signed_in()
    azure_login.clear_login()
    assert not azure_login.is_signed_in()
    assert azure_login.load_account_meta() == {}


def test_interactive_client_id_defaults_to_azure_cli(monkeypatch):
    # Even if a confidential app client id is configured, interactive login must not use it
    # (avoids AADSTS650057 when the app only has Microsoft Graph).
    monkeypatch.setattr(azure_login.settings, "azure_client_id", "52872d20-0dde-4299-ab17-18c424de0a02")
    assert azure_login.interactive_client_id() == "04b07795-8ddb-461a-bbee-02f9e1bf7b46"
