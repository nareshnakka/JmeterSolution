"""Report Bug API — opens a GitHub Issue with logs and optional screenshot."""

from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.services import bug_report as bug_report_service

router = APIRouter(prefix="/api/bug-reports", tags=["bug-reports"])


class BugReportStatusOut(BaseModel):
    configured: bool
    repo: str


class BugReportOut(BaseModel):
    ok: bool = True
    issue_number: int
    issue_url: str
    files_uploaded: list[str] = Field(default_factory=list)


@router.get("/status", response_model=BugReportStatusOut)
def bug_report_status():
    from app.config import settings

    return BugReportStatusOut(
        configured=bug_report_service.github_configured(),
        repo=(settings.github_repo or "").strip(),
    )


@router.post("", response_model=BugReportOut)
async def create_bug_report(
    title: str = Form(...),
    description: str = Form(""),
    run_id: int | None = Form(default=None),
    page_url: str | None = Form(default=None),
    user_agent: str | None = Form(default=None),
    screenshot: UploadFile | None = File(default=None),
    db: Session = Depends(get_db),
):
    if not bug_report_service.github_configured():
        raise HTTPException(
            503,
            "Report Bug is not configured. Set GITHUB_TOKEN in the server .env "
            "(classic PAT with repo scope), then restart the server.",
        )

    shot_bytes: bytes | None = None
    shot_name: str | None = None
    if screenshot is not None and screenshot.filename:
        shot_bytes = await screenshot.read()
        shot_name = screenshot.filename
        if not shot_bytes:
            shot_bytes = None

    try:
        result = bug_report_service.submit_bug_report(
            db,
            title=title,
            description=description or "",
            run_id=run_id,
            page_url=page_url,
            user_agent=user_agent,
            screenshot=shot_bytes,
            screenshot_name=shot_name,
        )
    except RuntimeError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(500, f"Failed to create bug report: {exc}") from exc

    return BugReportOut(
        issue_number=result.issue_number,
        issue_url=result.issue_url,
        files_uploaded=result.files_uploaded,
    )
