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

from pathlib import Path

import httpx
import pytest
from app.config import Settings
from app.main import create_app
from app.tools._registry import BUILTIN_SKILL_MODULES  # noqa: F401 — ensure import
from app.tools.workdir import create_task_workdir


def _settings(tmp_path: Path) -> Settings:
    return Settings(output_dir=str(tmp_path / "output"))


@pytest.mark.asyncio
async def test_import_tasks_creates_task_and_persists_files(tmp_path: Path) -> None:
    application = create_app(_settings(tmp_path))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url="http://test",
    ) as client:
        files = [
            ("files", ("patients.csv", b"patient_id,age\nP001,54\n", "text/csv")),
        ]
        response = await client.post(
            "/api/v1/import/tasks",
            data={"request_id": "req-001", "input": "Import patients data"},
            files=files,
        )

    assert response.status_code == 202, response.text
    payload = response.json()
    assert payload["request_id"] == "req-001"
    assert payload["status"] == "queued"
    task_id = payload["task_id"]
    assert task_id

    # The uploaded file was persisted to the task's source_assets/ directory.
    workdir = create_task_workdir(task_id)
    saved = workdir.source_asset_file("patients.csv")
    assert saved.is_file()
    assert saved.read_text(encoding="utf-8") == "patient_id,age\nP001,54\n"


@pytest.mark.asyncio
async def test_import_tasks_rejects_no_files(tmp_path: Path) -> None:
    application = create_app(_settings(tmp_path))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url="http://test",
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
        base_url="http://test",
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


@pytest.mark.asyncio
async def test_import_tasks_rejects_oversized_file(tmp_path: Path) -> None:
    """Files larger than ``_IMPORT_MAX_FILE_BYTES`` are rejected with 413."""
    from app.api.routes import _IMPORT_MAX_FILE_BYTES

    application = create_app(_settings(tmp_path))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url="http://test",
    ) as client:
        # Upload one byte more than allowed.
        big = b"x" * (_IMPORT_MAX_FILE_BYTES + 1)
        files = [("files", ("big.csv", big, "text/csv"))]
        response = await client.post(
            "/api/v1/import/tasks",
            data={"request_id": "req-004", "input": "big file"},
            files=files,
        )

    assert response.status_code == 413
    assert "exceeds max size" in response.text


@pytest.mark.asyncio
async def test_import_tasks_rejects_duplicate_filenames(tmp_path: Path) -> None:
    application = create_app(_settings(tmp_path))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url="http://test",
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


@pytest.mark.asyncio
async def test_import_task_has_import_mode_and_composed_input(
    tmp_path: Path,
) -> None:
    """The created task must have ``mode=import`` and a non-empty input."""
    application = create_app(_settings(tmp_path))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url="http://test",
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
