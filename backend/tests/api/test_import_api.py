"""HTTP API tests for ``POST /api/v1/import/tasks`` multipart endpoint.

Covers:
  - 202 + TaskRunAccepted when one valid file is uploaded
  - 422 when no files are provided
  - 422 when too many files are provided
  - 413 when a file exceeds the size limit
  - 422 when filenames are invalid / duplicated
  - Uploaded files are persisted to the task's ``source_assets/`` directory
  - Created task has ``mode=import`` and a non-empty ``input``
"""

from __future__ import annotations

import asyncio
import threading
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from app.config import Settings
from app.domain.contracts import StartTaskRequest, TaskRunAccepted
from app.main import create_app
from app.runtime.manager import TaskManager
from app.runtime.repository import TaskRepository
from app.tools._registry import BUILTIN_SKILL_MODULES  # noqa: F401 — ensure import
from app.tools.workdir import create_task_workdir
from fastapi import HTTPException, Request
from starlette.datastructures import UploadFile


def _settings(tmp_path: Path) -> Settings:
    return Settings(output_dir=str(tmp_path / "output"))


def _task_directories(tmp_path: Path) -> list[Path]:
    tasks_dir = tmp_path / "output" / "tasks"
    return [
        path
        for path in tasks_dir.iterdir()
        if path.is_dir() and path.name != ".uploads"
    ]


def _request_with_manager(manager: object) -> Request:
    application = SimpleNamespace(state=SimpleNamespace(task_manager=manager))
    return Request({"type": "http", "app": application})


def test_import_tasks_synchronize_upload_parent_lifecycle(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.api import routes

    first_upload_waiting = threading.Event()
    release_first_upload = threading.Event()
    second_mkdtemp_entered = threading.Event()
    release_second_mkdtemp = threading.Event()
    first_request_finished = threading.Event()
    mkdtemp_calls = 0
    mkdtemp_calls_lock = threading.Lock()
    real_mkdtemp = routes.tempfile.mkdtemp

    def controlled_mkdtemp(*args, **kwargs) -> str:
        nonlocal mkdtemp_calls
        with mkdtemp_calls_lock:
            mkdtemp_calls += 1
            call_number = mkdtemp_calls
        if call_number == 2:
            second_mkdtemp_entered.set()
            assert release_second_mkdtemp.wait(timeout=5)
        return real_mkdtemp(*args, **kwargs)

    class BlockingUploadFile(UploadFile):
        async def read(self, size: int = -1) -> bytes:
            chunk = await super().read(size)
            if not chunk:
                first_upload_waiting.set()
                assert release_first_upload.wait(timeout=5)
            return chunk

    class AcceptingManager:
        async def create_task(self, request, *, prepare_task=None) -> TaskRunAccepted:
            return TaskRunAccepted(
                request_id=request.request_id,
                task_id=f"task_{request.request_id}",
                run_id=f"run_{request.request_id}",
            )

    monkeypatch.setattr(routes.tempfile, "mkdtemp", controlled_mkdtemp)
    repository = TaskRepository(tmp_path / "output")
    manager = AcceptingManager()
    errors: list[BaseException] = []

    def run_request(request_id: str, upload: UploadFile) -> None:
        try:
            asyncio.run(
                routes.create_import_task(
                    http_request=_request_with_manager(manager),
                    repository=repository,
                    request_id=request_id,
                    input="concurrent upload",
                    files=[upload],
                )
            )
        except BaseException as error:
            errors.append(error)
        finally:
            if request_id == "first":
                first_request_finished.set()

    first_thread = threading.Thread(
        target=run_request,
        args=(
            "first",
            BlockingUploadFile(filename="first.csv", file=BytesIO(b"first")),
        ),
    )
    second_thread = threading.Thread(
        target=run_request,
        args=(
            "second",
            UploadFile(filename="second.csv", file=BytesIO(b"second")),
        ),
    )

    first_thread.start()
    assert first_upload_waiting.wait(timeout=5)
    second_thread.start()
    assert second_mkdtemp_entered.wait(timeout=5)
    release_first_upload.set()
    first_request_finished.wait(timeout=1)
    release_second_mkdtemp.set()
    first_thread.join(timeout=5)
    second_thread.join(timeout=5)

    assert not first_thread.is_alive()
    assert not second_thread.is_alive()
    assert errors == []
    assert not (repository.tasks_dir / ".uploads").exists()


@pytest.mark.asyncio
async def test_import_tasks_creates_task_and_persists_files(tmp_path: Path) -> None:
    application = create_app(_settings(tmp_path))
    executor_observed = asyncio.Event()
    observed_files: dict[str, bytes] | None = None
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url="http://localhost",
    ) as client:
        async def probe_executor(execution) -> None:
            nonlocal observed_files
            observed_files = {
                path.name: path.read_bytes()
                for path in execution.context.work_dir.source_assets.iterdir()
            }
            executor_observed.set()

        application.state.task_manager.run_executor = probe_executor
        files = [
            ("files", ("patients.csv", b"patient_id,age\nP001,54\n", "text/csv")),
            ("files", ("metadata.json", b'{"cohort": "A"}', "application/json")),
        ]
        response = await client.post(
            "/api/v1/import/tasks",
            data={"request_id": "req-001", "input": "Import patients data"},
            files=files,
        )
        await asyncio.wait_for(executor_observed.wait(), timeout=1)

    assert response.status_code == 202, response.text
    payload = response.json()
    assert payload["request_id"] == "req-001"
    assert payload["status"] == "queued"
    task_id = payload["task_id"]
    assert task_id

    # Assets are published to the accepted task before its executor can observe it.
    assert observed_files == {
        "patients.csv": b"patient_id,age\nP001,54\n",
        "metadata.json": b'{"cohort": "A"}',
    }
    workdir = create_task_workdir(
        task_id,
        base_dir=str(tmp_path / "output" / "tasks"),
    )
    saved = workdir.source_asset_file("patients.csv")
    assert saved.is_file()
    assert saved.read_text(encoding="utf-8") == "patient_id,age\nP001,54\n"
    assert workdir.source_asset_file("metadata.json").read_bytes() == b'{"cohort": "A"}'


