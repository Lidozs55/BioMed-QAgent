from __future__ import annotations

import hashlib
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest
from app.config import Settings
from app.domain.contracts import (
    RunRecord,
    RunStatus,
    TaskMode,
    TaskSnapshot,
    TaskSummary,
)
from app.main import create_app
from app.pipeline.runner import PipelineRunner
from fastapi import FastAPI

FIXTURE_DIR = Path(__file__).parents[1] / "fixtures" / "ncbi" / "gse178352"
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


def authoritative_snapshot(task_id: str) -> TaskSnapshot:
    return TaskSnapshot(
        task=TaskSummary(
            task_id=task_id,
            mode=TaskMode.FIXTURE,
            databases=["pubmed", "geo"],
            title=task_id,
            status=RunStatus.COMPLETED,
            created_at=NOW,
            updated_at=NOW,
        )
    )


def snapshot_with_run(task_id: str, run_id: str, status: RunStatus) -> TaskSnapshot:
    return TaskSnapshot(
        task=TaskSummary(
            task_id=task_id,
            mode=TaskMode.FIXTURE,
            databases=["pubmed", "geo"],
            title=task_id,
            status=status,
            created_at=NOW,
            updated_at=NOW,
        ),
        runs=[
            RunRecord(
                run_id=run_id,
                task_id=task_id,
                request_id=f"request_{run_id}",
                status=status,
                input=task_id,
                created_at=NOW,
                updated_at=NOW,
                started_at=NOW,
                finished_at=NOW,
            )
        ],
    )


async def seed_fixture(application: FastAPI, task_id: str) -> object:
    repository = application.state.task_repository
    run_id = f"run_{task_id}"
    await repository.save_snapshot(
        snapshot_with_run(task_id, run_id, RunStatus.COMPLETED)
    )
    manifest = await PipelineRunner(
        task_id=task_id,
        base_dir=repository.tasks_dir,
        fixture_dir=FIXTURE_DIR,
    ).run()
    artifacts_dir = repository.tasks_dir / task_id / "artifacts"
    manifest_path = artifacts_dir / "run_manifest.json"
    (artifacts_dir / ".runtime-publication.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "task_id": task_id,
                "run_id": run_id,
                "manifest_sha256": hashlib.sha256(
                    manifest_path.read_bytes()
                ).hexdigest(),
            }
        ),
        "utf-8",
    )
    return manifest


@pytest.mark.asyncio
async def test_artifact_api_uses_repository_root_and_preserves_success_wire(
    tmp_path: Path,
) -> None:
    async with api_client(tmp_path) as (application, client):
        repository = application.state.task_repository
        manifest = await seed_fixture(application, "task_api")

        response = await client.get("/api/v1/tasks/task_api/artifacts")
        artifacts = response.json()["artifacts"]
        main_entry = next(
            entry for entry in artifacts if entry["name"] == "main_data.csv"
        )
        download = await client.get(
            f"/api/v1/tasks/task_api/artifacts/{main_entry['artifact_id']}"
        )
        filename_lookup = await client.get(
            "/api/v1/tasks/task_api/artifacts/main_data.csv"
        )

    assert repository.tasks_dir == tmp_path / "isolated-output" / "tasks"
    assert response.status_code == 200
    assert [entry["artifact_id"] for entry in artifacts] == [
        "run_manifest",
        *[entry.artifact_id for entry in manifest.artifacts],
    ]
    assert all(
        set(entry)
        == {"artifact_id", "name", "role", "size", "sha256", "media_type"}
        for entry in artifacts
    )
    run_manifest_entry = next(
        entry for entry in artifacts if entry["name"] == "run_manifest.json"
    )
    assert run_manifest_entry["role"] == "schema"
    assert main_entry["role"] == "primary_dataset"
    assert main_entry["artifact_id"].startswith("artifact_")
    assert download.status_code == 200
    assert download.headers["content-disposition"].endswith('filename="main_data.csv"')
    assert download.content.startswith(b"\xef\xbb\xbfrecord_id,dataset_id,source_id")
    assert filename_lookup.status_code == 404
    assert filename_lookup.json() == {"detail": "Artifact not found"}


