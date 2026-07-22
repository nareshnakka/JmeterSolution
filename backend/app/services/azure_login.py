"""Interactive Azure login (device code) with encrypted token cache (DPAPI on Windows)."""

from __future__ import annotations

import json
import logging
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.config import settings

logger = logging.getLogger(__name__)

# Microsoft's well-known public client used by Azure CLI — works for device-code without
# enabling "Allow public client flows" on a custom app registration.
_AZURE_CLI_PUBLIC_CLIENT_ID = "04b07795-8ddb-461a-bbee-02f9e1bf7b46"
_SCOPE = "https://management.azure.com/.default"
_CACHE_NAME = "jmeterAgentAzure"


def _secrets_dir() -> Path:
    root = Path(settings.data_root)
    path = root / "_secrets"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _auth_record_path() -> Path:
    return _secrets_dir() / "azure_auth_record.json"


def _account_meta_path() -> Path:
    return _secrets_dir() / "azure_account.json"


def interactive_client_id() -> str:
    return (settings.azure_client_id or "").strip() or _AZURE_CLI_PUBLIC_CLIENT_ID


def interactive_tenant_id() -> str:
    return (settings.azure_tenant_id or "").strip() or "organizations"


def is_signed_in() -> bool:
    return _auth_record_path().is_file()


def load_account_meta() -> dict[str, Any]:
    path = _account_meta_path()
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _save_account_meta(meta: dict[str, Any]) -> None:
    _account_meta_path().write_text(json.dumps(meta, indent=2), encoding="utf-8")


def _cache_options():
    from azure.identity import TokenCachePersistenceOptions

    # Prefer OS encryption (DPAPI on Windows). Fall back to file storage if needed.
    return TokenCachePersistenceOptions(name=_CACHE_NAME, allow_unencrypted_storage=True)


