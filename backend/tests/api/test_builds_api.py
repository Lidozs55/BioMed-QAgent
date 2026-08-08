"""Builds API tests (Phase 7 T1).

``GET /api/v1/builds`` — paginated build list (BuildResult + dataset
manifest pointer); ``GET /api/v1/builds/{build_id}`` — single BuildResult
with manifest summary; ``GET /api/v1/builds/{build_id}/artifacts/{id}`` —
build artifact download (manifest-registered files + dataset_manifest).
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest
from agents.tool_context import ToolContext
from app.agent_loop.context import RunContext
from app.config import Settings
from app.domain.contracts import (
    PublicationCreatedPayload,
    RunCompletedPayload,
    RunFinalizingPayload,
    RunRecord,
    RunStatus,
    TaskMode,
    TaskSnapshot,
    TaskSummary,
)
from app.domain.contracts.dataset_state import BuildResult, BuildResultStatus
from app.main import create_app
from app.pipeline.dataset_build_tool import execute_dataset_build
from app.tools.workdir import create_task_workdir
from fastapi import FastAPI

NOW = datetime(2026, 7, 14, tzinfo=UTC)


@asynccontextmanager
async def api_client(
    tmp_path: Path,
) -> AsyncIterator[tuple[FastAPI, httpx.AsyncClient]]:
    application = create_app(Settings(output_dir=str(tmp_path / "isolated-output")))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url="http://localhost",
    ) as client:
        yield application, client


def _geo_spec_json(build_id: str) -> str:
    return json.dumps(
        {
            "build_id": build_id,
            "objective": "compare GEO probe expression",
            "dataset_family": "gene_expression",
            "row_granularity": "probe_sample_measurement",
            "schema_ref": "gene_expression.probe_long.v1",
            "source_bindings": [
                {
                    "binding_id": "binding_geo",
                    "source": "geo",
                    "accession": "GSE1",
                    "acquisition": {"mode": "builtin", "provider_id": "geo.series.v1"},
                    "adapter_id": "geo.expression.v1",
                    "parameters": {
                        "format": "series_matrix",
                        "value_semantics": "expression_value",
                        "value_scale": "log2",
                        "expression_unit": "log2_expression",
                        "platform_ids": ["GPL570"],
                    },
                }
            ],
            "merge_strategy": "append_by_canonical_row",
            "validation_profile_ref": "gene_expression.probe_release.v1",
            "normalization_profile_ref": "gene_expression.normalization.v1",
        }
    )


async def _run_build(
    repository: object,
    task_id: str,
    build_id: str,
    rows: list[tuple[str, str, str]] | None = None,
) -> dict[str, object]:
    """Run one V2 build inside the repository's task directory."""
    import gzip

    rc = RunContext(task_id=task_id)
    rc._work_dir = create_task_workdir(task_id, base_dir=str(repository.tasks_dir))
    matrix = rc.work_dir.source_asset_file("geo_matrix.txt.gz")
    rows = rows or [("AFFX-BioB-5", "1.5", "2.0"), ("AFFX-BioB-6", "3.0", "4.0")]
    lines = ["!series_matrix_table_begin", '"ID_REF"\t"GSM1"\t"GSM2"']
    lines.extend(f'"{probe}"\t{v1}\t{v2}' for probe, v1, v2 in rows)
    lines.append("!series_matrix_table_end")
    with gzip.open(matrix, "wt", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")
    tool = ToolContext(
        context=rc,
        tool_name="execute_dataset_build",
        tool_call_id="seed",
        tool_arguments="{}",
    )
    data = json.loads(
        await execute_dataset_build.on_invoke_tool(
            tool,
            json.dumps(
                {
                    "spec": _geo_spec_json(build_id),
                    "source_files": json.dumps(
                        {"binding_geo": "source_assets/geo_matrix.txt.gz"}
                    ),
                }
            ),
        )
    )
    assert data["status"] == "ok"
    return data


@pytest.mark.asyncio
async def test_builds_api_lists_builds_with_result_and_manifest_pointer(
    tmp_path: Path,
) -> None:
    async with api_client(tmp_path) as (application, client):
        repository = application.state.task_repository
        await _run_build(repository, "task_a", "build_alpha")
        await _run_build(repository, "task_a", "build_beta")

        response = await client.get("/api/v1/builds")
        payload = response.json()

    assert response.status_code == 200
    items = payload["items"]
    assert {item["build_id"] for item in items} == {"build_alpha", "build_beta"}
    for item in items:
        assert item["task_id"] == "task_a"
        assert item["dataset_family"] == "gene_expression"
        assert item["row_count"] == 4
        assert item["status"] == "succeeded"
        assert item["manifest_ref"] == (
            f"datasets_build/{item['build_id']}/dataset_manifest.json"
        )
        assert len(item["manifest_sha256"]) == 64
        assert item["publication_id"]
        assert item["published_at"] is not None
        result = item["build_result"]
        assert result is not None
        assert result["status"] == "succeeded"
        assert result["valid_row_count"] == 4
        assert result["successful_sources"] == ["binding_geo"]
        assert result["publication_id"] == item["publication_id"]
    assert payload["next_cursor"] is None


@pytest.mark.asyncio
async def test_builds_api_paginates_with_cursor(tmp_path: Path) -> None:
    async with api_client(tmp_path) as (application, client):
        repository = application.state.task_repository
        await _run_build(repository, "task_a", "build_alpha")
        await _run_build(repository, "task_a", "build_beta")

        first = await client.get("/api/v1/builds?limit=1")
        payload = first.json()
        assert first.status_code == 200
        assert len(payload["items"]) == 1
        assert payload["next_cursor"] is not None
        second = await client.get(
            f"/api/v1/builds?limit=1&cursor={payload['next_cursor']}"
        )
        payload_two = second.json()

    assert second.status_code == 200
    assert len(payload_two["items"]) == 1
    assert {
        payload["items"][0]["build_id"],
        payload_two["items"][0]["build_id"],
    } == {"build_alpha", "build_beta"}
    assert payload_two["next_cursor"] is None


@pytest.mark.asyncio
async def test_builds_api_lists_skips_corrupt_manifest(
    tmp_path: Path,
) -> None:
    """A corrupt manifest must not take down the whole listing (R1C-01)."""
    async with api_client(tmp_path) as (application, client):
        repository = application.state.task_repository
        await _run_build(repository, "task_a", "build_alpha")
        await _run_build(repository, "task_a", "build_beta")
        manifest_path = (
            repository.tasks_dir
            / "task_a"
            / "datasets_build"
            / "build_alpha"
            / "dataset_manifest.json"
        )
        manifest_path.write_text('{"truncated": ', encoding="utf-8")

        response = await client.get("/api/v1/builds")
        payload = response.json()

    assert response.status_code == 200
    items = payload["items"]
    assert [item["build_id"] for item in items] == ["build_beta"]
    assert payload["next_cursor"] is None


@pytest.mark.asyncio
async def test_builds_api_single_build_detail(tmp_path: Path) -> None:
    async with api_client(tmp_path) as (application, client):
        repository = application.state.task_repository
        await _run_build(repository, "task_a", "build_alpha")

        response = await client.get("/api/v1/builds/build_alpha")
        payload = response.json()

    assert response.status_code == 200
    assert payload["build_id"] == "build_alpha"
    assert payload["task_id"] == "task_a"
    assert payload["build_result"]["status"] == "succeeded"
    assert payload["build_result"]["publication_id"] == payload["publication"]["publication_id"]
    manifest = payload["manifest"]
    assert manifest["dataset_family"] == "gene_expression"
    assert manifest["row_count"] == 4
    assert manifest["validation_summary"]["status"] == "passed"
    assert payload["publication"]["manifest_ref"] == manifest["manifest_id"]
    assert any(
        entry["role"] == "primary_dataset" for entry in payload["artifacts"]
    )
    assert any(entry["role"] == "audit_report" for entry in payload["artifacts"])
    assert payload["manifest_ref"] == "datasets_build/build_alpha/dataset_manifest.json"


@pytest.mark.asyncio
async def test_builds_api_downloads_manifest_and_registered_artifacts(
    tmp_path: Path,
) -> None:
    async with api_client(tmp_path) as (application, client):
        repository = application.state.task_repository
        await _run_build(repository, "task_a", "build_alpha")

        manifest_download = await client.get(
            "/api/v1/builds/build_alpha/artifacts/dataset_manifest"
        )
        detail = await client.get("/api/v1/builds/build_alpha")
        primary_entry = next(
            entry
            for entry in detail.json()["artifacts"]
            if entry["role"] == "primary_dataset"
        )
        primary_download = await client.get(
            f"/api/v1/builds/build_alpha/artifacts/{primary_entry['artifact_id']}"
        )

    assert manifest_download.status_code == 200
    manifest = json.loads(manifest_download.content)
    assert manifest["build_id"] == "build_alpha"
    assert primary_download.status_code == 200
    assert primary_download.headers["content-type"].startswith("text/csv")
    assert primary_download.content.startswith(b"record_id")


@pytest.mark.asyncio
async def test_builds_api_unknown_build_and_artifact_404(tmp_path: Path) -> None:
    async with api_client(tmp_path) as (application, client):
        await _run_build(application.state.task_repository, "task_a", "build_alpha")
        missing_build = await client.get("/api/v1/builds/build_nope")
        missing_artifact = await client.get(
            "/api/v1/builds/build_alpha/artifacts/artifact_nope"
        )

    assert missing_build.status_code == 404
    assert missing_artifact.status_code == 404


@pytest.mark.asyncio
async def test_builds_api_task_filter_disambiguates_colliding_build_ids(
    tmp_path: Path,
) -> None:
    """F7-02 regression: build ids are agent-supplied and may collide across
    tasks. ``GET /builds/{build_id}?task_id=`` must scope the lookup to one
    task so the viewer (which knows its task) always gets the right build;
    without the filter the newest build still wins."""
    async with api_client(tmp_path) as (application, client):
        repository = application.state.task_repository
        # Same build_id in two tasks, different content (row counts differ:
        # 1 probe row -> 2 records, 2 probe rows -> 4 records).
        await _run_build(
            repository,
            "task_a",
            "build_shared",
            rows=[("AFFX-PA", "1.0", "2.0")],
        )
        await _run_build(
            repository,
            "task_b",
            "build_shared",
            rows=[("AFFX-PB", "1.0", "2.0"), ("AFFX-PC", "3.0", "4.0")],
        )

        unfiltered = await client.get("/api/v1/builds/build_shared")
        task_a = await client.get("/api/v1/builds/build_shared?task_id=task_a")
        task_b = await client.get("/api/v1/builds/build_shared?task_id=task_b")
        unknown = await client.get("/api/v1/builds/build_shared?task_id=task_nope")
        detail_a = task_a.json()
        primary_a = next(
            entry
            for entry in detail_a["artifacts"]
            if entry["role"] == "primary_dataset"
        )
        download_a = await client.get(
            f"/api/v1/builds/build_shared/artifacts/{primary_a['artifact_id']}"
            "?task_id=task_a"
        )
        download_unfiltered = await client.get(
            f"/api/v1/builds/build_shared/artifacts/{primary_a['artifact_id']}"
        )

    # Newest build wins without the filter (task_b built last).
    assert unfiltered.status_code == 200
    assert unfiltered.json()["task_id"] == "task_b"
    assert unfiltered.json()["manifest"]["row_count"] == 4
    # The task filter resolves the collision to the right task.
    assert task_a.status_code == 200
    assert task_a.json()["task_id"] == "task_a"
    assert task_a.json()["manifest"]["row_count"] == 2
    assert task_b.status_code == 200
    assert task_b.json()["task_id"] == "task_b"
    assert task_b.json()["manifest"]["row_count"] == 4
    assert unknown.status_code == 404
    # The artifact endpoint honors the same filter: the task_a artifact
    # resolves to task_a's primary (2 records), never task_b's (4 records).
    assert download_a.status_code == 200
    assert download_a.headers["content-type"].startswith("text/csv")
    assert len(download_a.content) == primary_a["size_bytes"]
    assert len(download_unfiltered.content) != primary_a["size_bytes"]


@pytest.mark.asyncio
async def test_builds_api_prefers_durable_build_result_from_events(
    tmp_path: Path,
) -> None:
    """T1 seam 2: when the durable RunCompletedPayload carries the V2
    BuildResult (wired by Seam 1), the builds API returns that authoritative
    result (e.g. partial_success) instead of the lossy manifest projection."""
    async with api_client(tmp_path) as (application, client):
        repository = application.state.task_repository
        await _run_build(repository, "task_a", "build_alpha")
        detail = await client.get("/api/v1/builds/build_alpha")
        publication_id = detail.json()["publication"]["publication_id"]

        await repository.save_snapshot(
            TaskSnapshot(
                task=TaskSummary(
                    task_id="task_a",
                    mode=TaskMode.FIXTURE,
                    databases=["geo"],
                    title="task_a",
                    status=RunStatus.RUNNING,
                    created_at=NOW,
                    updated_at=NOW,
                ),
                runs=[
                    RunRecord(
                        run_id="run_partial",
                        task_id="task_a",
                        request_id="request_run_partial",
                        status=RunStatus.RUNNING,
                        input="task_a",
                        created_at=NOW,
                        updated_at=NOW,
                        started_at=NOW,
                    )
                ],
            )
        )
        await repository.append_event_payload(
            task_id="task_a",
            run_id="run_partial",
            payload=PublicationCreatedPayload(
                publication_id=publication_id,
                run_id="run_partial",
                manifest_sha256="0" * 64,
                published_at=NOW,
            ),
        )
        await repository.append_event_payload(
            task_id="task_a",
            run_id="run_partial",
            payload=RunFinalizingPayload(),
        )
        await repository.append_event_payload(
            task_id="task_a",
            run_id="run_partial",
            payload=RunCompletedPayload(
                build_result=_partial_build_result(publication_id)
            ),
        )

        response = await client.get("/api/v1/builds/build_alpha")
        payload = response.json()

    assert response.status_code == 200
    assert payload["build_result"]["status"] == "partial_success"
    assert payload["build_result"]["rejected_sources"] == ["binding_geo"]


def _partial_build_result(publication_id: str):
    return BuildResult(
        status=BuildResultStatus.PARTIAL_SUCCESS,
        valid_row_count=4,
        successful_sources=["binding_gdc"],
        rejected_sources=["binding_geo"],
        publication_id=publication_id,
        reason_codes=[],
        user_summary="partial",
    )