@pytest.mark.asyncio
async def test_artifact_api_requires_authoritative_task_and_handles_no_manifest(
    tmp_path: Path,
) -> None:
    async with api_client(tmp_path) as (application, client):
        repository = application.state.task_repository
        await PipelineRunner(
            task_id="task_orphan",
            base_dir=repository.tasks_dir,
            fixture_dir=FIXTURE_DIR,
        ).run()
        orphan_list = await client.get("/api/v1/tasks/task_orphan/artifacts")
        orphan_download = await client.get(
            "/api/v1/tasks/task_orphan/artifacts/run_manifest"
        )

        await repository.save_snapshot(authoritative_snapshot("task_empty"))
        empty_list = await client.get("/api/v1/tasks/task_empty/artifacts")
        empty_download = await client.get(
            "/api/v1/tasks/task_empty/artifacts/run_manifest"
        )

    assert orphan_list.status_code == orphan_download.status_code == 404
    assert orphan_list.json() == orphan_download.json() == {"detail": "Task not found"}
    assert empty_list.status_code == 200
    assert empty_list.json() == {"artifacts": [], "degraded": False}
    assert empty_download.status_code == 404
    assert empty_download.json() == {"detail": "Artifact not found"}


@pytest.mark.asyncio
async def test_artifact_api_never_exposes_cancelled_run_publication(
    tmp_path: Path,
) -> None:
    task_id = "task_cancelled_artifacts"
    run_id = "run_cancelled_artifacts"
    async with api_client(tmp_path) as (application, client):
        repository = application.state.task_repository
        await repository.save_snapshot(
            snapshot_with_run(task_id, run_id, RunStatus.CANCELLED)
        )
        await PipelineRunner(
            task_id=task_id,
            base_dir=repository.tasks_dir,
            fixture_dir=FIXTURE_DIR,
        ).run()
        artifacts_dir = repository.tasks_dir / task_id / "artifacts"
        manifest_path = artifacts_dir / "run_manifest.json"
        (artifacts_dir / ".runtime-publication.json").write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "task_id": task_id,
                    "run_id": run_id,
                    "manifest_sha256": hashlib.sha256(
                        manifest_path.read_bytes()
                    ).hexdigest(),
                }
            ),
            "utf-8",
        )

        artifact_list = await client.get(f"/api/v1/tasks/{task_id}/artifacts")
        artifact_download = await client.get(
            f"/api/v1/tasks/{task_id}/artifacts/run_manifest"
        )

    assert artifact_list.status_code == 200
    assert artifact_list.json() == {"artifacts": [], "degraded": False}
    assert artifact_download.status_code == 404
    assert artifact_download.json() == {"detail": "Artifact not found"}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("corruption", "expected_detail"),
    [
        ("invalid_json", "Artifact manifest is invalid"),
        ("invalid_schema", "Artifact manifest is invalid"),
        ("unvalidated", "Artifacts are not validated"),
        ("traversal", "Artifact manifest is invalid"),
        ("missing_file", "Registered artifact is missing"),
        ("size_mismatch", "Artifact integrity check failed"),
        ("hash_mismatch", "Artifact integrity check failed"),
    ],
)
async def test_artifact_api_preserves_manifest_and_integrity_conflicts(
    tmp_path: Path,
    corruption: str,
    expected_detail: str,
) -> None:
    async with api_client(tmp_path) as (application, client):
        repository = application.state.task_repository
        await seed_fixture(application, "task_corrupt")
        artifacts_dir = repository.tasks_dir / "task_corrupt" / "artifacts"
        manifest_path = artifacts_dir / "run_manifest.json"
        payload = json.loads(manifest_path.read_text("utf-8"))
        entry = payload["artifacts"][0]
        artifact_path = artifacts_dir / entry["relative_path"].removeprefix(
            "artifacts/"
        )

        if corruption == "invalid_json":
            manifest_path.write_text("{", "utf-8")
        elif corruption == "invalid_schema":
            payload["unexpected"] = True
            manifest_path.write_text(json.dumps(payload), "utf-8")
        elif corruption == "unvalidated":
            payload["validation"]["status"] = "invalid"
            payload["validation"]["failed_count"] = 1
            manifest_path.write_text(json.dumps(payload), "utf-8")
        elif corruption == "traversal":
            entry["relative_path"] = "artifacts/../../escape.csv"
            manifest_path.write_text(json.dumps(payload), "utf-8")
        elif corruption == "missing_file":
            artifact_path.unlink()
        elif corruption == "size_mismatch":
            artifact_path.write_bytes(artifact_path.read_bytes() + b"x")
        elif corruption == "hash_mismatch":
            content = bytearray(artifact_path.read_bytes())
            content[0] ^= 1
            artifact_path.write_bytes(content)

        response = await client.get("/api/v1/tasks/task_corrupt/artifacts")

    assert response.status_code == 409
    assert response.json() == {"detail": expected_detail}


