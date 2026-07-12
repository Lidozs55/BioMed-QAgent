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

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import ValidationError

from app.config import settings
from app.domain.contracts import RunManifest
from app.skills.registry import skill_registry

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


def _tasks_base() -> Path:
    """Return the base directory for task data."""
    return Path(settings.output_dir) / "tasks"


# ---------------------------------------------------------------------------
# Databases
# ---------------------------------------------------------------------------


@router.get("/databases")
async def get_databases() -> dict:
    """List all available databases derived from enabled skills."""
    skills = skill_registry.list_enabled()
    databases = []
    for skill in skills:
        databases.append({
            "id": skill.name,
            "name": _display_name(skill.name),
            "category": skill.category.value,
            "description": skill.description,
        })
    return {"databases": databases}


# ---------------------------------------------------------------------------
# Task status
# ---------------------------------------------------------------------------


def _task_status(task_dir: Path) -> str:
    """Heuristic task status based on directory contents."""
    if not task_dir.exists():
        return "not_found"
    artifacts_dir = task_dir / "artifacts"
    if artifacts_dir.exists() and any(artifacts_dir.iterdir()):
        return "completed"
    return "running"


@router.get("/tasks/{task_id}")
async def get_task(task_id: str) -> dict:
    """Return task status and directory paths."""
    task_dir = _tasks_base() / task_id
    status = _task_status(task_dir)

    directories: dict[str, str] = {}
    for sub in (
        "source_assets", "download_tmp", "parsed", "normalized", "staging",
        "artifacts", "state", "logs",
    ):
        sub_path = task_dir / sub
        if sub_path.exists():
            directories[sub] = str(sub_path)

    return {"task_id": task_id, "status": status, "directories": directories}


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
    artifacts = [{
        "artifact_id": "run_manifest",
        "name": "run_manifest.json",
        "size": manifest_path.stat().st_size,
        "sha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
        "media_type": "application/json",
    }]
    for entry in manifest.artifacts:
        file_path = _verified_artifact_path(artifacts_dir, entry.relative_path)
        if file_path.stat().st_size != entry.size_bytes or _file_sha256(file_path) != entry.sha256:
            raise HTTPException(status_code=409, detail="Artifact integrity check failed")
        artifacts.append({
            "artifact_id": entry.artifact_id,
            "name": entry.name,
            "size": entry.size_bytes,
            "sha256": entry.sha256,
            "media_type": entry.media_type,
        })
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
        if file_path.stat().st_size != entry.size_bytes or _file_sha256(file_path) != entry.sha256:
            raise HTTPException(status_code=409, detail="Artifact integrity check failed")
        media_type = entry.media_type
    return FileResponse(str(file_path), filename=file_path.name, media_type=media_type)


def _file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _verified_artifact_path(artifacts_dir: Path, relative_path: str) -> Path:
    prefix = "artifacts/"
    if not relative_path.startswith(prefix):
        raise HTTPException(status_code=409, detail="Invalid artifact manifest path")
    file_path = (artifacts_dir / relative_path[len(prefix):]).resolve()
    try:
        file_path.relative_to(artifacts_dir.resolve())
    except ValueError as error:
        raise HTTPException(status_code=409, detail="Invalid artifact manifest path") from error
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
        raise HTTPException(status_code=409, detail="Artifact manifest is invalid") from error
    if manifest.validation.status != "valid" or manifest.task_state.value != "completed":
        raise HTTPException(status_code=409, detail="Artifacts are not validated")
    return manifest, artifacts_dir
