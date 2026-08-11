"""HTTP API routes — databases, tasks, and artifact access.

Endpoints:
    GET /api/v1/databases                 → list available databases from skills
    GET /api/v1/tasks/{task_id}           → task status and directory map
    GET /api/v1/tasks/{task_id}/artifacts → list artifact files
    GET /api/v1/tasks/{task_id}/artifacts/{filename:path} → download artifact
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
import shutil
import tempfile
import threading
from contextlib import suppress
from datetime import datetime
from functools import lru_cache
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

from app.agent_loop.context_injection import get_context_injection_store
from app.api.skills import SkillStoreDep
from app.datasets.build.cache import CacheEntry, DatasetCacheV2
from app.datasets.build.legacy_cache import (
    LegacyCacheEntry,
    find_legacy,
    find_legacy_global,
    legacy_artifacts,
    list_legacy,
)
from app.datasets.contracts import (
    DatasetManifest,
    DatasetPublication,
    ManifestArtifactEntry,
)
from app.domain.contracts import (
    EventEnvelope,
    MessagePage,
    RunCompletedPayload,
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
from app.domain.contracts.base import ContractModel
from app.domain.contracts.dataset_state import (
    ArtifactRole,
    BuildResult,
    BuildResultStatus,
)
from app.runtime.manager import (
    FixtureTaskContinuationError,
    RequestIdConflictError,
    RequestIdSemanticConflictError,
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
    "analysis": "Analysis",
    "pubchem": "PubChem",
    "reactome": "Reactome",
}


def _display_name(skill_name: str) -> str:
    """Return a human-readable name for a skill."""
    return _SKILL_DISPLAY_NAMES.get(skill_name, skill_name.replace("_", " ").title())


def _source_capability_for_skill(skill_name: str) -> str:
    """Map a skill id to its Pipeline input-level capability (TODO §1.4).

    Uses the single source-of-truth capability table so the API projection
    cannot drift from the Pipeline tool's rejection logic. Unknown skills
    resolve to ``pending`` (never silently treated as pipeline-supported).
    """
    from app.domain.contracts.enums import (
        DATABASE_IDENTIFIER_ALIASES,
        SOURCE_CAPABILITIES,
        SourceCapability,
    )

    database = DATABASE_IDENTIFIER_ALIASES.get(skill_name)
    if database is None:
        return SourceCapability.PENDING.value
    return SOURCE_CAPABILITIES[database].value


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
                # TODO §1.4: expose the capability classification so the
                # frontend can distinguish research_only / pending sources
                # from pipeline_supported ones.
                "capability": _source_capability_for_skill(skill.name),
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
    except RequestIdSemanticConflictError as error:
        raise HTTPException(
            status_code=409,
            detail="Request ID was reused with different request content",
        ) from error
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
        upload_metadata: list[dict[str, str | int]] = []
        for upload, name in zip(files, sanitized_names, strict=True):
            staged_file = staging_dir / name
            digest = hashlib.sha256()
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
                    digest.update(chunk)
            upload_metadata.append(
                {"name": name, "size_bytes": total, "sha256": digest.hexdigest()}
            )

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
            idempotency_metadata={"uploads": upload_metadata},
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
        except RequestIdSemanticConflictError as error:
            raise HTTPException(
                status_code=409,
                detail="Request ID was reused with different request content",
            ) from error
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
    except RequestIdSemanticConflictError as error:
        raise HTTPException(
            status_code=409,
            detail="Request ID was reused with different request content",
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


@router.post(
    "/tasks/{task_id}/runs/{run_id}/subagents/{subagent_id}/cancel",
    status_code=202,
    response_model=TaskSnapshot,
)
async def cancel_task_subagent(
    task_id: str,
    run_id: str,
    subagent_id: str,
    repository: TaskRepositoryDep,
    manager: TaskManagerDep,
) -> TaskSnapshot:
    """Request cancellation of one nonterminal child agent."""

    snapshot = await _require_snapshot(repository, task_id)
    _require_run(snapshot, run_id)
    try:
        return await manager.cancel_subagent(
            task_id,
            run_id,
            subagent_id,
            reason=None,
        )
    except LookupError as error:
        raise HTTPException(status_code=404, detail="Subagent not found") from error
    except RuntimeError as error:
        detail = str(error)
        if detail in {
            "task manager is not running",
            "subagent runtime is unavailable",
        }:
            raise HTTPException(
                status_code=503,
                detail="Subagent runtime is unavailable",
            ) from error
        if detail == f"subagent {subagent_id} is not cancellable":
            raise HTTPException(
                status_code=409,
                detail="Subagent is not cancellable",
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
    except ValueError as error:
        raise HTTPException(
            status_code=409,
            detail="Resume request does not belong to this run",
        ) from error
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


@router.post("/tasks/{task_id}/compact", status_code=202)
async def request_compaction(
    task_id: str,
    repository: TaskRepositoryDep,
    manager: TaskManagerDep,
) -> dict[str, str]:
    """Request context compaction for a task's active run.

    Compaction is performed by the agent during its next invocation preflight.
    This endpoint signals the running agent to compact at the earliest
    opportunity.  Returns 409 if the task has no active run.
    """

    snapshot = await _require_snapshot(repository, task_id)
    active_run_id = snapshot.task.active_run_id
    if active_run_id is None:
        raise HTTPException(
            status_code=409,
            detail="Task has no active run to compact",
        )
    # Signal compaction via the manager's event system
    await manager.request_compaction(task_id, active_run_id)
    return {"status": "compaction_requested", "task_id": task_id, "run_id": active_run_id}


class ContextInjectionRequest(BaseModel):
    """Body for injecting a short text into a task's context."""

    model_config = ConfigDict(extra="forbid")

    text: str = Field(min_length=1, max_length=4000)


