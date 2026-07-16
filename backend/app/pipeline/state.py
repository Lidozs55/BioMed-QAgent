"""Persistent pipeline state for crash recovery and idempotent stage execution."""
from __future__ import annotations

import contextlib
import errno
import json
import os
import time
from datetime import datetime
from pathlib import Path
from typing import Any, BinaryIO

from pydantic import Field

from app.domain.contracts import (
    AttemptStatus,
    ContractModel,
    StageAttempt,
    StageName,
    TaskState,
)


class PipelineState(ContractModel):
    """Pipeline state with append-only finalized stage-attempt history."""

    task_id: str
    task_state: TaskState
    current_stage: StageName | None = None
    cancel_requested: bool = False
    cancel_reason: str | None = None
    started_at: datetime
    stage_attempts: list[StageAttempt] = Field(default_factory=list)
    inflight_attempt: StageAttempt | None = None
    completed_stages: dict[str, str] = Field(default_factory=dict)

    def find_reusable(
        self,
        stage: StageName,
        input_digest: str,
        parameter_digest: str,
    ) -> StageAttempt | None:
        """Find a SUCCEEDED attempt matching the given digests (for idempotency)."""
        for attempt in self.stage_attempts:
            if (
                attempt.stage == stage
                and attempt.status is AttemptStatus.SUCCEEDED
                and attempt.input_digest == input_digest
                and attempt.parameter_digest == parameter_digest
            ):
                return attempt
        return None

    def append_attempt(self, attempt: StageAttempt) -> None:
        """Append a new stage attempt (append-only, never mutate existing)."""
        self.stage_attempts.append(attempt)

    def mark_completed(self, stage: StageName, output_digest: str) -> None:
        """Record that a stage has completed with the given output digest."""
        self.completed_stages[stage.value] = output_digest


def load_state(state_dir: Path, task_id: str, started_at: datetime) -> PipelineState:
    """Load pipeline state from disk, or create a fresh CREATED state.

    Raises ``ValueError`` if the persisted state belongs to a different task_id
    — this guards against workdir reuse or accidental task_id mismatch.
    """
    state_file = state_dir / "pipeline_state.json"
    if state_file.exists():
        loaded = PipelineState.model_validate_json(state_file.read_text("utf-8"))
        if loaded.task_id != task_id:
            raise ValueError(
                f"state task_id mismatch: file has {loaded.task_id!r}, "
                f"requested {task_id!r}"
            )
        return loaded
    return PipelineState(
        task_id=task_id,
        task_state=TaskState.CREATED,
        started_at=started_at,
    )


def save_state(state_dir: Path, state: PipelineState) -> None:
    """Persist pipeline state to disk atomically.

    Uses ``os.replace`` for atomic overwrite on both POSIX and Windows,
    avoiding the window between ``unlink`` and ``rename`` where a crash
    would leave the state file missing.
    """
    state_dir.mkdir(parents=True, exist_ok=True)
    state_file = state_dir / "pipeline_state.json"
    tmp = state_file.with_suffix(".json.part")
    tmp.write_text(state.model_dump_json(indent=2) + "\n", "utf-8")
    os.replace(tmp, state_file)


def save_stage_output(
    state_dir: Path, stage: StageName, output: Any
) -> None:
    """Serialize a stage's output to ``state/<stage>_output.json`` for recovery.

    All stage outputs are ``ContractModel`` instances; ``os.replace`` is used
    for atomic overwrite.
    """
    state_dir.mkdir(parents=True, exist_ok=True)
    output_file = state_dir / f"{stage.value}_output.json"
    payload = output.model_dump_json(indent=2)
    tmp = output_file.with_suffix(".json.part")
    tmp.write_text(payload + "\n", "utf-8")
    os.replace(tmp, output_file)


def load_stage_output(state_dir: Path, stage: StageName) -> dict[str, Any] | None:
    """Load a serialized stage output from disk (returns None if missing)."""
    output_file = state_dir / f"{stage.value}_output.json"
    if not output_file.exists():
        return None
    return json.loads(output_file.read_text("utf-8"))


class TaskLock:
    """OS-backed exclusive lock held by an open diagnostic lock file.

    The stable file is never unlinked. The operating system releases the lock
    automatically when the owning process exits, including abrupt termination.
    Cooperative callers use ``msvcrt.locking`` on Windows and ``fcntl.flock``
    on POSIX.
    """

    _DEFAULT_TIMEOUT: float = 30.0
    _POLL_INTERVAL: float = 0.05

    def __init__(
        self, lock_file: Path, timeout: float = _DEFAULT_TIMEOUT
    ) -> None:
        self.lock_file = Path(lock_file)
        self.timeout = timeout
        self._handle: BinaryIO | None = None

    def acquire(self) -> None:
        """Block until the lock is acquired or ``timeout`` elapses.

        Raises:
            TimeoutError: if the lock cannot be acquired within ``timeout``.
        """
        if self._handle is not None:
            raise RuntimeError("TaskLock.acquire() called while already held")
        self.lock_file.parent.mkdir(parents=True, exist_ok=True)
        flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_BINARY", 0)
        fd = os.open(str(self.lock_file), flags, 0o644)
        handle = os.fdopen(fd, "r+b", buffering=0)
        try:
            if os.fstat(handle.fileno()).st_size == 0:
                handle.write(b"\0")
            deadline = time.monotonic() + self.timeout
            while not _try_acquire_os_lock(handle):
                if time.monotonic() >= deadline:
                    raise TimeoutError(
                        f"could not acquire lock {self.lock_file} "
                        f"within {self.timeout}s"
                    ) from None
                time.sleep(self._POLL_INTERVAL)
            handle.seek(0)
            diagnostic = f"{os.getpid():<31}\n".encode("ascii")
            handle.write(diagnostic)
            handle.truncate(len(diagnostic))
        except BaseException:
            handle.close()
            raise
        self._handle = handle

    def release(self) -> None:
        """Release the OS lock and close its handle, retaining the lock file."""
        handle = self._handle
        if handle is None:
            return
        self._handle = None
        try:
            _release_os_lock(handle)
        finally:
            handle.close()

    def __enter__(self) -> TaskLock:
        self.acquire()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.release()

    def __del__(self) -> None:
        # Best-effort early release; process exit closes the handle regardless.
        with contextlib.suppress(Exception):
            self.release()


_LOCK_BUSY_ERRNOS = {errno.EACCES, errno.EAGAIN, errno.EDEADLK}


def _try_acquire_os_lock(handle: BinaryIO) -> bool:
    handle.seek(0)
    try:
        if os.name == "nt":
            import msvcrt

            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as exc:
        if exc.errno in _LOCK_BUSY_ERRNOS:
            return False
        raise
    return True


def _release_os_lock(handle: BinaryIO) -> None:
    handle.seek(0)
    if os.name == "nt":
        import msvcrt

        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
    else:
        import fcntl

        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
