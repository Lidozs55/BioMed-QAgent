"""HTTP API routes — databases, tasks, and artifact access.

Endpoints:
    GET /api/v1/databases                 → list available databases from skills
    GET /api/v1/tasks/{task_id}           → task status and directory map
    GET /api/v1/tasks/{task_id}/artifacts → list artifact files
    GET /api/v1/tasks/{task_id}/artifacts/{filename:path} → download artifact
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import tempfile
import threading
from contextlib import suppress
from pathlib import Path
from typing import Annotated, Any, Literal

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    UploadFile,
)
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.api.skills import SkillStoreDep
from app.domain.contracts import (
    EventEnvelope,
    MessagePage,
    RunManifest,
    RunRecord,
    RunStatus,
    StartRunRequest,
    StartTaskRequest,
    TaskMode,
    TaskPage,
    TaskRunAccepted,
    TaskSnapshot,
)
from app.runtime.manager import (
    FixtureTaskContinuationError,
    RequestIdConflictError,
    RunAdmissionRejectedError,
    RunQueueFullError,
    TaskDeletionConflictError,
    TaskManager,
    TaskRunConflictError,
)
from app.runtime.repository import TaskRepository
from app.skills.catalog import SkillCatalog
from app.skills.store import StoreMutation
from app.tools.workdir import create_task_workdir

router = APIRouter(prefix="/api/v1")
_SAFE_RUNTIME_ID = re.compile(r"[A-Za-z0-9_-]{1,128}")


def get_task_repository(request: Request) -> TaskRepository:
    """Return the lifespan-owned task repository."""

    repository = getattr(request.app.state, "task_repository", None)
    if repository is None:
        raise HTTPException(status_code=503, detail="Task runtime is unavailable")
    return repository


TaskRepositoryDep = Annotated[TaskRepository, Depends(get_task_repository)]


def get_task_manager(request: Request) -> TaskManager:
    """Return the available lifespan-owned task manager."""

    manager = getattr(request.app.state, "task_manager", None)
    if (
        manager is None
        or getattr(manager, "_closed", False)
        or getattr(manager, "_closing", False)
        or getattr(manager, "_started", True) is False
    ):
        raise HTTPException(status_code=503, detail="Task runtime is unavailable")
    return manager


TaskManagerDep = Annotated[TaskManager, Depends(get_task_manager)]


async def _require_snapshot(
    repository: TaskRepository,
    task_id: str,
) -> TaskSnapshot:
    if _SAFE_RUNTIME_ID.fullmatch(task_id) is None:
        raise HTTPException(status_code=404, detail="Task not found")
    snapshot = await repository.get_snapshot(task_id)
    if snapshot is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return snapshot


def _require_run(snapshot: TaskSnapshot, run_id: str) -> RunRecord:
    if _SAFE_RUNTIME_ID.fullmatch(run_id) is None:
        raise HTTPException(status_code=404, detail="Run not found")
    run = next(
        (candidate for candidate in snapshot.runs if candidate.run_id == run_id),
        None,
    )
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")
    return run


def _raise_pagination_error(error: ValueError, *, cursor_detail: str) -> None:
    detail = str(error)
    if detail == cursor_detail or detail.startswith("limit must be between "):
        raise HTTPException(status_code=422, detail=detail) from error
    raise error


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
    "pubchem": "PubChem",
    "reactome": "Reactome",
}


def _display_name(skill_name: str) -> str:
    """Return a human-readable name for a skill."""
    return _SKILL_DISPLAY_NAMES.get(skill_name, skill_name.replace("_", " ").title())


def load_database_skills() -> None:
    """Compatibility wrapper for callers that still trigger builtin discovery."""
    from app.skills.builtin import load_builtin_skill_descriptors

    load_builtin_skill_descriptors()



# ---------------------------------------------------------------------------
# Databases
# ---------------------------------------------------------------------------


@router.get("/databases")
async def get_databases(request: Request = None) -> dict:
    """List user-selectable databases from the current catalog snapshot."""
    catalog: SkillCatalog | None = (
        getattr(request.app.state, "skill_catalog", None) if request is not None else None
    )
    if catalog is None:
        from app.skills.builtin import load_builtin_skill_descriptors

        descriptors = load_builtin_skill_descriptors()
        skills = [
            skill
            for skill in descriptors
            if skill.enabled and skill.user_selectable and skill.supported_sources
        ]
    else:
        skills = [
            skill
            for skill in catalog.snapshot().skills.values()
            if skill.enabled and skill.user_selectable and skill.supported_sources
        ]
    databases = []
    for skill in skills:
        databases.append(
            {
                "id": skill.name,
                "name": skill.display_name or _display_name(skill.name),
                "category": skill.category.value,
                "description": skill.description,
                "available": skill.enabled,
                "origin": skill.origin,
                "version": skill.version,
                "pipeline_supported": skill.pipeline_supported,
            }
        )
    return {"databases": databases}


@router.post("/databases", response_model=StoreMutation)
async def create_database(body: dict[str, object], store: SkillStoreDep) -> StoreMutation:
    """Create a declarative user database through the shared skill store."""
    try:
        return store.put_manifest(body)
    except (ValueError, FileExistsError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


class DatabaseOperationPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    description: str | None = None
    method: Literal["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] | None = None
    url: str | None = None
    query: dict[str, Any] | None = None
    headers: dict[str, Any] | None = None
    body: Any = None
    timeout_seconds: float | None = None
    extract: str | None = None


class DatabaseUpdatePatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    display_name: str | None = None
    description: str | None = None
    operation: DatabaseOperationPatch | None = None


@router.put("/databases/{name}", response_model=StoreMutation)
async def update_database(
    name: str, body: DatabaseUpdatePatch, store: SkillStoreDep
) -> StoreMutation:
    try:
        return store.patch_manifest(name, body.model_dump(exclude_unset=True))
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Database or operation not found") from error
    except PermissionError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except (ValueError, FileExistsError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@router.delete("/databases/{name}", response_model=StoreMutation)
async def delete_database(name: str, store: SkillStoreDep) -> StoreMutation:
    try:
        return store.delete(name)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Database not found") from error
    except PermissionError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


# ---------------------------------------------------------------------------
# Task status
# ---------------------------------------------------------------------------


@router.get("/tasks", response_model=TaskPage)
async def list_tasks(
    repository: TaskRepositoryDep,
    limit: Annotated[int | None, Query(ge=1)] = None,
    cursor: str | None = None,
) -> TaskPage:
    """Return active tasks and one page of inactive task history."""

    if cursor == "":
        raise HTTPException(status_code=422, detail="invalid task cursor")
    try:
        return await repository.list_tasks(limit=limit, cursor=cursor)
    except ValueError as error:
        _raise_pagination_error(error, cursor_detail="invalid task cursor")


@router.post("/tasks", status_code=202, response_model=TaskRunAccepted)
async def create_task(
    request: StartTaskRequest,
    manager: TaskManagerDep,
) -> TaskRunAccepted:
    """Create a durable task and enqueue its first run."""

    try:
        return await manager.create_task(request)
    except RunAdmissionRejectedError as error:
        raise HTTPException(status_code=422, detail=error.reason) from error
    except RunQueueFullError as error:
        raise HTTPException(status_code=429, detail="Run queue is full") from error
    except RuntimeError as error:
        if str(error) == "task manager is not running":
            raise HTTPException(
                status_code=503,
                detail="Task runtime is unavailable",
            ) from error
        raise


# ---------------------------------------------------------------------------
# Import (multipart upload → IMPORT AgentLoop)
# ---------------------------------------------------------------------------

#: 单个上传文件大小上限（500 MB）— 支持大型数据库 dump 和长论文 PDF。
_IMPORT_MAX_FILE_BYTES = 500 * 1024 * 1024
#: 单次导入请求最多文件数（防止滥用）。
_IMPORT_MAX_FILES = 10
#: 单次导入请求总大小上限（2 GB）。
_IMPORT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
#: 文件名安全字符集：字母数字、``-``、``_``、``.``。
_IMPORT_SAFE_FILENAME = re.compile(r"[^A-Za-z0-9._-]")
_IMPORT_UPLOADS_ROOT_LOCK = threading.Lock()


def _sanitize_upload_filename(raw: str | None) -> str:
    """规整上传文件名，去除路径前缀和危险字符。"""

    if not raw:
        raise HTTPException(status_code=422, detail="Uploaded file has no filename")
    # 去除任何路径前缀（客户端可能发送相对/绝对路径）。
    base = Path(raw).name
    if not base or base in {".", ".."}:
        raise HTTPException(status_code=422, detail="Uploaded file has invalid filename")
    sanitized = _IMPORT_SAFE_FILENAME.sub("_", base)
    if not sanitized:
        raise HTTPException(status_code=422, detail="Uploaded file has invalid filename")
    return sanitized


@router.post(
    "/import/tasks",
    status_code=202,
    response_model=TaskRunAccepted,
)
async def create_import_task(
    http_request: Request,
    repository: TaskRepositoryDep,
    request_id: Annotated[str, Form(min_length=1)],
    input: Annotated[str, Form()] = "",
    files: Annotated[list[UploadFile], File()] = (),
) -> TaskRunAccepted:
    """Create an IMPORT task with uploaded files.

    The IMPORT AgentLoop parses uploaded files (any format), cleans them to
    the 22-column cache schema, and commits to the local cache via
    ``commit_to_cache``. Imported datasets become queryable by subsequent
    research tasks via ``search_local_cache`` / ``get_cache_dataset``.
    """

    uploads_root = repository.tasks_dir / ".uploads"
    staging_dir: Path | None = None
    try:
        if not files:
            raise HTTPException(status_code=422, detail="At least one file is required")
        if len(files) > _IMPORT_MAX_FILES:
            raise HTTPException(
                status_code=422,
                detail=f"Too many files (max {_IMPORT_MAX_FILES})",
            )

        sanitized_names: list[str] = []
        seen_names: set[str] = set()
        for upload in files:
            name = _sanitize_upload_filename(upload.filename)
            if name in seen_names:
                raise HTTPException(
                    status_code=422,
                    detail=f"Duplicate uploaded filename: {name}",
                )
            seen_names.add(name)
            sanitized_names.append(name)

        with _IMPORT_UPLOADS_ROOT_LOCK:
            uploads_root.mkdir(parents=True, exist_ok=True)
            staging_dir = Path(tempfile.mkdtemp(prefix="import-", dir=uploads_root))
        grand_total = 0
        for upload, name in zip(files, sanitized_names, strict=True):
            staged_file = staging_dir / name
            with staged_file.open("wb") as output:
                total = 0
                while True:
                    chunk = await upload.read(64 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > _IMPORT_MAX_FILE_BYTES:
                        raise HTTPException(
                            status_code=413,
                            detail=(
                                f"File {name} exceeds max size "
                                f"({_IMPORT_MAX_FILE_BYTES} bytes)"
                            ),
                        )
                    grand_total += len(chunk)
                    if grand_total > _IMPORT_MAX_TOTAL_BYTES:
                        raise HTTPException(
                            status_code=413,
                            detail=(
                                "Total upload size exceeds limit "
                                f"({_IMPORT_MAX_TOTAL_BYTES} bytes)"
                            ),
                        )
                    output.write(chunk)

        # 构造 IMPORT 任务的输入文本。文件列表由 IMPORT agent 通过
        # ``list_files('source_assets')`` 自行发现，输入文本仅用于任务标题
        # 和给 LLM 的初始提示。
        user_note = input.strip()
        file_list_str = ", ".join(sanitized_names)
        if user_note:
            composed_input = (
                f"{user_note}\n\n"
                f"[uploaded_files ({len(sanitized_names)}): {file_list_str}]"
            )
        else:
            composed_input = (
                f"Import {len(sanitized_names)} file(s) into local cache: "
                f"{file_list_str}"
            )

        request = StartTaskRequest(
            request_id=request_id.strip(),
            input=composed_input,
            mode=TaskMode.IMPORT,
        )
        manager = get_task_manager(http_request)

        async def prepare_task(task_id: str) -> None:
            workdir = create_task_workdir(task_id, base_dir=str(repository.tasks_dir))
            for name in sanitized_names:
                (staging_dir / name).replace(workdir.source_asset_file(name))

        try:
            return await manager.create_task(request, prepare_task=prepare_task)
        except RunAdmissionRejectedError as error:
            raise HTTPException(status_code=422, detail=error.reason) from error
        except RunQueueFullError as error:
            raise HTTPException(status_code=429, detail="Run queue is full") from error
        except RuntimeError as error:
            if str(error) == "task manager is not running":
                raise HTTPException(
                    status_code=503,
                    detail="Task runtime is unavailable",
                ) from error
            raise
    finally:
        if staging_dir is not None:
            shutil.rmtree(staging_dir, ignore_errors=True)
        with _IMPORT_UPLOADS_ROOT_LOCK, suppress(OSError):
            uploads_root.rmdir()
        for upload in files:
            with suppress(Exception):
                await upload.close()


# ---------------------------------------------------------------------------
# Cache export (D6 decision)
# ---------------------------------------------------------------------------


@router.get("/cache/export")
async def export_cache():
    """Export the entire local cache as a single ZIP file.

    Returns a ZIP with structure::

        cache_export/
        ├── index.json
        └── <namespace>/<dataset_id>/
            ├── main_data.csv
            └── manifest.json

    The ZIP can be re-imported via the ``parse_cache_export_zip`` tool.
    """
    from app.tools.cache_export import stream_cache_export

    return await stream_cache_export()


@router.get("/tasks/{task_id}", response_model=TaskSnapshot)
async def get_task(task_id: str, repository: TaskRepositoryDep) -> TaskSnapshot:
    """Return the authoritative durable task snapshot."""

    return await _require_snapshot(repository, task_id)


@router.delete("/tasks/{task_id}", status_code=204)
async def delete_task(task_id: str, manager: TaskManagerDep) -> None:
    """Delete one explicitly requested terminal Task and all of its history."""

    try:
        await manager.delete_task(task_id)
    except TaskDeletionConflictError as error:
        raise HTTPException(
            status_code=409,
            detail="Only terminal tasks can be deleted",
        ) from error
    except LookupError as error:
        raise HTTPException(status_code=404, detail="Task not found") from error
    except RuntimeError as error:
        if str(error) == "task manager is not running":
            raise HTTPException(
                status_code=503,
                detail="Task runtime is unavailable",
            ) from error
        raise


@router.post(
    "/tasks/{task_id}/runs",
    status_code=202,
    response_model=TaskRunAccepted,
)
async def continue_task(
    task_id: str,
    request: StartRunRequest,
    repository: TaskRepositoryDep,
    manager: TaskManagerDep,
) -> TaskRunAccepted:
    """Enqueue another user turn for an idle Agent task."""

    snapshot = await _require_snapshot(repository, task_id)
    if snapshot.task.mode is TaskMode.FIXTURE:
        raise HTTPException(
            status_code=409,
            detail="Fixture tasks cannot be continued",
        )
    try:
        return await manager.submit_run(task_id, request)
    except RunAdmissionRejectedError as error:
        raise HTTPException(status_code=422, detail=error.reason) from error
    except RequestIdConflictError as error:
        raise HTTPException(
            status_code=409,
            detail="Request ID belongs to another task",
        ) from error
    except TaskRunConflictError as error:
        raise HTTPException(
            status_code=409,
            detail="Task already has an active run",
        ) from error
    except FixtureTaskContinuationError as error:
        raise HTTPException(
            status_code=409,
            detail="Fixture tasks cannot be continued",
        ) from error
    except RunQueueFullError as error:
        raise HTTPException(status_code=429, detail="Run queue is full") from error
    except LookupError as error:
        raise HTTPException(status_code=404, detail="Task not found") from error
    except RuntimeError as error:
        if str(error) == "task manager is not running":
            raise HTTPException(
                status_code=503,
                detail="Task runtime is unavailable",
            ) from error
        raise


@router.post(
    "/tasks/{task_id}/runs/{run_id}/cancel",
    status_code=202,
    response_model=TaskSnapshot,
)
async def cancel_task_run(
    task_id: str,
    run_id: str,
    repository: TaskRepositoryDep,
    manager: TaskManagerDep,
) -> TaskSnapshot:
    """Request cancellation of one queued or running task run."""

    snapshot = await _require_snapshot(repository, task_id)
    _require_run(snapshot, run_id)
    try:
        return await manager.cancel_run(task_id, run_id, reason=None)
    except LookupError as error:
        raise HTTPException(status_code=404, detail="Run not found") from error
    except RuntimeError as error:
        detail = str(error)
        if detail == "task manager is not running":
            raise HTTPException(
                status_code=503,
                detail="Task runtime is unavailable",
            ) from error
        if detail in {
            f"run {run_id} is not cancellable",
            f"run {run_id} has no live execution",
            f"run {run_id} left cancellation state",
        }:
            raise HTTPException(
                status_code=409,
                detail="Run is not cancellable",
            ) from error
        raise


class ResumeRunRequest(BaseModel):
    """Body for ``POST /runs/{run_id}/resume``.

    Attributes:
        request_id: Must match the ``request_id`` of the pending
            ``user_input_required`` event for the run.
        decision: ``approve`` to continue the pipeline, ``reject`` to
            abort with a failure.
        detail: Optional structured payload (e.g. corrected fields).
    """

    request_id: str = Field(min_length=1)
    decision: Literal["approve", "reject"]
    detail: dict[str, object] = Field(default_factory=dict)


@router.post(
    "/tasks/{task_id}/runs/{run_id}/resume",
    status_code=202,
    response_model=TaskSnapshot,
)
async def resume_task_run(
    task_id: str,
    run_id: str,
    body: ResumeRunRequest,
    repository: TaskRepositoryDep,
    manager: TaskManagerDep,
) -> TaskSnapshot:
    """Submit a human-in-the-loop resume decision to a paused run."""

    snapshot = await _require_snapshot(repository, task_id)
    _require_run(snapshot, run_id)
    try:
        return await manager.resume_run(
            task_id,
            run_id,
            request_id=body.request_id,
            decision=body.decision,
            detail=body.detail,
        )
    except LookupError as error:
        raise HTTPException(status_code=404, detail="Run not found") from error
    except RuntimeError as error:
        detail = str(error)
        if detail == "task manager is not running":
            raise HTTPException(
                status_code=503,
                detail="Task runtime is unavailable",
            ) from error
        if detail.startswith(f"run {run_id} is not awaiting user input"):
            raise HTTPException(
                status_code=409,
                detail="Run is not awaiting user input",
            ) from error
        if detail == f"run {run_id} has no live execution":
            raise HTTPException(
                status_code=409,
                detail="Run is not awaiting user input",
            ) from error
        if detail == f"run {run_id} executor rejected the resume decision":
            raise HTTPException(
                status_code=409,
                detail="Run is not awaiting user input",
            ) from error
        raise


@router.get("/tasks/{task_id}/messages", response_model=MessagePage)
async def list_task_messages(
    task_id: str,
    repository: TaskRepositoryDep,
    limit: Annotated[int | None, Query(ge=1)] = None,
    cursor: str | None = None,
) -> MessagePage:
    """Return one ascending page of durable task messages."""

    await _require_snapshot(repository, task_id)
    if cursor == "":
        raise HTTPException(status_code=422, detail="invalid message cursor")
    try:
        return await repository.list_messages(task_id, limit=limit, cursor=cursor)
    except ValueError as error:
        _raise_pagination_error(error, cursor_detail="invalid message cursor")


@router.get("/tasks/{task_id}/events")
async def list_task_events(
    task_id: str,
    repository: TaskRepositoryDep,
    after_sequence: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=1000)] = 100,
) -> dict[str, list[EventEnvelope]]:
    """Return exclusive, ordered durable events for task replay."""

    await _require_snapshot(repository, task_id)
    events = await repository.list_events(
        task_id,
        after_sequence=after_sequence,
        limit=limit,
    )
    return {"events": events}


# ---------------------------------------------------------------------------
# Artifacts
# ---------------------------------------------------------------------------


@router.get("/tasks/{task_id}/artifacts")
async def list_artifacts(task_id: str, repository: TaskRepositoryDep) -> dict:
    """List only files registered by a valid completed run manifest."""
    snapshot = await _require_snapshot(repository, task_id)
    loaded = _load_validated_manifest(repository.tasks_dir, task_id, snapshot)
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
async def get_artifact_file(
    task_id: str,
    artifact_id: str,
    repository: TaskRepositoryDep,
):
    """Resolve an artifact ID through the valid manifest and stream it."""
    snapshot = await _require_snapshot(repository, task_id)
    loaded = _load_validated_manifest(repository.tasks_dir, task_id, snapshot)
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


def _load_validated_manifest(
    tasks_dir: Path,
    task_id: str,
    snapshot: TaskSnapshot,
) -> tuple[RunManifest, Path] | None:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", task_id):
        raise HTTPException(status_code=404, detail="Task not found")
    artifacts_dir = (tasks_dir / task_id / "artifacts").resolve()
    manifest_path = artifacts_dir / "run_manifest.json"
    marker_path = artifacts_dir / ".runtime-publication.json"
    if not manifest_path.is_file() or not marker_path.is_file():
        return None
    try:
        manifest = RunManifest.model_validate_json(manifest_path.read_text("utf-8"))
    except (ValidationError, ValueError) as error:
        raise HTTPException(
            status_code=409, detail="Artifact manifest is invalid"
        ) from error
    if (
        manifest.validation.status != "valid"
        or manifest.task_state.value != "completed"
    ):
        raise HTTPException(status_code=409, detail="Artifacts are not validated")
    if manifest.task_id != task_id:
        raise HTTPException(status_code=409, detail="Artifact manifest is invalid")
    try:
        marker = json.loads(marker_path.read_text("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as error:
        raise HTTPException(
            status_code=409,
            detail="Artifact publication marker is invalid",
        ) from error
    if not isinstance(marker, dict):
        raise HTTPException(
            status_code=409,
            detail="Artifact publication marker is invalid",
        )
    run_id = marker.get("run_id")
    marker_hash = marker.get("manifest_sha256")
    if (
        marker.get("schema_version") != 1
        or marker.get("task_id") != task_id
        or not isinstance(run_id, str)
        or _SAFE_RUNTIME_ID.fullmatch(run_id) is None
        or not isinstance(marker_hash, str)
        or re.fullmatch(r"[0-9a-f]{64}", marker_hash) is None
    ):
        raise HTTPException(
            status_code=409,
            detail="Artifact publication marker is invalid",
        )
    completed_run = next(
        (
            run
            for run in snapshot.runs
            if run.run_id == run_id and run.status is RunStatus.COMPLETED
        ),
        None,
    )
    if completed_run is None:
        return None
    if hashlib.sha256(manifest_path.read_bytes()).hexdigest() != marker_hash:
        raise HTTPException(
            status_code=409,
            detail="Artifact publication marker does not match manifest",
        )
    return manifest, artifacts_dir