@router.post("/tasks/{task_id}/inject-context", status_code=202)
async def inject_task_context(
    task_id: str,
    body: ContextInjectionRequest,
    repository: TaskRepositoryDep,
) -> dict[str, str | int]:
    """Inject a short text into a task's context without interrupting it.

    The text is stored per task and included in the agent's next model call
    (dynamic instructions), then consumed once.  This works while a run is
    actively generating; the current answer is not interrupted.
    """

    await _require_snapshot(repository, task_id)
    pending = get_context_injection_store().inject(task_id, body.text)
    # 持久化到任务会话（仅用于对话展示，模型历史读不到）：
    # 注入内容以用户消息形式出现在对话记录末尾，但不会作为模型输入、
    # 不会打断当前回答。
    session = repository.task_session(task_id)
    await session.add_items(
        [{"role": "user", "content": body.text}],
        display_only=True,
    )
    return {"status": "injected", "task_id": task_id, "pending": pending}


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

# C2b: HIL 超时请求落盘在任务 artifacts 目录（main_input_broker
# `_write_corrections_todo`），独立于任何 manifest。list_artifacts 把该文件
# 追加为审计类条目；下载端点按固定 artifact_id 解析。
_CORRECTIONS_TODO_ARTIFACT_ID = "corrections_todo"
_CORRECTIONS_TODO_FILENAME = "corrections_todo.csv"
_CORRECTIONS_TODO_MEDIA_TYPE = "text/csv"


def _corrections_todo_path(repository: TaskRepositoryDep, task_id: str) -> Path:
    """Return the task-scoped corrections todo path (may not exist)."""

    return (
        repository.tasks_dir / task_id / "artifacts" / _CORRECTIONS_TODO_FILENAME
    )


def _corrections_todo_entry(
    repository: TaskRepositoryDep,
    task_id: str,
) -> dict[str, object] | None:
    """Return the listing entry for an existing corrections todo file, else None."""

    path = _corrections_todo_path(repository, task_id)
    if not path.is_file():
        return None
    return {
        "artifact_id": _CORRECTIONS_TODO_ARTIFACT_ID,
        "name": _CORRECTIONS_TODO_FILENAME,
        "role": ArtifactRole.AUDIT_REPORT.value,
        "size": path.stat().st_size,
        "sha256": _listing_sha256(path),
        "media_type": _CORRECTIONS_TODO_MEDIA_TYPE,
    }


@router.get("/tasks/{task_id}/artifacts")
async def list_artifacts(task_id: str, repository: TaskRepositoryDep) -> dict:
    """List only files registered by a valid completed run manifest.

    Dual-read (Phase 7 T2): the V2 dataset cache is authoritative for V2
    builds; the legacy ``artifacts/`` dirs serve V1 runs and pre-cache V2
    builds (fallback).
    """
    snapshot = await _require_snapshot(repository, task_id)
    cached = _cache_artifacts_for_task(repository, task_id)
    if cached is not None and any(
        run.status is RunStatus.COMPLETED for run in snapshot.runs
    ):
        manifest, entry_dir = cached
        manifest_path = entry_dir / "dataset_manifest.json"
        artifacts = [
            {
                "artifact_id": "run_manifest",
                "name": "dataset_manifest.json",
                "role": ArtifactRole.SCHEMA.value,
                "size": manifest_path.stat().st_size,
                "sha256": _listing_sha256(manifest_path),
                "media_type": "application/json",
            }
        ]
        for entry in manifest.artifacts:
            file_path = _verified_cache_artifact_path(entry_dir, entry.relative_path)
            if (
                file_path.stat().st_size != entry.size_bytes
                or _listing_sha256(file_path) != entry.sha256
            ):
                # C2c：cache 文件完整性校验失败 → 跳过该 cache entry，
                # 回退 legacy 镜像面（坏 manifest 的 continue 语义同源）。
                break
            artifacts.append(
                {
                    "artifact_id": entry.artifact_id,
                    "name": Path(entry.relative_path).name,
                    "role": entry.role.value,
                    "size": entry.size_bytes,
                    "sha256": entry.sha256,
                    "media_type": entry.media_type,
                }
            )
        else:
            if corrections := _corrections_todo_entry(repository, task_id):
                artifacts.append(corrections)
            return {"artifacts": artifacts, "degraded": False}
    loaded = _load_validated_manifest(repository.tasks_dir, task_id, snapshot)
    if loaded is None:
        corrections = _corrections_todo_entry(repository, task_id)
        return {
            "artifacts": [corrections] if corrections else [],
            "degraded": False,
        }
    manifest, artifacts_dir, degraded = loaded
    manifest_path = artifacts_dir / "run_manifest.json"
    artifacts = [
        {
            "artifact_id": "run_manifest",
            "name": "run_manifest.json",
            "role": ArtifactRole.SCHEMA.value,
            "size": manifest_path.stat().st_size,
            "sha256": _listing_sha256(manifest_path),
            "media_type": "application/json",
        }
    ]
    for entry in manifest.artifacts:
        file_path = _verified_artifact_path(artifacts_dir, entry.relative_path)
        if (
            file_path.stat().st_size != entry.size_bytes
            or _listing_sha256(file_path) != entry.sha256
        ):
            raise HTTPException(
                status_code=409, detail="Artifact integrity check failed"
            )
        artifacts.append(
            {
                "artifact_id": entry.artifact_id,
                "name": entry.name,
                "role": entry.role.value,
                "size": entry.size_bytes,
                "sha256": entry.sha256,
                "media_type": entry.media_type,
            }
        )
    if corrections := _corrections_todo_entry(repository, task_id):
        artifacts.append(corrections)
    return {"artifacts": artifacts, "degraded": degraded}


