"""Persistent pipeline state for crash recovery and idempotent stage execution."""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any

from pydantic import Field

from app.domain.contracts import ContractModel, StageAttempt, StageName, TaskState


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
                and attempt.status.value == "succeeded"
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
    """Load pipeline state from disk, or create a fresh CREATED state."""
    state_file = state_dir / "pipeline_state.json"
    if state_file.exists():
        return PipelineState.model_validate_json(state_file.read_text("utf-8"))
    return PipelineState(
        task_id=task_id,
        task_state=TaskState.CREATED,
        started_at=started_at,
    )


def save_state(state_dir: Path, state: PipelineState) -> None:
    """Persist pipeline state to disk atomically."""
    state_dir.mkdir(parents=True, exist_ok=True)
    state_file = state_dir / "pipeline_state.json"
    tmp = state_file.with_suffix(".json.part")
    tmp.write_text(state.model_dump_json(indent=2) + "\n", "utf-8")
    if state_file.exists():
        state_file.unlink()
    tmp.rename(state_file)


def save_stage_output(
    state_dir: Path, stage: StageName, output: Any
) -> None:
    """Serialize a stage's output to ``state/<stage>_output.json`` for recovery."""
    state_dir.mkdir(parents=True, exist_ok=True)
    output_file = state_dir / f"{stage.value}_output.json"

    if hasattr(output, "model_dump_json"):
        payload = output.model_dump_json(indent=2)
    elif hasattr(output, "__dict__"):
        payload = json.dumps(
            _serialize_dataclass(output), indent=2, ensure_ascii=False, default=str
        )
    else:
        payload = json.dumps(output, indent=2, ensure_ascii=False, default=str)

    tmp = output_file.with_suffix(".json.part")
    tmp.write_text(payload + "\n", "utf-8")
    if output_file.exists():
        output_file.unlink()
    tmp.rename(output_file)


def load_stage_output(state_dir: Path, stage: StageName) -> dict[str, Any] | None:
    """Load a serialized stage output from disk (returns None if missing)."""
    output_file = state_dir / f"{stage.value}_output.json"
    if not output_file.exists():
        return None
    return json.loads(output_file.read_text("utf-8"))


def _serialize_dataclass(obj: Any) -> Any:
    """Recursively convert a dataclass to a JSON-serializable dict."""
    if hasattr(obj, "__dict__"):
        result: dict[str, Any] = {}
        for key, value in obj.__dict__.items():
            if hasattr(value, "model_dump"):
                result[key] = value.model_dump(mode="json")
            elif hasattr(value, "__dict__") and not isinstance(
                value, (str, int, float, bool, type(None))
            ):
                result[key] = _serialize_dataclass(value)
            elif isinstance(value, list):
                result[key] = [
                    item.model_dump(mode="json") if hasattr(item, "model_dump")
                    else _serialize_dataclass(item) if hasattr(item, "__dict__")
                    else item
                    for item in value
                ]
            elif isinstance(value, Path):
                result[key] = str(value)
            elif isinstance(value, datetime):
                result[key] = value.isoformat()
            else:
                result[key] = value
        return result
    return obj
