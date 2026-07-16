"""Persistent pipeline state for crash recovery and idempotent stage execution."""
from __future__ import annotations

import contextlib
import json
import os
import time
from datetime import datetime
from pathlib import Path
from typing import Any

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
    """File-based exclusive lock for the publish step (TODO §8 line 276).

    Uses ``O_CREAT | O_EXCL`` atomic file creation: on both POSIX and Windows,
    only one caller can create the lockfile; concurrent callers receive
    ``FileExistsError`` and retry until the holder releases (deletes) the file
    or ``timeout`` elapses, in which case ``TimeoutError`` is raised.

    The lock is advisory (cooperative) — it protects the atomic publish step
    against concurrent publishers in the same workdir (e.g. a recovery run
    racing with a stuck prior process). It does NOT protect against external
    writers that bypass the lock.
    """

    _DEFAULT_TIMEOUT: float = 30.0
    _POLL_INTERVAL: float = 0.05

    def __init__(
        self, lock_file: Path, timeout: float = _DEFAULT_TIMEOUT
    ) -> None:
        self.lock_file = Path(lock_file)
        self.timeout = timeout
        self._held = False

    def acquire(self) -> None:
        """Block until the lock is acquired or ``timeout`` elapses.

        Raises:
            TimeoutError: if the lock cannot be acquired within ``timeout``.
        """
        if self._held:
            raise RuntimeError("TaskLock.acquire() called while already held")
        deadline = time.monotonic() + self.timeout
        while True:
            self.lock_file.parent.mkdir(parents=True, exist_ok=True)
            try:
                fd = os.open(
                    str(self.lock_file),
                    os.O_CREAT | os.O_EXCL | os.O_WRONLY,
                    0o644,
                )
            except FileExistsError:
                if time.monotonic() >= deadline:
                    raise TimeoutError(
                        f"could not acquire lock {self.lock_file} "
                        f"within {self.timeout}s"
                    ) from None
                time.sleep(self._POLL_INTERVAL)
                continue
            # Write the holder PID for diagnostics; the lock is still enforced
            # by the existence of the file, not by its contents.
            try:
                os.write(fd, str(os.getpid()).encode("ascii"))
            finally:
                os.close(fd)
            self._held = True
            return

    def release(self) -> None:
        """Release the lock by removing the lockfile.

        Silently no-ops if the lock is not held or the file is already gone,
        so callers can safely invoke ``release()`` in a ``finally`` block even
        if ``acquire()`` raised.
        """
        if not self._held:
            return
        self._held = False
        with contextlib.suppress(FileNotFoundError):
            self.lock_file.unlink()

    def __enter__(self) -> TaskLock:
        self.acquire()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.release()

    def __del__(self) -> None:
        # Best-effort cleanup so a forgotten release does not leak the lock
        # until process exit. DO NOT rely on this for correctness.
        with contextlib.suppress(Exception):
            self.release()