@router.get("/tasks/{task_id}/artifacts/{artifact_id}")
async def get_artifact_file(
    task_id: str,
    artifact_id: str,
    repository: TaskRepositoryDep,
):
    """Resolve an artifact ID through the valid manifest and stream it.

    Dual-read (Phase 7 T2): V2 builds resolve through the dataset cache
    first; V1 runs fall back to the legacy ``artifacts/`` dirs.
    """
    snapshot = await _require_snapshot(repository, task_id)
    cached = _cache_artifacts_for_task(repository, task_id)
    if cached is not None and any(
        run.status is RunStatus.COMPLETED for run in snapshot.runs
    ):
        manifest, entry_dir = cached
        if artifact_id == "run_manifest":
            file_path = entry_dir / "dataset_manifest.json"
            media_type = "application/json"
        elif artifact_id == _CORRECTIONS_TODO_ARTIFACT_ID:
            corrections_path = _corrections_todo_path(repository, task_id)
            if not corrections_path.is_file():
                raise HTTPException(status_code=404, detail="Artifact not found")
            file_path = corrections_path
            media_type = _CORRECTIONS_TODO_MEDIA_TYPE
        else:
            entry = next(
                (
                    item
                    for item in manifest.artifacts
                    if item.artifact_id == artifact_id
                ),
                None,
            )
            if entry is None:
                raise HTTPException(
                    status_code=404, detail="Artifact not found"
                )
            file_path = _verified_cache_artifact_path(entry_dir, entry.relative_path)
            if (
                file_path.stat().st_size != entry.size_bytes
                or _file_sha256(file_path) != entry.sha256
            ):
                raise HTTPException(
                    status_code=409, detail="Artifact integrity check failed"
                )
            media_type = entry.media_type
        return FileResponse(
            str(file_path), filename=file_path.name, media_type=media_type
        )
    loaded = _load_validated_manifest(repository.tasks_dir, task_id, snapshot)
    if artifact_id == _CORRECTIONS_TODO_ARTIFACT_ID:
        # C2b fix: corrections 独立于 manifest 存在（HIL 超时落盘），必须在
        # ``loaded is None`` 守卫之前解析——与 list 的 loaded-None 分支一致。
        corrections_path = _corrections_todo_path(repository, task_id)
        if not corrections_path.is_file():
            raise HTTPException(status_code=404, detail="Artifact not found")
        return FileResponse(
            str(corrections_path),
            filename=corrections_path.name,
            media_type=_CORRECTIONS_TODO_MEDIA_TYPE,
        )
    if loaded is None:
        raise HTTPException(status_code=404, detail="Artifact not found")
    manifest, artifacts_dir, _degraded = loaded
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


_HASH_CHUNK_SIZE = 1 << 20  # 1 MiB — bounded memory per artifact read


@lru_cache(maxsize=256)
def _cached_digest(path: str, mtime_ns: int, size: int) -> str:
    """Digest keyed by (path, mtime_ns, size) so edits invalidate the cache."""

    return _file_sha256(Path(path))


def _listing_sha256(path: Path) -> str:
    """Listing-verification digest with an mtime+size-invalidated cache (C3d).

    Only listing paths use this: ``list_artifacts`` re-verifies every artifact
    file on every request (O(bytes), slow for GB CSVs). The cache key embeds
    mtime and size, so a modified file recomputes its digest and the existing
    integrity/fallback semantics are untouched. Download endpoints keep
    calling ``_file_sha256`` directly so the file being served is always
    hashed fresh.
    """

    stat = path.stat()
    return _cached_digest(str(path), stat.st_mtime_ns, stat.st_size)


def _file_sha256(path: Path, chunk_size: int = _HASH_CHUNK_SIZE) -> str:
    """Hash a file incrementally without loading it into memory (B7).

    Streaming fixed-size chunks keeps API memory bounded even for very large
    published CSVs; the same helper backs listing digests and download
    verification.
    """

    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(chunk_size)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


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
) -> tuple[RunManifest, Path, bool] | None:
    """Load a validated manifest plus its artifacts directory.

    Returns ``(manifest, artifacts_dir, degraded)`` where ``degraded`` is
    True when the runtime publication marker is missing and the manifest is
    trusted on its own (older pipeline output or an interrupted marker write).
    Returns ``None`` when there is no validated manifest to expose.
    """
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", task_id):
        raise HTTPException(status_code=404, detail="Task not found")
    artifacts_dir = (tasks_dir / task_id / "artifacts").resolve()
    manifest_path = artifacts_dir / "run_manifest.json"
    marker_path = artifacts_dir / ".runtime-publication.json"
    if not manifest_path.is_file():
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
    if not marker_path.is_file():
        # 无 marker：降级为仅信任 manifest（旧产物或 marker 写入中断）。
        # 仍然要求 snapshot 中存在至少一个 COMPLETED run，避免把
        # 尚未完成的任务目录里的残留 manifest 误公开。
        completed_runs = [
            run for run in snapshot.runs if run.status is RunStatus.COMPLETED
        ]
        if not completed_runs:
            return None
        return manifest, artifacts_dir, True
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
    if _file_sha256(manifest_path) != marker_hash:
        raise HTTPException(
            status_code=409,
            detail="Artifact publication marker does not match manifest",
        )
    return manifest, artifacts_dir, False


# ---------------------------------------------------------------------------
# V2 builds (Phase 7 T1): BuildResult + dataset manifest pointer
# ---------------------------------------------------------------------------


class BuildSummary(ContractModel):
    """One V2 build's listing entry: BuildResult + dataset manifest pointer."""

    build_id: str = Field(min_length=1)
    task_id: str = Field(min_length=1)
    dataset_family: str = Field(min_length=1)
    row_granularity: str = Field(min_length=1)
    schema_ref: str = Field(min_length=1)
    row_count: int = Field(ge=0)
    status: BuildResultStatus
    publication_id: str | None = None
    manifest_ref: str = Field(min_length=1)
    manifest_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    published_at: datetime | None = None
    build_result: BuildResult | None = None


