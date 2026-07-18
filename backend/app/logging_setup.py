"""Persist application logs so freeze/crash reports still have evidence after restart."""

from __future__ import annotations

import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path

from app.config import settings

_SERVER_LOG_NAME = "server.log"
_configured = False


def server_log_path() -> Path:
    log_dir = Path(settings.data_root) / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    return log_dir / _SERVER_LOG_NAME


def setup_logging() -> Path:
    """Attach a rotating file handler to the root and uvicorn loggers (once)."""
    global _configured
    path = server_log_path()
    if _configured:
        return path

    handler = RotatingFileHandler(
        path,
        maxBytes=5_000_000,
        backupCount=5,
        encoding="utf-8",
    )
    handler.setFormatter(
        logging.Formatter("%(asctime)s %(levelname)s [%(name)s] %(message)s")
    )
    handler.setLevel(logging.INFO)

    root = logging.getLogger()
    root.setLevel(logging.INFO)
    if not any(
        isinstance(h, RotatingFileHandler) and getattr(h, "baseFilename", None) == str(path)
        for h in root.handlers
    ):
        root.addHandler(handler)

    for name in ("uvicorn", "uvicorn.error", "uvicorn.access", "fastapi"):
        logger = logging.getLogger(name)
        logger.setLevel(logging.INFO)
        if handler not in logger.handlers:
            logger.addHandler(handler)
        logger.propagate = True

    _configured = True
    logging.getLogger(__name__).info("Server file logging enabled at %s", path)
    return path


def read_log_tail(path: Path | None, max_bytes: int = 80_000) -> str:
    if path is None or not path.is_file():
        return ""
    try:
        size = path.stat().st_size
        with open(path, "rb") as f:
            if size > max_bytes:
                f.seek(size - max_bytes)
                data = f.read()
                text = data.decode("utf-8", errors="replace")
                nl = text.find("\n")
                if nl >= 0:
                    text = text[nl + 1 :]
                return text
            return f.read().decode("utf-8", errors="replace")
    except OSError:
        return ""