@pytest.mark.asyncio
async def test_artifact_api_hides_unknown_ids_and_unsafe_tasks(tmp_path: Path) -> None:
    async with api_client(tmp_path) as (application, client):
        await seed_fixture(application, "task_known")
        unknown = await client.get(
            "/api/v1/tasks/task_known/artifacts/artifact_unknown"
        )
        unsafe_list = await client.get("/api/v1/tasks/bad.task/artifacts")
        unsafe_download = await client.get(
            "/api/v1/tasks/bad.task/artifacts/run_manifest"
        )

    assert unknown.status_code == 404
    assert unknown.json() == {"detail": "Artifact not found"}
    assert unsafe_list.status_code == unsafe_download.status_code == 404
    assert unsafe_list.json() == unsafe_download.json() == {"detail": "Task not found"}


@pytest.mark.asyncio
async def test_unexpected_manifest_storage_error_remains_500(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async with api_client(tmp_path) as (application, _):
        repository = application.state.task_repository
        await seed_fixture(application, "task_storage_error")
        manifest_path = (
            repository.tasks_dir
            / "task_storage_error"
            / "artifacts"
            / "run_manifest.json"
        )
        real_read_text = Path.read_text

        def fail_manifest_read(path: Path, *args, **kwargs) -> str:
            if path == manifest_path:
                raise OSError("simulated storage failure")
            return real_read_text(path, *args, **kwargs)

        monkeypatch.setattr(Path, "read_text", fail_manifest_read)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(
                app=application,
                raise_app_exceptions=False,
            ),
            base_url="http://localhost",
        ) as client:
            response = await client.get("/api/v1/tasks/task_storage_error/artifacts")

    assert response.status_code == 500


@pytest.mark.asyncio
async def test_artifact_routes_hash_chunked_without_full_file_reads(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """B7: artifact hashing must never load a whole file via Path.read_bytes.

    Monkeypatching ``Path.read_bytes`` to raise proves the routes (and the
    shared digest helper) stream files in bounded chunks instead of loading
    them into memory; list and download still work and yield the correct
    sha256.
    """
    from app.api.routes import _file_sha256

    # Multi-chunk artifact: build a > 2 MiB file so chunked reading must loop.
    big = tmp_path / "big.bin"
    big.write_bytes(b"a" * (2 * 1024 * 1024 + 12345))
    with big.open("rb") as handle:
        expected = hashlib.sha256(handle.read()).hexdigest()

    def boom(*args, **kwargs):
        raise AssertionError("Path.read_bytes must not be used for artifacts")

    assert _file_sha256(big) == expected

    # The routes must also work without read_bytes for artifact files. Other
    # small-file app bookkeeping (session/state JSONL) legitimately uses
    # read_bytes, so the guard only fires for the artifact tree and big.bin.
    real_read_bytes = Path.read_bytes

    def guarded_read_bytes(path: Path, *args, **kwargs) -> bytes:
        parts = Path(path).parts
        if path.name == "big.bin" or "artifacts" in parts:
            raise AssertionError("Path.read_bytes must not be used for artifacts")
        return real_read_bytes(path, *args, **kwargs)

    async with api_client(tmp_path) as (application, client):
        repository = application.state.task_repository
        await seed_fixture(application, "task_chunked")
        monkeypatch.setattr(Path, "read_bytes", guarded_read_bytes)
        listed = await client.get("/api/v1/tasks/task_chunked/artifacts")
        artifacts = listed.json()["artifacts"]
        main_entry = next(
            entry for entry in artifacts if entry["name"] == "main_data.csv"
        )
        downloaded = await client.get(
            f"/api/v1/tasks/task_chunked/artifacts/{main_entry['artifact_id']}"
        )
        # Undo the monkeypatch before app teardown so background bookkeeping
        # (which legitimately reads small JSON state) is not affected.
        monkeypatch.undo()

    assert listed.status_code == 200
    assert downloaded.status_code == 200
    assert downloaded.content.startswith(b"\xef\xbb\xbfrecord_id")
    # The listed digest is the manifest-recorded (trusted) digest.
    assert main_entry["sha256"] == hashlib.sha256(
        (
            repository.tasks_dir
            / "task_chunked"
            / "artifacts"
            / "main_data.csv"
        ).read_bytes()
    ).hexdigest()