class BuildPage(ContractModel):
    """One ascending page of V2 builds (newest manifest first)."""

    items: list[BuildSummary] = Field(default_factory=list)
    next_cursor: str | None = None


class BuildDetail(ContractModel):
    """One build's authoritative BuildResult with its manifest summary."""

    build_id: str = Field(min_length=1)
    task_id: str = Field(min_length=1)
    manifest_ref: str = Field(min_length=1)
    build_result: BuildResult | None = None
    manifest: DatasetManifest
    publication: DatasetPublication | None = None
    artifacts: list[ManifestArtifactEntry] = Field(default_factory=list)


_BUILD_CURSOR_SEPARATOR = "|"
_BUILD_MANIFEST_NAME = "dataset_manifest.json"


def _encode_build_cursor(mtime_ns: int, task_id: str, build_id: str) -> str:
    raw = f"{mtime_ns}{_BUILD_CURSOR_SEPARATOR}{task_id}{_BUILD_CURSOR_SEPARATOR}{build_id}"
    return base64.urlsafe_b64encode(raw.encode("utf-8")).decode("ascii").rstrip("=")


def _decode_build_cursor(cursor: str) -> tuple[int, str, str]:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        raw = base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")
        mtime_ns_str, task_id, build_id = raw.split(_BUILD_CURSOR_SEPARATOR, 2)
        return int(mtime_ns_str), task_id, build_id
    except (ValueError, UnicodeDecodeError, binascii.Error) as error:
        raise ValueError("invalid build cursor") from error


def _scan_build_dirs(tasks_dir: Path) -> list[tuple[Path, str, str]]:
    """Return ``(build_dir, task_id, build_id)`` for every V2 build manifest.

    A build is a ``datasets_build/<build_id>/dataset_manifest.json`` file
    inside a task directory — the manifest is the build's immutable record.
    """

    found: list[tuple[Path, str, str]] = []
    if not tasks_dir.is_dir():
        return found
    for task_dir in sorted(tasks_dir.iterdir(), key=lambda item: item.name):
        if not task_dir.is_dir() or task_dir.name.startswith("."):
            continue
        build_root = task_dir / "datasets_build"
        if not build_root.is_dir():
            continue
        for build_dir in sorted(build_root.iterdir(), key=lambda item: item.name):
            if not build_dir.is_dir() or build_dir.name.startswith("."):
                continue
            if (build_dir / _BUILD_MANIFEST_NAME).is_file():
                found.append((build_dir, task_dir.name, build_dir.name))
    return found


def _build_sort_key(item: tuple[Path, str, str]) -> tuple[int, str, str]:
    build_dir, task_id, build_id = item
    return (build_dir.stat().st_mtime_ns, task_id, build_id)


def _locate_build_id(
    tasks_dir: Path,
    build_id: str,
    task_id: str | None = None,
) -> tuple[str, Path] | None:
    """Locate the newest build dir with the given build_id.

    Build ids are agent-supplied and may collide across tasks, so
    ``task_id`` optionally scopes the search to one task (F7-02).
    """

    if _SAFE_RUNTIME_ID.fullmatch(build_id) is None:
        return None
    if task_id is not None and _SAFE_RUNTIME_ID.fullmatch(task_id) is None:
        return None
    best: tuple[int, str, Path] | None = None
    for build_dir, candidate_task, candidate in _scan_build_dirs(tasks_dir):
        if task_id is not None and candidate_task != task_id:
            continue
        if candidate != build_id:
            continue
        key = build_dir.stat().st_mtime_ns
        if best is None or key > best[0]:
            best = (key, candidate_task, build_dir)
    if best is None:
        return None
    return best[1], best[2]


def _load_build(
    tasks_dir: Path,
    task_id: str,
    build_id: str,
) -> tuple[Path, DatasetManifest, DatasetPublication | None] | None:
    """Load ``(build_dir, manifest, publication)`` for one V2 build.

    Returns ``None`` when the build does not exist; raises 409 when the
    manifest is present but invalid (a corrupt build must never be served).
    """

    if (
        _SAFE_RUNTIME_ID.fullmatch(task_id) is None
        or _SAFE_RUNTIME_ID.fullmatch(build_id) is None
    ):
        return None
    build_dir = (tasks_dir / task_id / "datasets_build" / build_id).resolve()
    try:
        build_dir.relative_to(tasks_dir.resolve())
    except ValueError:
        return None
    manifest_path = build_dir / _BUILD_MANIFEST_NAME
    if not manifest_path.is_file():
        return None
    try:
        manifest = DatasetManifest.model_validate_json(
            manifest_path.read_text("utf-8")
        )
    except (ValidationError, OSError, json.JSONDecodeError) as error:
        raise HTTPException(
            status_code=409, detail="Build manifest is invalid"
        ) from error
    if manifest.build_id != build_id:
        raise HTTPException(
            status_code=409, detail="Build manifest is invalid"
        )
    return build_dir, manifest, _load_build_publication(build_dir)


def _load_build_publication(build_dir: Path) -> DatasetPublication | None:
    """Load the newest immutable ``DatasetPublication`` record of a build."""

    publish_dir = build_dir / "publish"
    if not publish_dir.is_dir():
        return None
    newest: tuple[str, DatasetPublication] | None = None
    for child in publish_dir.iterdir():
        if not child.is_dir() or child.name.startswith("."):
            continue
        record_path = child / "publication.json"
        if not record_path.is_file():
            continue
        try:
            publication = DatasetPublication.model_validate_json(
                record_path.read_text("utf-8")
            )
        except (ValidationError, OSError, json.JSONDecodeError):
            continue
        key = publication.published_at.isoformat()
        if newest is None or key > newest[0]:
            newest = (key, publication)
    return newest[1] if newest is not None else None


