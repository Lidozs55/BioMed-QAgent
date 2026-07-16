"""HTTP API routes — databases, tasks, and artifact access.

Endpoints:
    GET /api/v1/databases                 → list available databases from skills
    GET /api/v1/tasks/{task_id}           → task status and directory map
    GET /api/v1/tasks/{task_id}/artifacts → list artifact files
    GET /api/v1/tasks/{task_id}/artifacts/{filename:path} → download artifact
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import Field, ValidationError, field_validator, model_validator

from app.config import settings
from app.domain.contracts import (
    ContractModel,
    Database,
    EventEnvelope,
    RunManifest,
    TaskState,
    generate_prefixed_uuid,
)
from app.pipeline.runner import PipelineRunner
from app.skills.registry import SkillCategory, skill_registry

router = APIRouter(prefix="/api/v1")

# ---------------------------------------------------------------------------
# Display name mapping (skill name → human-readable)
# ---------------------------------------------------------------------------
_SKILL_DISPLAY_NAMES: dict[str, str] = {
    "pubmed": "PubMed",
    "geo": "GEO",
    "gdc": "GDC",
    "pdb": "PDB",
    "xena": "Xena",
    "literature_understanding": "Literature Understanding",
    "pdf_extraction": "PDF Extraction",
    "browser_fallback": "Browser Fallback",
    "self_evolution": "Self Evolution",
    "analysis": "Analysis",
}


def _display_name(skill_name: str) -> str:
    """Return a human-readable name for a skill."""
    return _SKILL_DISPLAY_NAMES.get(skill_name, skill_name.replace("_", " ").title())


def _load_database_skills() -> None:
    """Register the stable user-selectable database integrations."""
    import app.skills.builtin.acquisition.gdc  # noqa: F401
    import app.skills.builtin.acquisition.geo  # noqa: F401
    import app.skills.builtin.acquisition.pdb  # noqa: F401
    import app.skills.builtin.acquisition.xena  # noqa: F401
    import app.skills.builtin.discovery.pubmed  # noqa: F401


def _tasks_base() -> Path:
    """Return the base directory for task data."""
    return Path(settings.output_dir) / "tasks"


class CreateTaskRequest(ContractModel):
    topic: str = Field(min_length=1)
    databases: list[Database]
    mode: Literal["fixture"] = "fixture"

    @field_validator("topic", mode="before")
    @classmethod
    def strip_topic(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @model_validator(mode="after")
    def validate_fixture_sources(self) -> CreateTaskRequest:
        if set(self.databases) != {Database.PUBMED, Database.GEO}:
            raise ValueError("fixture mode supports exactly pubmed and geo")
        if len(self.databases) != 2:
            raise ValueError("fixture databases must not contain duplicates")
        return self


# ---------------------------------------------------------------------------
# Databases
# ---------------------------------------------------------------------------


@router.get("/databases")
async def get_databases() -> dict:
    """List all available databases derived from enabled skills."""
    _load_database_skills()
    skills = [
        skill
        for skill in skill_registry.list_enabled()
        if skill.supported_sources
        and (skill.category == SkillCategory.ACQUISITION or skill.name == "pubmed")
        and skill.name != "browser_fallback"
        and skill.name in {"pubmed", "geo"}
    ]
    databases = []
    for skill in skills:
        databases.append(
            {
                "id": skill.name,
                "name": _display_name(skill.name),
                "category": skill.category.value,
                "description": skill.description,
            }
        )
    return {"databases": databases}


# ---------------------------------------------------------------------------
# Task status
# ---------------------------------------------------------------------------


def _task_status(task_dir: Path) -> str:
    """Conservative task status when no valid manifest is available.

    Only the persisted ``RunManifest.task_state`` is authoritative. When the
    manifest is missing we must NOT infer ``completed`` from directory contents
    — leftover mock artifacts would otherwise be misreported as success.
    """
    if not task_dir.exists():
        return "not_found"
    artifacts_dir = task_dir / "artifacts"
    if artifacts_dir.exists() and any(artifacts_dir.iterdir()):
        # Artifacts exist without a valid manifest → inconsistent state.
        return "failed"
    return "running"


@router.post("/tasks", status_code=201)
async def create_task(request: CreateTaskRequest) -> dict:
    """Run the approved deterministic fixture pipeline as an explicit mode."""

    task_id = generate_prefixed_uuid("task")
    fixture_dir = (
        Path(__file__).parents[2] / "tests" / "fixtures" / "ncbi" / "gse178352"
    )
    runner = PipelineRunner(
        task_id=task_id,
        base_dir=_tasks_base(),
        fixture_dir=fixture_dir,
        topic=request.topic,
        mode=request.mode,
    )
    manifest = await runner.run()
    return {"task_id": task_id, "status": manifest.task_state.value}


class CancelTaskRequest(ContractModel):
    reason: str | None = None


@router.post("/tasks/{task_id}/cancel", status_code=202)
async def cancel_task(task_id: str, request: CancelTaskRequest) -> dict:
    """Request cancellation of a running or pending task.

    Sets ``cancel_requested`` on the persisted pipeline state. The pipeline
    checks this flag before each stage and transitions to CANCELLED. If the
    task is already terminal, this is a no-op.
    """
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", task_id):
        raise HTTPException(status_code=400, detail="invalid task_id")

    task_dir = _tasks_base() / task_id
    if not task_dir.exists():
        raise HTTPException(status_code=404, detail="task not found")

    state_file = task_dir / "state" / "pipeline_state.json"
    if not state_file.is_file():
        raise HTTPException(status_code=409, detail="task has no pipeline state")

    from datetime import UTC, datetime

    from app.pipeline.state import load_state, save_state

    state = load_state(state_file.parent, task_id, datetime.now(UTC))
    if state.task_state in {TaskState.COMPLETED, TaskState.FAILED, TaskState.CANCELLED}:
        return {"task_id": task_id, "status": state.task_state.value, "cancelled": False}
    state.cancel_requested = True
    state.cancel_reason = request.reason
    save_state(state_file.parent, state)
    return {"task_id": task_id, "status": "cancelling", "cancelled": True}


@router.get("/tasks/{task_id}")
async def get_task(task_id: str) -> dict:
    """Return typed state derived from the persisted valid manifest."""
    loaded = _load_validated_manifest(task_id)
    if loaded is None:
        task_dir = _tasks_base() / task_id
        return {
            "task_id": task_id,
            "status": _task_status(task_dir),
            "current_stage": None,
            "validation_status": None,
            "artifact_count": 0,
            "mode": None,
            "live_accepted": None,
        }
    manifest, _ = loaded
    return {
        "task_id": task_id,
        "status": manifest.task_state.value,
        "current_stage": "validation",
        "validation_status": manifest.validation.status,
        "artifact_count": len(manifest.artifacts) + 1,
        "mode": manifest.mode,
        "live_accepted": manifest.live_accepted,
    }


# ---------------------------------------------------------------------------
# Event replay (resume by sequence)
# ---------------------------------------------------------------------------


@router.get("/tasks/{task_id}/events")
async def list_events(task_id: str, since: int = 0) -> dict:
    """Replay persisted events with sequence > ``since``.

    Reads the append-only ``logs/events.jsonl`` written by PipelineRunner.
    A WS reconnect can resume by passing the last seen sequence as ``since``.
    Returns 404 if the task directory does not exist; returns an empty list
    if no events have been persisted yet.
    """
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", task_id):
        raise HTTPException(status_code=400, detail="invalid task_id")
    if since < 0:
        raise HTTPException(status_code=400, detail="since must be >= 0")

    task_dir = _tasks_base() / task_id
    if not task_dir.exists():
        raise HTTPException(status_code=404, detail="task not found")

    events_file = task_dir / "logs" / "events.jsonl"
    events: list[dict] = []
    if events_file.is_file():
        for line in events_file.read_text("utf-8").splitlines():
            if not line.strip():
                continue
            try:
                envelope = EventEnvelope.model_validate_json(line)
            except ValidationError:
                continue
            if envelope.sequence > since:
                events.append(envelope.model_dump(mode="json"))
    return {"task_id": task_id, "since": since, "events": events}


# ---------------------------------------------------------------------------
# Artifacts
# ---------------------------------------------------------------------------


@router.get("/tasks/{task_id}/artifacts")
async def list_artifacts(task_id: str) -> dict:
    """List only files registered by a valid completed run manifest."""
    loaded = _load_validated_manifest(task_id)
    if loaded is None:
        return {"artifacts": []}
    manifest, artifacts_dir = loaded
    manifest_path = artifacts_dir / "run_manifest.json"
    artifacts = [
        {
            "artifact_id": "run_manifest",
            "name": "run_manifest.json",
            "size": manifest_path.stat().st_size,
            "sha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
            "media_type": "application/json",
        }
    ]
    for entry in manifest.artifacts:
        file_path = _verified_artifact_path(artifacts_dir, entry.relative_path)
        if (
            file_path.stat().st_size != entry.size_bytes
            or _file_sha256(file_path) != entry.sha256
        ):
            raise HTTPException(
                status_code=409, detail="Artifact integrity check failed"
            )
        artifacts.append(
            {
                "artifact_id": entry.artifact_id,
                "name": entry.name,
                "size": entry.size_bytes,
                "sha256": entry.sha256,
                "media_type": entry.media_type,
            }
        )
    return {"artifacts": artifacts}


@router.get("/tasks/{task_id}/artifacts/{artifact_id}")
async def get_artifact_file(task_id: str, artifact_id: str):
    """Resolve an artifact ID through the valid manifest and stream it."""
    loaded = _load_validated_manifest(task_id)
    if loaded is None:
        raise HTTPException(status_code=404, detail="Artifact not found")
    manifest, artifacts_dir = loaded
    if artifact_id == "run_manifest":
        file_path = artifacts_dir / "run_manifest.json"
        media_type = "application/json"
    else:
        entry = next(
            (item for item in manifest.artifacts if item.artifact_id == artifact_id),
            None,
        )
        if entry is None:
            raise HTTPException(status_code=404, detail="Artifact not found")
        file_path = _verified_artifact_path(artifacts_dir, entry.relative_path)
        if (
            file_path.stat().st_size != entry.size_bytes
            or _file_sha256(file_path) != entry.sha256
        ):
            raise HTTPException(
                status_code=409, detail="Artifact integrity check failed"
            )
        media_type = entry.media_type
    return FileResponse(str(file_path), filename=file_path.name, media_type=media_type)


def _file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _verified_artifact_path(artifacts_dir: Path, relative_path: str) -> Path:
    prefix = "artifacts/"
    if not relative_path.startswith(prefix):
        raise HTTPException(status_code=409, detail="Invalid artifact manifest path")
    file_path = (artifacts_dir / relative_path[len(prefix) :]).resolve()
    try:
        file_path.relative_to(artifacts_dir.resolve())
    except ValueError as error:
        raise HTTPException(
            status_code=409, detail="Invalid artifact manifest path"
        ) from error
    if not file_path.is_file():
        raise HTTPException(status_code=409, detail="Registered artifact is missing")
    return file_path


def _load_validated_manifest(task_id: str) -> tuple[RunManifest, Path] | None:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", task_id):
        raise HTTPException(status_code=404, detail="Task not found")
    artifacts_dir = (_tasks_base() / task_id / "artifacts").resolve()
    manifest_path = artifacts_dir / "run_manifest.json"
    if not manifest_path.is_file():
        return None
    try:
        manifest = RunManifest.model_validate_json(manifest_path.read_text("utf-8"))
    except (OSError, ValidationError, ValueError) as error:
        raise HTTPException(
            status_code=409, detail="Artifact manifest is invalid"
        ) from error
    if (
        manifest.validation.status != "valid"
        or manifest.task_state.value != "completed"
    ):
        raise HTTPException(status_code=409, detail="Artifacts are not validated")
    return manifest, artifacts_dir
