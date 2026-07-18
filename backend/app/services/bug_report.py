"""Collect diagnostics and open a GitHub Issue (bug) with logs + optional screenshot."""

from __future__ import annotations

import base64
import json
import logging
import platform
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from app.config import settings
from app.logging_setup import read_log_tail, server_log_path
from app.models import TestRun, TestRunStatus
from app.services.run_artifacts import resolve_log_path, resolve_run_file
from app.services.update_manager import GITHUB_BRANCH
from app.version import version_label

logger = logging.getLogger(__name__)

MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024
MAX_LOG_FILE_BYTES = 200_000
USER_AGENT = "JMeterAgent-Server-BugReport"
# Keep diagnostic file commits off main so product history stays clean.
BUG_REPORTS_BRANCH = "bug-reports"


@dataclass
class BugReportResult:
    issue_number: int
    issue_url: str
    files_uploaded: list[str]


def github_configured() -> bool:
    return bool((settings.github_token or "").strip())


def _repo() -> str:
    return (settings.github_repo or "nareshnakka/JmeterSolution").strip()


def _slug(text: str, max_len: int = 40) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9_-]+", "-", (text or "bug").strip().lower())
    cleaned = cleaned.strip("-") or "bug"
    return cleaned[:max_len]


def _github_request(
    method: str,
    api_path: str,
    *,
    body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    token = (settings.github_token or "").strip()
    if not token:
        raise RuntimeError(
            "GITHUB_TOKEN is not configured. Add it to the server .env to enable Report Bug."
        )
    url = f"https://api.github.com{api_path}"
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": USER_AGENT,
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"GitHub API {method} {api_path} failed ({exc.code}): {detail}") from exc


def _ensure_bug_reports_branch() -> str:
    """Ensure bug-reports branch exists (forked from default branch)."""
    repo = _repo()
    try:
        _github_request("GET", f"/repos/{repo}/git/ref/heads/{BUG_REPORTS_BRANCH}")
        return BUG_REPORTS_BRANCH
    except RuntimeError:
        pass

    try:
        main_ref = _github_request("GET", f"/repos/{repo}/git/ref/heads/{GITHUB_BRANCH}")
        sha = main_ref.get("object", {}).get("sha")
        if not sha:
            raise RuntimeError("Could not resolve default branch SHA for bug-reports branch")
        _github_request(
            "POST",
            f"/repos/{repo}/git/refs",
            body={"ref": f"refs/heads/{BUG_REPORTS_BRANCH}", "sha": sha},
        )
    except RuntimeError as exc:
        logger.warning("Could not create %s branch (%s); falling back to %s", BUG_REPORTS_BRANCH, exc, GITHUB_BRANCH)
        return GITHUB_BRANCH
    return BUG_REPORTS_BRANCH


def _upload_repo_file(path_in_repo: str, content: bytes, message: str, branch: str) -> str:
    """Create or update a file on the given branch via Contents API. Returns html_url."""
    encoded = base64.b64encode(content).decode("ascii")
    payload: dict[str, Any] = {
        "message": message,
        "content": encoded,
        "branch": branch,
    }
    try:
        existing = _github_request(
            "GET",
            f"/repos/{_repo()}/contents/{path_in_repo}?ref={branch}",
        )
        if isinstance(existing, dict) and existing.get("sha"):
            payload["sha"] = existing["sha"]
    except RuntimeError:
        pass

    result = _github_request(
        "PUT",
        f"/repos/{_repo()}/contents/{path_in_repo}",
        body=payload,
    )
    content_meta = result.get("content") if isinstance(result, dict) else None
    if isinstance(content_meta, dict) and content_meta.get("html_url"):
        return str(content_meta["html_url"])
    return f"https://github.com/{_repo()}/blob/{branch}/{path_in_repo}"


def _pick_run(db: Session, run_id: int | None) -> TestRun | None:
    if run_id is not None:
        return db.get(TestRun, run_id)
    running = (
        db.query(TestRun)
        .filter(TestRun.status == TestRunStatus.RUNNING)
        .order_by(TestRun.id.desc())
        .first()
    )
    if running:
        return running
    return db.query(TestRun).order_by(TestRun.id.desc()).first()


def _collect_run_logs(run: TestRun | None) -> dict[str, str]:
    out: dict[str, str] = {}
    if run is None:
        return out
    jmeter = resolve_log_path(run)
    console = resolve_run_file(run, "jmeter-console.log")
    if jmeter:
        text = read_log_tail(jmeter, MAX_LOG_FILE_BYTES)
        if text.strip():
            out["jmeter.log"] = text
    if console:
        text = read_log_tail(console, MAX_LOG_FILE_BYTES)
        if text.strip():
            out["jmeter-console.log"] = text
    return out