def _derive_build_result(
    manifest: DatasetManifest,
    publication: DatasetPublication | None,
) -> BuildResult:
    """Deterministic BuildResult projection from the immutable manifest.

    Used when the durable run events do not carry an authoritative
    BuildResult for the build (pre-wiring builds or builds created outside a
    managed run). The durable event correlation in ``_resolve_build_result``
    wins whenever it can.
    """

    if publication is None or manifest.row_count == 0:
        return BuildResult(
            status=BuildResultStatus.NO_DATA,
            valid_row_count=0,
            rejected_sources=[],
            reason_codes=["no_primary_data"],
            user_summary=(
                f"build {manifest.build_id} produced no publishable data"
            ),
        )
    return BuildResult(
        status=BuildResultStatus.SUCCEEDED,
        valid_row_count=manifest.row_count,
        successful_sources=sorted(manifest.source_summary),
        publication_id=publication.publication_id,
        user_summary=(
            f"build {manifest.build_id} published "
            f"{manifest.row_count} valid row(s)"
        ),
    )


async def _resolve_build_result(
    repository: TaskRepository,
    task_id: str,
    manifest: DatasetManifest,
    publication: DatasetPublication | None,
    events: list[EventEnvelope] | None = None,
) -> BuildResult:
    """Authoritative BuildResult for a build.

    Phase 7 T1 seam 2: when the durable ``RunCompletedPayload`` carries the
    V2 BuildResult (wired by the executor from ``execute_dataset_build``),
    that result is returned — including PARTIAL_SUCCESS/NO_DATA envelopes the
    manifest alone cannot express. Falls back to the manifest projection.
    """

    if events is None:
        events = await repository.list_events(task_id)
    if publication is not None:
        for event in reversed(events):
            payload = event.payload
            if (
                isinstance(payload, RunCompletedPayload)
                and payload.build_result is not None
                and payload.build_result.publication_id
                == publication.publication_id
            ):
                return payload.build_result
        return _derive_build_result(manifest, publication)
    # C1e (F7-03): NO_DATA builds have no publication to correlate; match the
    # durable envelope by its stable build identity (stamped by the tool).
    for event in reversed(events):
        payload = event.payload
        if (
            isinstance(payload, RunCompletedPayload)
            and payload.build_result is not None
            and payload.build_result.build_id == manifest.build_id
        ):
            return payload.build_result
    return _derive_build_result(manifest, publication)


def _verified_build_artifact_path(build_dir: Path, relative_path: str) -> Path:
    file_path = (build_dir / relative_path).resolve()
    try:
        file_path.relative_to(build_dir.resolve())
    except ValueError as error:
        raise HTTPException(
            status_code=409, detail="Invalid build artifact path"
        ) from error
    if not file_path.is_file():
        raise HTTPException(
            status_code=409, detail="Registered build artifact is missing"
        )
    return file_path


@router.get("/builds", response_model=BuildPage)
async def list_builds(
    repository: TaskRepositoryDep,
    limit: Annotated[int | None, Query(ge=1)] = None,
    cursor: str | None = None,
) -> BuildPage:
    """Return one page of V2 builds (newest manifest first).

    Each item carries the BuildResult (durable events when available, else a
    manifest projection) and the task-relative dataset manifest pointer.
    """

    if cursor == "":
        raise HTTPException(status_code=422, detail="invalid build cursor")
    try:
        boundary = _decode_build_cursor(cursor) if cursor else None
    except ValueError as error:
        raise HTTPException(status_code=422, detail="invalid build cursor") from error
    page_limit = repository.settings.task_page_size if limit is None else limit
    maximum = repository.settings.task_page_max_size
    if page_limit < 1 or page_limit > maximum:
        raise HTTPException(
            status_code=422, detail=f"limit must be between 1 and {maximum}"
        )
    found = _scan_build_dirs(repository.tasks_dir)
    found.sort(key=_build_sort_key, reverse=True)
    if boundary is not None:
        found = [
            item for item in found if _build_sort_key(item) < boundary
        ]

    # Durable event correlation is per-task; load each task's events at most
    # once per request (NO_DATA builds carry no publication but the durable
    # ``RunCompletedPayload.build_result`` envelope is still authoritative —
    # C1e, F7-03 — so events load for every build).
    events_by_task: dict[str, list[EventEnvelope]] = {}

    async def events_for(task_id: str) -> list[EventEnvelope]:
        cached = events_by_task.get(task_id)
        if cached is None:
            cached = await repository.list_events(task_id)
            events_by_task[task_id] = cached
        return cached

    items: list[BuildSummary] = []
    for _build_dir, task_id, build_id in found:
        try:
            loaded = _load_build(repository.tasks_dir, task_id, build_id)
        except HTTPException as error:
            # R1C-01: a corrupt/truncated manifest must never take down
            # the whole listing — skip the broken build (the detail
            # endpoint still fails loudly with 409).
            if error.status_code == 409:
                continue
            raise
        if loaded is None:
            continue
        _resolved_build_dir, manifest, publication = loaded
        # NO_DATA builds carry no publication but the durable
        # ``RunCompletedPayload.build_result`` envelope is still authoritative
        # (C1e, F7-03) — load the task events for correlation either way.
        events = await events_for(task_id)
        build_result = await _resolve_build_result(
            repository,
            task_id,
            manifest,
            publication,
            events=events,
        )
        items.append(
            BuildSummary(
                build_id=build_id,
                task_id=task_id,
                dataset_family=manifest.dataset_family,
                row_granularity=manifest.row_granularity,
                schema_ref=manifest.schema_ref,
                row_count=manifest.row_count,
                status=(
                    build_result.status
                    if build_result is not None
                    else BuildResultStatus.NO_DATA
                ),
                publication_id=(
                    publication.publication_id
                    if publication is not None
                    else None
                ),
                manifest_ref=(
                    f"datasets_build/{build_id}/{_BUILD_MANIFEST_NAME}"
                ),
                manifest_sha256=manifest.sha256,
                published_at=(
                    publication.published_at
                    if publication is not None
                    else None
                ),
                build_result=build_result,
            )
        )
        if len(items) >= page_limit + 1:
            break
    next_cursor = None
    if len(items) > page_limit:
        items = items[:page_limit]
        last = items[-1]
        next_cursor = _encode_build_cursor(
            (repository.tasks_dir / last.task_id / "datasets_build" / last.build_id)
            .stat()
            .st_mtime_ns,
            last.task_id,
            last.build_id,
        )
    return BuildPage(items=items, next_cursor=next_cursor)


