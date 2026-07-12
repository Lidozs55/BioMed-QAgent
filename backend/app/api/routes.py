"""HTTP API routes — databases, tasks, and artifact access.

Endpoints:
    GET /api/v1/databases                 → list available databases from skills
    GET /api/v1/tasks/{task_id}           → task status and directory map
    GET /api/v1/tasks/{task_id}/artifacts → list artifact files
    GET /api/v1/tasks/{task_id}/artifacts/{filename:path} → download artifact
"""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from app.config import settings
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
    for sub in ("raw", "parsed", "normalized", "artifacts", "logs"):
        sub_path = task_dir / sub
        if sub_path.exists():
            directories[sub] = str(sub_path)

    return {"task_id": task_id, "status": status, "directories": directories}


# ---------------------------------------------------------------------------
# Artifacts
# ---------------------------------------------------------------------------


@router.get("/tasks/{task_id}/artifacts")
async def list_artifacts(task_id: str) -> dict:
    """List all artifact files in a task's artifacts directory."""
    artifacts_dir = _tasks_base() / task_id / "artifacts"
    if not artifacts_dir.exists():
        return {"artifacts": []}

    artifacts = []
    for file_path in sorted(artifacts_dir.rglob("*")):
        if file_path.is_file():
            rel_path = file_path.relative_to(artifacts_dir)
            artifacts.append({
                "name": file_path.name,
                "size": file_path.stat().st_size,
                "path": str(rel_path).replace("\\", "/"),
            })
    return {"artifacts": artifacts}


@router.get("/tasks/{task_id}/artifacts/{filename:path}")
async def get_artifact_file(task_id: str, filename: str):
    """Stream an artifact file as a download response."""
    artifacts_dir = (_tasks_base() / task_id / "artifacts").resolve()
    file_path = (artifacts_dir / filename).resolve()

    # Security: prevent directory traversal
    try:
        file_path.relative_to(artifacts_dir)
    except ValueError:
        raise HTTPException(status_code=403, detail="Access denied")

    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    return FileResponse(str(file_path), filename=file_path.name)