@pytest.mark.asyncio
async def test_import_tasks_rejects_no_files(tmp_path: Path) -> None:
    application = create_app(_settings(tmp_path))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url="http://localhost",
    ) as client:
        response = await client.post(
            "/api/v1/import/tasks",
            data={"request_id": "req-002", "input": "no files"},
            files=[],
        )

    assert response.status_code == 422
    assert "At least one file" in response.text


@pytest.mark.asyncio
async def test_import_tasks_rejects_too_many_files(tmp_path: Path) -> None:
    """More than 10 files (``_IMPORT_MAX_FILES``) is rejected with 422."""
    from app.api.routes import _IMPORT_MAX_FILES

    application = create_app(_settings(tmp_path))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url="http://localhost",
    ) as client:
        files = [
            ("files", (f"f{i}.csv", b"a,b\n1,2\n", "text/csv"))
            for i in range(_IMPORT_MAX_FILES + 1)
        ]
        response = await client.post(
            "/api/v1/import/tasks",
            data={"request_id": "req-003", "input": "too many"},
            files=files,
        )

    assert response.status_code == 422
    assert "Too many files" in response.text
    assert _task_directories(tmp_path) == []


@pytest.mark.asyncio
async def test_import_tasks_rejects_oversized_file(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Files larger than ``_IMPORT_MAX_FILE_BYTES`` are rejected with 413."""
    import app.api.routes as routes_module

    monkeypatch.setattr(routes_module, "_IMPORT_MAX_FILE_BYTES", 5)

    application = create_app(_settings(tmp_path))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url="http://localhost",
    ) as client:
        # Upload one byte more than allowed.
        big = b"x" * 6
        files = [("files", ("big.csv", big, "text/csv"))]
        response = await client.post(
            "/api/v1/import/tasks",
            data={"request_id": "req-004", "input": "big file"},
            files=files,
        )

    assert response.status_code == 413
    assert "exceeds max size" in response.text
    assert _task_directories(tmp_path) == []
    assert not (tmp_path / "output" / "tasks" / ".uploads").exists()


@pytest.mark.asyncio
async def test_import_tasks_rejects_total_upload_over_limit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app.api.routes as routes_module

    monkeypatch.setattr(routes_module, "_IMPORT_MAX_TOTAL_BYTES", 5)
    application = create_app(_settings(tmp_path))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url="http://localhost",
    ) as client:
        response = await client.post(
            "/api/v1/import/tasks",
            data={"request_id": "req-total-limit", "input": "too much total"},
            files=[
                ("files", ("a.csv", b"abc", "text/csv")),
                ("files", ("b.csv", b"def", "text/csv")),
            ],
        )

    assert response.status_code == 413
    assert "Total upload size exceeds limit" in response.text
    assert _task_directories(tmp_path) == []
    assert not (tmp_path / "output" / "tasks" / ".uploads").exists()


@pytest.mark.asyncio
async def test_import_tasks_rejects_duplicate_filenames(tmp_path: Path) -> None:
    application = create_app(_settings(tmp_path))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url="http://localhost",
    ) as client:
        files = [
            ("files", ("patients.csv", b"a\n1\n", "text/csv")),
            ("files", ("patients.csv", b"b\n2\n", "text/csv")),
        ]
        response = await client.post(
            "/api/v1/import/tasks",
            data={"request_id": "req-005", "input": "dup"},
            files=files,
        )

    assert response.status_code == 422
    assert "Duplicate" in response.text
    assert _task_directories(tmp_path) == []


@pytest.mark.asyncio
async def test_import_tasks_cleans_staged_partial_upload_after_io_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    reads = 0

    async def fail_after_first_chunk(self: UploadFile, size: int = -1) -> bytes:
        nonlocal reads
        reads += 1
        if reads == 1:
            return b"partial"
        raise OSError("upload read failed")

    monkeypatch.setattr(UploadFile, "read", fail_after_first_chunk)
    application = create_app(_settings(tmp_path))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application, raise_app_exceptions=False),
        base_url="http://localhost",
    ) as client:
        response = await client.post(
            "/api/v1/import/tasks",
            data={"request_id": "req-partial", "input": "partial upload"},
            files=[("files", ("partial.csv", b"a,b\n1,2\n", "text/csv"))],
        )

    assert response.status_code == 500
    assert _task_directories(tmp_path) == []
    assert not (tmp_path / "output" / "tasks" / ".uploads").exists()


@pytest.mark.asyncio
async def test_import_tasks_stages_then_cleans_when_runtime_is_unavailable(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.api import routes

    staging_directories_created = 0
    upload_close_calls = 0
    real_mkdtemp = routes.tempfile.mkdtemp
    real_close = UploadFile.close

    def track_mkdtemp(*args, **kwargs) -> str:
        nonlocal staging_directories_created
        staging_directories_created += 1
        return real_mkdtemp(*args, **kwargs)

    async def track_close(self: UploadFile) -> None:
        nonlocal upload_close_calls
        upload_close_calls += 1
        await real_close(self)

    monkeypatch.setattr(routes.tempfile, "mkdtemp", track_mkdtemp)
    monkeypatch.setattr(UploadFile, "close", track_close)
    application = create_app(_settings(tmp_path))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url="http://localhost",
    ) as client:
        application.state.task_manager = None
        response = await client.post(
            "/api/v1/import/tasks",
            data={"request_id": "req-runtime-unavailable", "input": "stage first"},
            files=[("files", ("patients.csv", b"id\n1\n", "text/csv"))],
        )

    assert response.status_code == 503
    assert staging_directories_created == 1
    assert upload_close_calls >= 2
    assert _task_directories(tmp_path) == []
    assert not (tmp_path / "output" / "tasks" / ".uploads").exists()


@pytest.mark.asyncio
async def test_import_tasks_queue_full_cleans_staging_without_creating_task(
    tmp_path: Path,
) -> None:
    application = create_app(
        Settings(
            output_dir=str(tmp_path / "output"),
            runtime_max_active_runs=1,
            runtime_run_queue_size=1,
        )
    )
    active_started = asyncio.Event()
    release_active = asyncio.Event()
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url="http://localhost",
    ) as client:
        async def block_executor(execution) -> None:
            if execution.input == "active":
                active_started.set()
                await release_active.wait()

        manager = application.state.task_manager
        manager.run_executor = block_executor
        active = await manager.create_task(
            StartTaskRequest(request_id="req-active", input="active")
        )
        await asyncio.wait_for(active_started.wait(), timeout=1)
        queued = await manager.create_task(
            StartTaskRequest(request_id="req-queued", input="queued")
        )
        try:
            response = await client.post(
                "/api/v1/import/tasks",
                data={"request_id": "req-queue-full", "input": "must clean"},
                files=[("files", ("patients.csv", b"id\n1\n", "text/csv"))],
            )
        finally:
            release_active.set()

    assert response.status_code == 429
    assert {path.name for path in _task_directories(tmp_path)} == {
        active.task_id,
        queued.task_id,
    }
    assert not (tmp_path / "output" / "tasks" / ".uploads").exists()


@pytest.mark.asyncio
async def test_import_tasks_cleanup_survives_upload_close_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app.api.routes as routes_module
    from app.api.routes import create_import_task

    monkeypatch.setattr(routes_module, "_IMPORT_MAX_FILE_BYTES", 5)

    class CloseFailingUploadFile(UploadFile):
        async def close(self) -> None:
            raise OSError("upload close failed")

    async def run_executor(_execution) -> None:
        return None

    repository = TaskRepository(tmp_path / "output")
    manager = TaskManager(repository, run_executor=run_executor)
    upload = CloseFailingUploadFile(
        filename="oversized.csv",
        file=BytesIO(b"x" * 6),
    )

    with pytest.raises(HTTPException) as captured:
        await create_import_task(
            http_request=_request_with_manager(manager),
            repository=repository,
            request_id="req-close-failure",
            input="oversized upload",
            files=[upload],
        )

    assert captured.value.status_code == 413
    assert not (repository.tasks_dir / ".uploads").exists()


@pytest.mark.asyncio
async def test_import_task_has_import_mode_and_composed_input(
    tmp_path: Path,
) -> None:
    """The created task must have ``mode=import`` and a non-empty input."""
    application = create_app(_settings(tmp_path))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url="http://localhost",
    ) as client:
        files = [
            ("files", ("a.csv", b"x,y\n1,2\n", "text/csv")),
            ("files", ("b.json", b'{"k": 1}', "application/json")),
        ]
        response = await client.post(
            "/api/v1/import/tasks",
            data={"request_id": "req-006", "input": "multi-file import"},
            files=files,
        )
        assert response.status_code == 202
        task_id = response.json()["task_id"]

        # Verify the task snapshot via GET.
        snapshot = await client.get(f"/api/v1/tasks/{task_id}")

    assert snapshot.status_code == 200
    task = snapshot.json()["task"]
    assert task["mode"] == "import"
    # The composed input includes both the user note and the file list.
    title = task["title"]
    assert "multi-file import" in title or "a.csv" in title