@router.get("/builds/{build_id}", response_model=BuildDetail)
async def get_build(
    build_id: str,
    repository: TaskRepositoryDep,
    task_id: str | None = Query(default=None),
) -> BuildDetail:
    """Return one build's BuildResult with its manifest summary.

    ``task_id`` disambiguates when the same build_id exists in several
    tasks (F7-02); without it the newest build wins.
    """

    located = _locate_build_id(repository.tasks_dir, build_id, task_id=task_id)
    if located is None:
        raise HTTPException(status_code=404, detail="Build not found")
    resolved_task_id, _build_dir = located
    loaded = _load_build(repository.tasks_dir, resolved_task_id, build_id)
    if loaded is None:
        raise HTTPException(status_code=404, detail="Build not found")
    _resolved_build_dir, manifest, publication = loaded
    # C1e (F7-03): NO_DATA builds have no publication but the durable
    # ``RunCompletedPayload.build_result`` envelope is still authoritative —
    # load the task events for build_id correlation either way.
    events = await repository.list_events(resolved_task_id)
    build_result = await _resolve_build_result(
        repository, resolved_task_id, manifest, publication, events=events
    )
    return BuildDetail(
        build_id=build_id,
        task_id=resolved_task_id,
        manifest_ref=f"datasets_build/{build_id}/{_BUILD_MANIFEST_NAME}",
        build_result=build_result,
        manifest=manifest,
        publication=publication,
        artifacts=manifest.artifacts,
    )


@router.get("/builds/{build_id}/artifacts/{artifact_id}")
async def get_build_artifact(
    build_id: str,
    artifact_id: str,
    repository: TaskRepositoryDep,
    task_id: str | None = Query(default=None),
):
    """Resolve a build artifact (manifest inventory + dataset manifest).

    ``task_id`` disambiguates colliding build ids across tasks (F7-02).
    """

    located = _locate_build_id(repository.tasks_dir, build_id, task_id=task_id)
    if located is None:
        raise HTTPException(status_code=404, detail="Artifact not found")
    resolved_task_id, build_dir = located
    loaded = _load_build(repository.tasks_dir, resolved_task_id, build_id)
    if loaded is None:
        raise HTTPException(status_code=404, detail="Artifact not found")
    resolved_build_dir, manifest, _publication = loaded
    if artifact_id == "dataset_manifest":
        file_path = resolved_build_dir / _BUILD_MANIFEST_NAME
        media_type = "application/json"
    else:
        entry = next(
            (
                candidate
                for candidate in manifest.artifacts
                if candidate.artifact_id == artifact_id
            ),
            None,
        )
        if entry is None:
            raise HTTPException(status_code=404, detail="Artifact not found")
        file_path = _verified_build_artifact_path(
            resolved_build_dir, entry.relative_path
        )
        if (
            file_path.stat().st_size != entry.size_bytes
            or _file_sha256(file_path) != entry.sha256
        ):
            raise HTTPException(
                status_code=409, detail="Artifact integrity check failed"
            )
        media_type = entry.media_type
    return FileResponse(str(file_path), filename=file_path.name, media_type=media_type)


# ---------------------------------------------------------------------------
# V2 dataset cache (Phase 7 T2): content-addressed cache + legacy wrapper
# ---------------------------------------------------------------------------


class CacheDatasetSummary(ContractModel):
    """One cached dataset entry (V2 cache or legacy 22-column record)."""

    dataset_id: str = Field(min_length=1)
    namespace: str = Field(min_length=1)
    dataset_family: str = Field(min_length=1)
    schema_ref: str = Field(min_length=1)
    row_count: int = Field(ge=0)
    published_at: str = Field(min_length=1)
    keywords: list[str] = Field(default_factory=list)
    manifest_ref: str = Field(min_length=1)


class CacheDatasetPage(ContractModel):
    """One page of cached datasets (newest first)."""

    items: list[CacheDatasetSummary] = Field(default_factory=list)


class CacheDatasetDetail(ContractModel):
    """One cache entry's manifest pointer + artifact inventory."""

    dataset_id: str = Field(min_length=1)
    namespace: str = Field(min_length=1)
    dataset_family: str = Field(min_length=1)
    schema_ref: str = Field(min_length=1)
    row_count: int = Field(ge=0)
    published_at: str = Field(min_length=1)
    keywords: list[str] = Field(default_factory=list)
    manifest_ref: str = Field(min_length=1)
    artifacts: list[ManifestArtifactEntry] = Field(default_factory=list)


#: Cache dataset ids and namespaces become path segments; both must stay
#: single safe components (V2 ids are ``dataset_<digest>``, legacy ids are
#: ``^[a-z0-9][a-z0-9_-]*$``).
_SAFE_CACHE_SEGMENT = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_CACHE_LIST_LIMIT = 200


def _cache_root(repository: TaskRepository) -> Path:
    """The cache root lives beside the tasks dir (``<output_dir>/../cache``)."""

    return repository.tasks_dir.parent.parent / "cache"


def _require_cache_namespace(namespace: str) -> str:
    if not _SAFE_CACHE_SEGMENT.fullmatch(namespace) or namespace in {".", ".."}:
        raise HTTPException(
            status_code=422, detail="invalid cache namespace"
        )
    return namespace