def _diagnostics_markdown(
    *,
    title: str,
    description: str,
    run: TestRun | None,
    page_url: str | None,
    user_agent: str | None,
    uploaded: dict[str, str],
) -> str:
    lines = [
        "## Summary",
        description.strip() or "(no description provided)",
        "",
        "## Environment",
        f"- **App version:** {version_label()}",
        f"- **Host:** {platform.node()}",
        f"- **OS:** {platform.platform()}",
        f"- **Python:** {platform.python_version()}",
        f"- **Reported at (UTC):** {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')}",
    ]
    if page_url:
        lines.append(f"- **Page URL:** {page_url}")
    if user_agent:
        lines.append(f"- **Browser:** `{user_agent}`")
    if run is not None:
        lines.extend(
            [
                "",
                "## Related test run",
                f"- **Run ID:** `{run.id}`",
                f"- **Status:** `{run.status.value if hasattr(run.status, 'value') else run.status}`",
                f"- **Scenario ID:** `{run.scenario_id}`",
                f"- **JTL:** `{run.jtl_path or 'n/a'}`",
                f"- **Log:** `{run.log_path or 'n/a'}`",
            ]
        )
    if uploaded:
        lines.extend(["", "## Attachments"])
        for name, url in uploaded.items():
            lines.append(f"- [{name}]({url})")
    lines.extend(
        [
            "",
            "---",
            f"_Filed via JMeter Agent **Report Bug** ({title})_",
        ]
    )
    return "\n".join(lines)


def submit_bug_report(
    db: Session,
    *,
    title: str,
    description: str,
    run_id: int | None = None,
    page_url: str | None = None,
    user_agent: str | None = None,
    screenshot: bytes | None = None,
    screenshot_name: str | None = None,
) -> BugReportResult:
    if not github_configured():
        raise RuntimeError(
            "GITHUB_TOKEN is not configured. Add it to the server .env to enable Report Bug."
        )

    clean_title = (title or "").strip() or "Bug report from JMeter Agent"
    if len(clean_title) > 120:
        clean_title = clean_title[:117] + "..."

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    folder = f"bug-reports/{stamp}-{_slug(clean_title)}"
    run = _pick_run(db, run_id)
    uploaded: dict[str, str] = {}
    branch = _ensure_bug_reports_branch()

    server_tail = read_log_tail(server_log_path(), MAX_LOG_FILE_BYTES)
    if server_tail.strip():
        url = _upload_repo_file(
            f"{folder}/server.log",
            server_tail.encode("utf-8"),
            f"bug-report: server.log for {clean_title}",
            branch,
        )
        uploaded["server.log"] = url

    for name, text in _collect_run_logs(run).items():
        url = _upload_repo_file(
            f"{folder}/{name}",
            text.encode("utf-8"),
            f"bug-report: {name} for {clean_title}",
            branch,
        )
        uploaded[name] = url

    if screenshot:
        if len(screenshot) > MAX_SCREENSHOT_BYTES:
            raise RuntimeError(
                f"Screenshot is too large (max {MAX_SCREENSHOT_BYTES // (1024 * 1024)} MB)."
            )
        screenshot_ext = Path(screenshot_name or "screenshot.png").suffix.lower() or ".png"
        if screenshot_ext not in {".png", ".jpg", ".jpeg", ".webp", ".gif"}:
            screenshot_ext = ".png"
        shot_name = f"screenshot{screenshot_ext}"
        url = _upload_repo_file(
            f"{folder}/{shot_name}",
            screenshot,
            f"bug-report: screenshot for {clean_title}",
            branch,
        )
        uploaded[shot_name] = url

    meta = {
        "title": clean_title,
        "version": version_label(),
        "run_id": run.id if run else None,
        "page_url": page_url,
        "files": list(uploaded.keys()),
        "branch": branch,
        "reported_at": datetime.now(timezone.utc).isoformat(),
    }
    meta_url = _upload_repo_file(
        f"{folder}/meta.json",
        json.dumps(meta, indent=2).encode("utf-8"),
        f"bug-report: meta for {clean_title}",
        branch,
    )
    uploaded["meta.json"] = meta_url

    body = _diagnostics_markdown(
        title=clean_title,
        description=description,
        run=run,
        page_url=page_url,
        user_agent=user_agent,
        uploaded=uploaded,
    )
    shot_key = next((k for k in uploaded if k.startswith("screenshot")), None)
    if shot_key:
        raw = (
            f"https://raw.githubusercontent.com/{_repo()}/{branch}/"
            f"{folder}/{shot_key}"
        )
        body += f"\n\n## Screenshot\n\n![screenshot]({raw})\n"

    issue_payload: dict[str, Any] = {
        "title": f"[Bug] {clean_title}",
        "body": body,
        "labels": ["bug"],
    }
    try:
        issue = _github_request("POST", f"/repos/{_repo()}/issues", body=issue_payload)
    except RuntimeError as exc:
        # Label may not exist yet — retry without labels.
        if "labels" in str(exc).lower() or "422" in str(exc):
            issue_payload.pop("labels", None)
            issue = _github_request("POST", f"/repos/{_repo()}/issues", body=issue_payload)
        else:
            raise
    number = int(issue.get("number") or 0)
    html_url = str(issue.get("html_url") or f"https://github.com/{_repo()}/issues/{number}")
    logger.info("Created GitHub issue #%s for bug report: %s", number, html_url)
    return BugReportResult(
        issue_number=number,
        issue_url=html_url,
        files_uploaded=list(uploaded.keys()),
    )
