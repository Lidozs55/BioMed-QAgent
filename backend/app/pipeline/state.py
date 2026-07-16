"""Persistent pipeline state for crash recovery and idempotent stage execution."""
from __future__ import annotations

import hashlib
import json
import os
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
    """Append-only pipeline state persisted to ``state/pipeline_state.json``."""

    task_id: str
    task_state: TaskState
    current_stage: StageName | None = None
    cancel_requested: bool = False
    cancel_reason: str | None = None
    started_at: datetime
    stage_attempts: list[StageAttempt] = Field(default_factory=list)
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
                and self.completed_stages.get(stage.value) == attempt.output_digest
            ):
                return attempt
        return None

    def append_attempt(self, attempt: StageAttempt) -> None:
        """Append a new stage attempt (append-only, never mutate existing)."""
        self.stage_attempts.append(attempt)

    def next_attempt_number(self, stage: StageName) -> int:
        """Return the next task-local attempt number for one stage."""
        return max(
            (
                attempt.attempt
                for attempt in self.stage_attempts
                if attempt.stage is stage
            ),
            default=0,
        ) + 1

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
    stage: StageName,
    output: Any,
    output_digest: str,
) -> None:
    """Serialize a stage's output to ``state/<stage>_output.json`` for recovery.

    All stage outputs are ``ContractModel`` instances; ``os.replace`` is used
    for atomic overwrite.
    """
    state_dir.mkdir(parents=True, exist_ok=True)
    output_file = state_dir / f"{stage.value}_output.json"
    serialized_output = output.model_dump(mode="json")
    payload = json.dumps(
        {
            "schema_version": 1,
            "output_digest": output_digest,
            "serialized_output_sha256": _sha256_json(serialized_output),
            "output": serialized_output,
        },
        ensure_ascii=False,
        indent=2,
        sort_keys=True,
    )
    tmp = output_file.with_suffix(".json.part")
    tmp.write_text(payload + "\n", "utf-8")
    os.replace(tmp, output_file)


def load_stage_output(
    state_dir: Path,
    stage: StageName,
    expected_output_digest: str,
) -> dict[str, Any] | None:
    """Load output only when its semantic and serialized digests still match."""
    output_file = state_dir / f"{stage.value}_output.json"
    if not output_file.exists():
        return None
    try:
        payload = json.loads(output_file.read_text("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    if (
        not isinstance(payload, dict)
        or payload.get("schema_version") != 1
        or payload.get("output_digest") != expected_output_digest
    ):
        return None
    output = payload.get("output")
    if not isinstance(output, dict):
        return None
    if payload.get("serialized_output_sha256") != _sha256_json(output):
        return None
    return output


def _sha256_json(payload: Any) -> str:
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()