def _load_cache_entry_manifest(entry: CacheEntry) -> DatasetManifest:
    """The authoritative ``dataset_manifest.json`` of a V2 cache entry."""

    manifest_path = entry.directory / "dataset_manifest.json"
    try:
        manifest = DatasetManifest.model_validate_json(
            manifest_path.read_text("utf-8")
        )
    except (ValidationError, OSError, json.JSONDecodeError) as error:
        raise HTTPException(
            status_code=409, detail="Cache entry manifest is invalid"
        ) from error
    if manifest.manifest_id != entry.manifest_id:
        raise HTTPException(
            status_code=409, detail="Cache entry manifest is invalid"
        )
    return manifest


def _verified_cache_artifact_path(entry_dir: Path, relative_path: str) -> Path:
    """Resolve a cache artifact inside its entry directory (path-guarded)."""

    file_path = (entry_dir / relative_path).resolve()
    try:
        file_path.relative_to(entry_dir.resolve())
    except ValueError as error:
        raise HTTPException(
            status_code=409, detail="Invalid cache artifact path"
        ) from error
    if not file_path.is_file():
        raise HTTPException(
            status_code=409, detail="Registered artifact is missing"
        )
    return file_path


def _find_v2_global(cache: DatasetCacheV2, dataset_id: str) -> CacheEntry | None:
    """Locate a V2 cache entry by dataset_id across every namespace."""

    for entry in cache.list(limit=10_000):
        if entry.dataset_id == dataset_id:
            return entry
    return None


def _resolve_cache_dataset(
    repository: TaskRepository,
    dataset_id: str,
    namespace: str | None,
) -> CacheEntry | LegacyCacheEntry | None:
    """Resolve a cache dataset: V2 first, then the legacy records tree."""

    if not _SAFE_CACHE_SEGMENT.fullmatch(dataset_id):
        return None
    cache = DatasetCacheV2(_cache_root(repository))
    if namespace is not None:
        _require_cache_namespace(namespace)
        v2_entry = cache.find(namespace, dataset_id)
        if v2_entry is not None:
            return v2_entry
        return find_legacy(_cache_root(repository), namespace, dataset_id)
    v2_entry = _find_v2_global(cache, dataset_id)
    if v2_entry is not None:
        return v2_entry
    return find_legacy_global(_cache_root(repository), dataset_id)


def _keyword_hits(entry: CacheEntry | LegacyCacheEntry, keyword: str) -> bool:
    """Keyword filter over cache entry metadata (search-only, not identity)."""

    needle = keyword.strip().lower()
    if not needle:
        return True
    legacy_manifest = getattr(entry, "manifest", None)
    return (
        needle in entry.dataset_family.lower()
        or needle in entry.schema_ref.lower()
        or needle in getattr(entry, "build_id", "").lower()
        or any(needle in kw.lower() for kw in entry.keywords)
        or (
            legacy_manifest is not None
            and (
                needle in legacy_manifest.topic.lower()
                or needle in legacy_manifest.description.lower()
            )
        )
    )


def _cache_summary_v2(entry: CacheEntry) -> CacheDatasetSummary:
    return CacheDatasetSummary(
        dataset_id=entry.dataset_id,
        namespace=entry.namespace,
        dataset_family=entry.dataset_family,
        schema_ref=entry.schema_ref,
        row_count=entry.row_count,
        published_at=entry.published_at,
        keywords=list(entry.keywords),
        manifest_ref=(
            f"cache/datasets/{entry.namespace}/{entry.dataset_id}"
            "/dataset_manifest.json"
        ),
    )


def _cache_summary_legacy(entry: LegacyCacheEntry) -> CacheDatasetSummary:
    return CacheDatasetSummary(
        dataset_id=entry.dataset_id,
        namespace=entry.namespace,
        dataset_family=entry.dataset_family,
        schema_ref=entry.schema_ref,
        row_count=entry.row_count,
        published_at=entry.published_at,
        keywords=list(entry.keywords),
        manifest_ref=(
            f"cache/records/{entry.namespace}/{entry.dataset_id}/manifest.json"
        ),
    )


def _task_build_identity(
    tasks_dir: Path, task_id: str
) -> tuple[set[str], set[str]]:
    """Return ``(build_ids, sha256 digests)`` of a task's V2 build manifests.

    A build lives at ``tasks_dir/<task_id>/datasets_build/<build_id>/``
    (``_scan_build_dirs``). The manifests written there are byte-identical to
    the committed cache entries (``cache.commit`` copies the build dir), so
    build_id + digest pin the exact cache entry for this task — even when two
    tasks reuse the same build_id with different content.
    """

    build_ids: set[str] = set()
    digests: set[str] = set()
    build_root = tasks_dir / task_id / "datasets_build"
    if not build_root.is_dir():
        return build_ids, digests
    for build_dir in sorted(build_root.iterdir(), key=lambda item: item.name):
        if not build_dir.is_dir() or build_dir.name.startswith("."):
            continue
        manifest_path = build_dir / _BUILD_MANIFEST_NAME
        if not manifest_path.is_file():
            continue
        try:
            manifest = DatasetManifest.model_validate_json(
                manifest_path.read_text("utf-8")
            )
        except (ValidationError, OSError, json.JSONDecodeError):
            continue
        build_ids.add(manifest.build_id)
        digests.add(manifest.sha256)
    return build_ids, digests


