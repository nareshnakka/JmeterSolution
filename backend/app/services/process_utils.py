"""Force-stop JMeter and child Java processes (Windows-safe)."""

from __future__ import annotations

import subprocess
import time

import psutil

_CREATE_NO_WINDOW = subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0


def _is_jmeter_java(proc: psutil.Process) -> bool:
    try:
        if proc.name().lower() not in ("java.exe", "java"):
            return False
        cmdline = " ".join(proc.cmdline()).lower()
        return "apache.jmeter" in cmdline or "jmeter" in cmdline
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return False


def resolve_jmeter_pid(root_pid: int) -> int:
    """Prefer the Java JMeter worker PID over the jmeter.bat/cmd wrapper."""
    if root_pid <= 0:
        return root_pid
    try:
        root = psutil.Process(root_pid)
    except psutil.NoSuchProcess:
        return root_pid

    for proc in root.children(recursive=True):
        if _is_jmeter_java(proc):
            return proc.pid
    return root_pid


def kill_process_tree(pid: int, *, force: bool = True, timeout: float = 8.0) -> None:
    """Kill a process and all descendants. Uses taskkill /T on Windows as fallback."""
    if pid <= 0:
        return

    targets: list[psutil.Process] = []
    try:
        root = psutil.Process(pid)
        targets = root.children(recursive=True) + [root]
    except psutil.NoSuchProcess:
        _taskkill_tree(pid)
        return

    alive: list[psutil.Process] = []
    for proc in targets:
        try:
            if force:
                proc.kill()
            else:
                proc.terminate()
            alive.append(proc)
        except psutil.NoSuchProcess:
            pass
        except psutil.AccessDenied:
            alive.append(proc)

    if alive:
        _, alive = psutil.wait_procs(alive, timeout=timeout)
        for proc in alive:
            try:
                proc.kill()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
        psutil.wait_procs(alive, timeout=3)

    if _process_alive(pid):
        _taskkill_tree(pid)


def _process_alive(pid: int) -> bool:
    try:
        proc = psutil.Process(pid)
        return proc.is_running() and proc.status() != psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return False


def is_process_alive(pid: int) -> bool:
    return _process_alive(pid)


def detached_creation_flags() -> int:
    """
    Launch JMeter outside the uvicorn process tree so stopping/updating the
    API server does not kill an in-progress load test.

    Avoid DETACHED_PROCESS — it breaks stdout redirect to the console log file.
    """
    flags = 0
    if hasattr(subprocess, "CREATE_NO_WINDOW"):
        flags |= subprocess.CREATE_NO_WINDOW
    if hasattr(subprocess, "CREATE_NEW_PROCESS_GROUP"):
        flags |= subprocess.CREATE_NEW_PROCESS_GROUP
    # Break away from the parent Job Object (uvicorn) when present.
    flags |= 0x01000000  # CREATE_BREAKAWAY_FROM_JOB
    return flags


def _taskkill_tree(pid: int) -> None:
    try:
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(pid)],
            capture_output=True,
            creationflags=_CREATE_NO_WINDOW,
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        pass


def wait_for_process_exit(pid: int, timeout: float = 10.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not _process_alive(pid):
            return True
        time.sleep(0.2)
    return not _process_alive(pid)


def ensure_jmeter_stopped(root_pid: int, jmeter_pid: int | None = None) -> None:
    """Force-kill wrapper and JMeter Java if still running."""
    for pid in {root_pid, jmeter_pid or 0}:
        if pid > 0 and _process_alive(pid):
            kill_process_tree(pid, force=True)
