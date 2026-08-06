"""Persistent build state for crash recovery and idempotent operation reuse.

Mirrors the V1 pipeline checkpoint semantics (atomic writes, file hash
verification, append-only attempt prefix validation) but keyed by operation
instead of stage — ARCHITECTURE §5.1; Design §12.2.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
from typing import Any

from pydantic import Field, field_validator

from app.datasets.runtime.operations import OperationAttempt
from app.domain.contracts.base import ContractModel
from app.domain.contracts.enums import AttemptStatus
from app.pipeline.state import StageOutputFile


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


def _operation_filename(operation_id: str) -> str:
    """Map an operation id to a safe file stem (ids may contain ':')."""
    return operation_id.replace(":", "_")


class BuildState(ContractModel):
    """Build execution state with append-only operation-attempt history."""

    task_id: str
    build_id: str
    operation_attempts: list[OperationAttempt] = Field(default_factory=list)
    inflight_attempt: OperationAttempt | None = None
    completed_operations: dict[str, str] = Field(default_factory=dict)

    def find_reusable(
        self,
        operation_id: str,
        input_digest: str,
        parameter_digest: str,
    ) -> OperationAttempt | None:
        """Find a SUCCEEDED attempt matching the given digests (idempotency)."""
        for attempt in reversed(self.operation_attempts):
            if (
                attempt.operation_id == operation_id
                and attempt.status is AttemptStatus.SUCCEEDED
                and attempt.input_digest == input_digest
                and attempt.parameter_digest == parameter_digest
            ):
                return attempt
        return None

    def append_attempt(self, attempt: OperationAttempt) -> None:
        """Append a new operation attempt (append-only, never mutate existing)."""
        self.operation_attempts.append(attempt)

    def mark_completed(self, operation_id: str, output_digest: str) -> None:
        self.completed_operations[operation_id] = output_digest


def load_build_state(state_dir: Path, task_id: str, build_id: str) -> BuildState:
    """Load build state from disk, or create a fresh one.

    Raises ``ValueError`` on task/build id mismatch to guard against workdir
    reuse or accidental id confusion.
    """
    state_file = state_dir / "build_state.json"
    if state_file.exists():
        loaded = BuildState.model_validate_json(state_file.read_text("utf-8"))
        if loaded.task_id != task_id or loaded.build_id != build_id:
            raise ValueError(
                f"build state id mismatch: file has "
                f"{loaded.task_id!r}/{loaded.build_id!r}, requested "
                f"{task_id!r}/{build_id!r}"
            )
        return loaded
    return BuildState(task_id=task_id, build_id=build_id)


def save_build_state(state_dir: Path, state: BuildState) -> None:
    """Persist build state atomically via ``os.replace``."""
    state_dir.mkdir(parents=True, exist_ok=True)
    state_file = state_dir / "build_state.json"
    tmp = state_file.with_suffix(".json.part")
    tmp.write_text(state.model_dump_json(indent=2) + "\n", "utf-8")
    os.replace(tmp, state_file)


class OperationOutputEnvelope(ContractModel):
    """Versioned, attempt-bound checkpoint for one operation output."""

    task_id: str
    build_id: str
    operation_id: str
    operation_attempt_id: str
    output_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    output_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    output: dict[str, Any]
    files: list[StageOutputFile] = Field(default_factory=list)

    @field_validator("files")
    @classmethod
    def validate_file_order(
        cls, value: list[StageOutputFile]
    ) -> list[StageOutputFile]:
        paths = [item.relative_path for item in value]
        if paths != sorted(set(paths)):
            raise ValueError("checkpoint files must be sorted and unique by path")
        return value


def save_operation_output(
    state_dir: Path,
    *,
    task_id: str,
    build_id: str,
    operation_id: str,
    operation_attempt_id: str,
    output_digest: str,
    output: dict[str, Any],
    files: list[StageOutputFile] | None = None,
) -> None:
    """Serialize one operation output to ``state/<operation_id>_output.json``."""
    state_dir.mkdir(parents=True, exist_ok=True)
    output_file = state_dir / f"{_operation_filename(operation_id)}_output.json"
    envelope = OperationOutputEnvelope(
        task_id=task_id,
        build_id=build_id,
        operation_id=operation_id,
        operation_attempt_id=operation_attempt_id,
        output_digest=output_digest,
        output_sha256=_sha256_json(output),
        output=output,
        files=files or [],
    )
    payload = envelope.model_dump_json(indent=2)
    tmp = output_file.with_suffix(".json.part")
    tmp.write_text(payload + "\n", "utf-8")
    os.replace(tmp, output_file)


def load_operation_output(
    state_dir: Path,
    *,
    task_root: Path,
    task_id: str,
    build_id: str,
    operation_id: str,
    operation_attempt_id: str,
    output_digest: str,
) -> dict[str, Any] | None:
    """Load and validate an attempt-bound operation output checkpoint.

    Returns ``None`` when the checkpoint is missing, belongs to a different
    task/build/attempt, fails digest or file hash verification, or references
    files that no longer match.
    """
    output_file = state_dir / f"{_operation_filename(operation_id)}_output.json"
    if not output_file.exists():
        return None
    try:
        envelope = OperationOutputEnvelope.model_validate_json(
            output_file.read_text("utf-8")
        )
        if (
            envelope.task_id != task_id
            or envelope.build_id != build_id
            or envelope.operation_id != operation_id
            or envelope.operation_attempt_id != operation_attempt_id
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
        return envelope.output
    except Exception:
        return None


def validate_attempt_log_prefix(state: BuildState, attempts_path: Path) -> int:
    """Validate that ``attempts.jsonl`` is an exact prefix of durable state.

    Returns the number of persisted records (used for incremental appends).
    Raises ``ValueError`` on a gap or mismatch — a crash must never leave an
    append-only log diverged from the state projection.
    """
    from app.runtime.event_store import read_jsonl

    records = read_jsonl(attempts_path).records
    if len(records) > len(state.operation_attempts):
        raise ValueError("operation attempt log is ahead of durable state")
    for index, (_, value) in enumerate(records):
        persisted = OperationAttempt.model_validate(value)
        if persisted != state.operation_attempts[index]:
            raise ValueError("operation attempt log is not a durable state prefix")
    return len(records)