def _cache_artifacts_for_task(
    repository: TaskRepository,
    task_id: str,
) -> tuple[DatasetManifest, Path] | None:
    """Newest V2 cache entry whose build belongs to ``task_id``.

    The content-addressed cache is authoritative for V2 builds: the legacy
    artifact endpoints read it first and fall back to the V1 ``artifacts/``
    dirs (dual-read, Phase 7 T2).

    F7-01: the entry is tied to the task via the dataset build directory
    shape (``tasks_dir/<task_id>/datasets_build/<build_id>/``) — the
    expression runner stamps the manifest's ``task_id`` field with the
    agent-supplied build_id, so matching on ``manifest.task_id`` never fires
    in production.
    """

    task_build_ids, task_digests = _task_build_identity(
        repository.tasks_dir, task_id
    )
    if not task_build_ids:
        return None
    cache = DatasetCacheV2(_cache_root(repository))
    for entry in cache.list(namespace="build", limit=10_000):
        manifest_path = entry.directory / "dataset_manifest.json"
        try:
            manifest = DatasetManifest.model_validate_json(
                manifest_path.read_text("utf-8")
            )
        except (ValidationError, OSError, json.JSONDecodeError):
            continue
        if manifest.build_id not in task_build_ids:
            continue
        if manifest.sha256 not in task_digests:
            continue
        return manifest, entry.directory
    return None


@router.get("/cache/datasets", response_model=CacheDatasetPage)
async def list_cache_datasets(
    repository: TaskRepositoryDep,
    namespace: str | None = Query(default=None),
    keyword: str | None = Query(default=None),
    limit: Annotated[int | None, Query(ge=1)] = None,
) -> CacheDatasetPage:
    """Return cached datasets: V2 cache entries plus legacy 22-column records.

    ``namespace`` filters one cache namespace (V2 ``cache/datasets/<ns>`` or
    legacy ``cache/records/<ns>``); ``keyword`` filters entry metadata
    (family / schema ref / build id / keywords — search-only, never part of
    the content-addressed identity).
    """

    if namespace is not None:
        _require_cache_namespace(namespace)
    page_limit = min(limit if limit is not None else 50, _CACHE_LIST_LIMIT)
    cache = DatasetCacheV2(_cache_root(repository))
    items: list[CacheDatasetSummary] = []
    for entry in cache.list(namespace=namespace, limit=10_000):
        if _keyword_hits(entry, keyword or ""):
            items.append(_cache_summary_v2(entry))
    for entry in list_legacy(_cache_root(repository), namespace=namespace):
        if _keyword_hits(entry, keyword or ""):
            items.append(_cache_summary_legacy(entry))
    items.sort(key=lambda item: item.published_at, reverse=True)
    return CacheDatasetPage(items=items[:page_limit])


@router.get("/cache/datasets/{dataset_id}", response_model=CacheDatasetDetail)
async def get_cache_dataset(
    dataset_id: str,
    repository: TaskRepositoryDep,
    namespace: str | None = Query(default=None),
) -> CacheDatasetDetail:
    """Return one cache entry's manifest pointer + artifact inventory.

    ``namespace`` disambiguates when the same dataset_id exists in both the
    V2 cache and the legacy records tree; without it the V2 cache wins.
    """

    resolved = _resolve_cache_dataset(repository, dataset_id, namespace)
    if resolved is None:
        raise HTTPException(status_code=404, detail="Dataset not found")
    if isinstance(resolved, CacheEntry):
        manifest = _load_cache_entry_manifest(resolved)
        return CacheDatasetDetail(
            dataset_id=resolved.dataset_id,
            namespace=resolved.namespace,
            dataset_family=resolved.dataset_family,
            schema_ref=resolved.schema_ref,
            row_count=resolved.row_count,
            published_at=resolved.published_at,
            keywords=list(resolved.keywords),
            manifest_ref=(
                f"cache/datasets/{resolved.namespace}/{resolved.dataset_id}"
                "/dataset_manifest.json"
            ),
            artifacts=manifest.artifacts,
        )
    return CacheDatasetDetail(
        dataset_id=resolved.dataset_id,
        namespace=resolved.namespace,
        dataset_family=resolved.dataset_family,
        schema_ref=resolved.schema_ref,
        row_count=resolved.row_count,
        published_at=resolved.published_at,
        keywords=list(resolved.keywords),
        manifest_ref=(
            f"cache/records/{resolved.namespace}/{resolved.dataset_id}"
            "/manifest.json"
        ),
        artifacts=legacy_artifacts(resolved),
    )


@router.get("/cache/datasets/{dataset_id}/artifacts/{artifact_id}")
async def get_cache_dataset_artifact(
    dataset_id: str,
    artifact_id: str,
    repository: TaskRepositoryDep,
    namespace: str | None = Query(default=None),
):
    """Download one cached dataset artifact.

    V2 entries resolve through the entry manifest (plus the special
    ``dataset_manifest`` id); legacy entries serve ``main_data`` /
    ``manifest`` from the records tree.
    """

    resolved = _resolve_cache_dataset(repository, dataset_id, namespace)
    if resolved is None:
        raise HTTPException(status_code=404, detail="Artifact not found")
    if isinstance(resolved, CacheEntry):
        manifest = _load_cache_entry_manifest(resolved)
        if artifact_id == "dataset_manifest":
            file_path = resolved.directory / "dataset_manifest.json"
            media_type = "application/json"
        else:
            entry = next(
                (
                    candidate
                    for candidate in manifest.artifacts
                    if candidate.artifact_id == artifact_id
                ),
                None,
            )
            if entry is None:
                raise HTTPException(
                    status_code=404, detail="Artifact not found"
                )
            file_path = _verified_cache_artifact_path(
                resolved.directory, entry.relative_path
            )
            if (
                file_path.stat().st_size != entry.size_bytes
                or _file_sha256(file_path) != entry.sha256
            ):
                raise HTTPException(
                    status_code=409, detail="Artifact integrity check failed"
                )
            media_type = entry.media_type
    else:
        if artifact_id == "main_data":
            file_path = resolved.directory / "main_data.csv"
            media_type = "text/csv"
        elif artifact_id == "manifest":
            file_path = resolved.directory / "manifest.json"
            media_type = "application/json"
        else:
            raise HTTPException(status_code=404, detail="Artifact not found")
        if not file_path.is_file():
            raise HTTPException(
                status_code=409, detail="Registered artifact is missing"
            )
    return FileResponse(str(file_path), filename=file_path.name, media_type=media_type)
