from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

import app.api.routes as routes_module
from app.main import app
from app.pipeline.pinned_case import run_pinned_fixture


FIXTURE_DIR = (
    Path(__file__).parents[1] / "fixtures" / "ncbi" / "gse178352"
)


@pytest.mark.asyncio
async def test_artifact_api_lists_manifest_entries_and_downloads_by_artifact_id(
    tmp_path: Path, monkeypatch
) -> None:
    output_dir = tmp_path / "output"
    manifest = run_pinned_fixture(
        task_id="task_api",
        base_dir=output_dir / "tasks",
        fixture_dir=FIXTURE_DIR,
    )
    monkeypatch.setattr(routes_module, "settings", SimpleNamespace(output_dir=str(output_dir)))
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.get("/api/v1/tasks/task_api/artifacts")
        artifacts = response.json()["artifacts"]
        main_entry = next(entry for entry in artifacts if entry["name"] == "main_data.csv")
        download = await client.get(
            f"/api/v1/tasks/task_api/artifacts/{main_entry['artifact_id']}"
        )

    assert response.status_code == 200
    assert len(artifacts) == len(manifest.artifacts) + 1
    assert main_entry["artifact_id"].startswith("artifact_")
    assert "path" not in main_entry
    assert download.status_code == 200
    assert download.headers["content-disposition"].endswith('filename="main_data.csv"')
    assert download.content.startswith(b"record_id,dataset_id,source_id")


@pytest.mark.asyncio
async def test_artifact_api_rejects_unregistered_filename_and_invalid_manifest(
    tmp_path: Path, monkeypatch
) -> None:
    output_dir = tmp_path / "output"
    run_pinned_fixture(
        task_id="task_api_invalid",
        base_dir=output_dir / "tasks",
        fixture_dir=FIXTURE_DIR,
    )
    monkeypatch.setattr(routes_module, "settings", SimpleNamespace(output_dir=str(output_dir)))
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        assert (await client.get(
            "/api/v1/tasks/task_api_invalid/artifacts/main_data.csv"
        )).status_code == 404

        manifest_path = (
            output_dir / "tasks" / "task_api_invalid" / "artifacts" / "run_manifest.json"
        )
        text = manifest_path.read_text("utf-8").replace(
            '"status": "valid"', '"status": "invalid"'
        )
        manifest_path.write_text(text, "utf-8")

        assert (await client.get(
            "/api/v1/tasks/task_api_invalid/artifacts"
        )).status_code == 409