def _load_authentication_record():
    from azure.identity import AuthenticationRecord

    path = _auth_record_path()
    if not path.is_file():
        return None
    try:
        return AuthenticationRecord.deserialize(path.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.warning("Failed to load Azure auth record: %s", exc)
        return None


def _save_authentication_record(record) -> None:
    _auth_record_path().write_text(record.serialize(), encoding="utf-8")


def clear_login() -> None:
    for path in (_auth_record_path(), _account_meta_path()):
        try:
            path.unlink(missing_ok=True)
        except OSError as exc:
            logger.warning("Failed to remove %s: %s", path, exc)


def build_interactive_credential(*, allow_prompt: bool = False):
    """Build DeviceCodeCredential from encrypted cache. Raises if not signed in and prompt disallowed."""
    from azure.identity import DeviceCodeCredential

    record = _load_authentication_record()
    if record is None and not allow_prompt:
        raise RuntimeError("Not signed in to Azure. Open the Azure page and sign in.")

    kwargs: dict[str, Any] = {
        "client_id": interactive_client_id(),
        "tenant_id": interactive_tenant_id(),
        "cache_persistence_options": _cache_options(),
    }
    if record is not None:
        kwargs["authentication_record"] = record
        # Avoid re-prompting when we have a cached record.
        kwargs["disable_automatic_authentication"] = True

    return DeviceCodeCredential(**kwargs)


def get_interactive_token() -> str:
    credential = build_interactive_credential(allow_prompt=False)
    token = credential.get_token(_SCOPE)
    return token.token


@dataclass
class LoginSession:
    session_id: str
    status: str = "pending"  # pending | waiting_user | success | failed | cancelled
    user_code: str | None = None
    verification_uri: str | None = None
    message: str | None = None
    error: str | None = None
    account: dict[str, Any] = field(default_factory=dict)
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    _cancel: threading.Event = field(default_factory=threading.Event, repr=False)
    _thread: threading.Thread | None = field(default=None, repr=False)


_sessions: dict[str, LoginSession] = {}
_sessions_lock = threading.Lock()


def get_login_session(session_id: str) -> LoginSession | None:
    with _sessions_lock:
        return _sessions.get(session_id)


def start_device_code_login() -> LoginSession:
    """Start device-code login in a background thread; return session with user code when ready."""
    if not settings.azure_subscription_id.strip():
        raise RuntimeError(
            "AZURE_SUBSCRIPTION_ID is required in .env before signing in. "
            "Set it in the project-root .env and restart the server."
        )

    session = LoginSession(session_id=uuid.uuid4().hex)
    with _sessions_lock:
        # Drop old finished sessions to keep memory small.
        finished = [sid for sid, s in _sessions.items() if s.status in ("success", "failed", "cancelled")]
        for sid in finished[-20:]:
            _sessions.pop(sid, None)
        _sessions[session.session_id] = session

    def _run() -> None:
        try:
            from azure.identity import DeviceCodeCredential
        except ImportError:
            session.status = "failed"
            session.error = "azure-identity is not installed. Run: pip install azure-identity"
            return

        prompt_ready = threading.Event()

        def prompt_callback(verification_uri: str, user_code: str, _expires_on: datetime) -> None:
            session.verification_uri = verification_uri
            session.user_code = user_code
            session.message = (
                f"Open {verification_uri} and enter code {user_code} to sign in with Microsoft."
            )
            session.status = "waiting_user"
            prompt_ready.set()

        credential = DeviceCodeCredential(
            client_id=interactive_client_id(),
            tenant_id=interactive_tenant_id(),
            cache_persistence_options=_cache_options(),
            prompt_callback=prompt_callback,
        )

        try:
            # authenticate() performs device code + stores tokens in persistent cache
            record = credential.authenticate(scopes=[_SCOPE])
            if session._cancel.is_set():
                session.status = "cancelled"
                return
            _save_authentication_record(record)
            meta = {
                "username": getattr(record, "username", None) or "",
                "tenant_id": getattr(record, "tenant_id", None) or interactive_tenant_id(),
                "home_account_id": getattr(record, "home_account_id", None) or "",
                "signed_in_at": datetime.now(timezone.utc).isoformat(),
                "subscription_id": settings.azure_subscription_id.strip(),
                "client_id": interactive_client_id(),
            }
            _save_account_meta(meta)
            session.account = meta
            session.status = "success"
            session.message = f"Signed in as {meta.get('username') or 'Microsoft account'}."
            # Validate we can obtain a management token
            credential.get_token(_SCOPE)
        except Exception as exc:
            if session._cancel.is_set():
                session.status = "cancelled"
            else:
                session.status = "failed"
                session.error = str(exc)
                session.message = f"Azure sign-in failed: {exc}"
                logger.exception("Azure device-code login failed")
        finally:
            prompt_ready.set()

    thread = threading.Thread(target=_run, name=f"azure-login-{session.session_id[:8]}", daemon=True)
    session._thread = thread
    thread.start()

    # Wait briefly so the first poll often already has the user code.
    for _ in range(50):
        if session.status != "pending" or session.user_code:
            break
        if session._cancel.wait(0.1):
            break

    return session


def cancel_login(session_id: str) -> bool:
    session = get_login_session(session_id)
    if not session:
        return False
    session._cancel.set()
    if session.status in ("pending", "waiting_user"):
        session.status = "cancelled"
        session.message = "Sign-in cancelled."
    return True


def status_payload() -> dict[str, Any]:
    meta = load_account_meta()
    signed_in = is_signed_in()
    return {
        "signed_in": signed_in,
        "username": meta.get("username") or None,
        "tenant_id": meta.get("tenant_id") or None,
        "subscription_id": settings.azure_subscription_id.strip() or None,
        "subscription_id_set": bool(settings.azure_subscription_id.strip()),
        "signed_in_at": meta.get("signed_in_at"),
        "client_id": interactive_client_id(),
        "message": (
            f"Signed in as {meta.get('username')}"
            if signed_in and meta.get("username")
            else ("Signed in" if signed_in else "Not signed in")
        ),
    }
