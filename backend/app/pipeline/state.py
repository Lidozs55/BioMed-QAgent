"""Persistent pipeline state for crash recovery and idempotent stage execution."""
from __future__ import annotations

import contextlib
import errno
import hashlib
import json
import os
import re
import time
from datetime import datetime
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any, BinaryIO, Literal

from pydantic import Field, field_validator

from app.domain.contracts import (
    AttemptStatus,
    ContractModel,
    StageAttempt,
    StageName,
    TaskState,
)


class StageOutputFile(ContractModel):
    """One file bound to a persisted stage-output checkpoint."""

    relative_path: str
    size_bytes: int = Field(ge=0)
    sha256: str

    @field_validator("relative_path")
    @classmethod
    def validate_relative_path(cls, value: str) -> str:
        path = PurePosixPath(value)
        if (
            not value
            or "\\" in value
            or path.is_absolute()
            or PureWindowsPath(value).is_absolute()
            or ".." in path.parts
        ):
            raise ValueError("checkpoint file path must stay relative to task root")
        return path.as_posix()

    @field_validator("sha256")
    @classmethod
    def validate_sha256(cls, value: str) -> str:
        checksum = value.lower()
        if not re.fullmatch(r"[0-9a-f]{64}", checksum):
            raise ValueError("checkpoint file sha256 must be 64 hexadecimal characters")
        return checksum


class StageOutputEnvelope(ContractModel):
    """Versioned, attempt-bound checkpoint for one typed stage output."""

    schema_version: Literal["1.0"]
    task_id: str
    stage: StageName
    stage_attempt_id: str
    output_digest: str
    output_sha256: str
    output: dict[str, Any]
    files: list[StageOutputFile]

    @field_validator("files")
    @classmethod
    def validate_file_order(
        cls, value: list[StageOutputFile]
    ) -> list[StageOutputFile]:
        paths = [item.relative_path for item in value]
        if paths != sorted(set(paths)):
            raise ValueError("checkpoint files must be sorted and unique by path")
        return value


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
        for attempt in reversed(self.stage_attempts):
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
    state_dir: Path,
    *,
    task_id: str,
    stage: StageName,
    stage_attempt_id: str,
    output_digest: str,
    output: ContractModel,
    files: list[StageOutputFile] | None = None,
) -> None:
    """Serialize a stage's output to ``state/<stage>_output.json`` for recovery.

    All stage outputs are ``ContractModel`` instances; ``os.replace`` is used
    for atomic overwrite.
    """
    state_dir.mkdir(parents=True, exist_ok=True)
    output_file = state_dir / f"{stage.value}_output.json"
    serialized_output = output.model_dump(mode="json")
    envelope = StageOutputEnvelope(
        schema_version="1.0",
        task_id=task_id,
        stage=stage,
        stage_attempt_id=stage_attempt_id,
        output_digest=output_digest,
        output_sha256=_sha256_json(serialized_output),
        output=serialized_output,
        files=files or [],
    )
    payload = envelope.model_dump_json(indent=2)
    tmp = output_file.with_suffix(".json.part")
    tmp.write_text(payload + "\n", "utf-8")
    os.replace(tmp, output_file)


def load_stage_output(
    state_dir: Path,
    *,
    task_root: Path,
    task_id: str,
    stage: StageName,
    stage_attempt_id: str,
    output_digest: str,
    expected_type: type[ContractModel],
) -> tuple[ContractModel, list[StageOutputFile]] | None:
    """Load and validate an attempt-bound typed stage output checkpoint."""
    output_file = state_dir / f"{stage.value}_output.json"
    if not output_file.exists():
        return None
    try:
        envelope = StageOutputEnvelope.model_validate_json(
            output_file.read_text("utf-8")
        )
        if (
            envelope.task_id != task_id
            or envelope.stage is not stage
            or envelope.stage_attempt_id != stage_attempt_id
            or envelope.output_digest != output_digest
            or envelope.output_sha256 != _sha256_json(envelope.output)
        ):
            return None
        root = task_root.resolve()
        for file in envelope.files:
            path = task_root.joinpath(*PurePosixPath(file.relative_path).parts)
            if path.is_symlink():
                return None
            resolved = path.resolve(strict=True)
            resolved.relative_to(root)
            if not resolved.is_file():
                return None
            if resolved.stat().st_size != file.size_bytes:
                return None
            if _sha256_file(resolved) != file.sha256:
                return None
        return expected_type.model_validate(envelope.output), envelope.files
    except Exception:
        return None


def _sha256_json(payload: Any) -> str:
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _sha256_file(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


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
