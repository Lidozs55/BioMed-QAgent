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
    """Seed one completed task with a V2 build (cache entry + legacy mirror).

    V1 退役后：构造真实生产形态的 V2 build 目录（datasets_build/<build_id>/），
    ``DatasetCacheV2.commit`` 写入 cache（artifact API 的 cache-first 面），并
    ``mirror_build_to_legacy_artifacts`` 双写 legacy ``artifacts/`` 面。返回
    DatasetManifest（与调用方的 ``manifest.artifacts`` 用法兼容）。
    """
    repository = application.state.task_repository
    run_id = f"run_{task_id}"
    await repository.save_snapshot(
        snapshot_with_run(task_id, run_id, RunStatus.COMPLETED)
    )
    _dataset_id, entry_dir = _seed_v2_cache_entry(repository, task_id)
    from app.datasets.build.v1_bridge import mirror_build_to_legacy_artifacts
    from app.datasets.contracts import DatasetManifest

    mirror_build_to_legacy_artifacts(
        task_id=task_id,
        task_root=repository.tasks_dir / task_id,
        build_dir=entry_dir,
        objective="fixture seed",
    )
    return (
        DatasetManifest.model_validate_json(
            (entry_dir / "dataset_manifest.json").read_text("utf-8")
        ),
        entry_dir,
    )


@pytest.mark.asyncio
async def test_artifact_api_uses_repository_root_and_preserves_success_wire(
    tmp_path: Path,
) -> None:
    async with api_client(tmp_path) as (application, client):
        repository = application.state.task_repository
        manifest, _entry_dir = await seed_fixture(application, "task_api")

        response = await client.get("/api/v1/tasks/task_api/artifacts")
        artifacts = response.json()["artifacts"]
        main_entry = next(
            entry for entry in artifacts if entry["name"] == "primary.csv"
        )
        download = await client.get(
            f"/api/v1/tasks/task_api/artifacts/{main_entry['artifact_id']}"
        )
        filename_lookup = await client.get(
            "/api/v1/tasks/task_api/artifacts/primary.csv"
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
        entry for entry in artifacts if entry["name"] == "dataset_manifest.json"
    )
    assert run_manifest_entry["role"] == "schema"
    assert main_entry["role"] == "primary_dataset"
    assert main_entry["artifact_id"].startswith("artifact_")
    assert download.status_code == 200
    assert download.headers["content-disposition"].endswith('filename="primary.csv"')
    assert download.content.startswith(b"record_id,gene_id")
    assert filename_lookup.status_code == 404
    assert filename_lookup.json() == {"detail": "Artifact not found"}


@pytest.mark.asyncio
async def test_artifact_api_requires_authoritative_task_and_handles_no_manifest(
    tmp_path: Path,
) -> None:
    async with api_client(tmp_path) as (application, client):
        repository = application.state.task_repository
        # 有 legacy 文件但无 snapshot → 404（V2 语义：无 authoritative 任务）。
        _seed_v2_cache_entry(repository, "task_orphan")
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
        # cancelled run 的 build 产物不得被 artifact API 暴露。
        _seed_v2_cache_entry(repository, task_id)

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
    ("corruption", "expected_status", "expected_detail"),
    [
        # V2 cache-first 语义：cache manifest 损坏 → 跳过该 entry 回退 legacy
        # 镜像面（mirror 完整可服务），不报 409。
        ("invalid_json", 200, ""),
        ("invalid_schema", 200, ""),
        # cache 分支内校验失败 → 409。
        ("traversal", 409, "Invalid cache artifact path"),
        ("missing_file", 409, "Registered artifact is missing"),
        # C2c：cache 文件损坏 → 跳过该 cache entry 回退 legacy 镜像面（200）
        ("size_mismatch", 200, ""),
        ("hash_mismatch", 200, ""),
    ],
)
async def test_artifact_api_preserves_manifest_and_integrity_conflicts(
    tmp_path: Path,
    corruption: str,
    expected_status: int,
    expected_detail: str,
) -> None:
    async with api_client(tmp_path) as (application, client):
        repository = application.state.task_repository
        await seed_fixture(application, "task_corrupt")
        # corrupt 的是 cache 副本（cache-first 权威读取面），非 legacy 镜像。
        from app.datasets.build.cache import DatasetCacheV2

        cache = DatasetCacheV2(repository.tasks_dir.parent.parent / "cache")
        cache_entry = next(
            entry
            for entry in cache.list(namespace="build", limit=10_000)
            if entry.build_id == _DUAL_READ_BUILD_ID
        )
        entry_dir = cache_entry.directory
        manifest_path = entry_dir / "dataset_manifest.json"
        payload = json.loads(manifest_path.read_text("utf-8"))
        entry = payload["artifacts"][0]
        artifact_path = entry_dir / entry["relative_path"]

        if corruption == "invalid_json":
            manifest_path.write_text("{", "utf-8")
        elif corruption == "invalid_schema":
            payload["unexpected"] = True
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

    assert response.status_code == expected_status
    if expected_status == 409:
        assert response.json() == {"detail": expected_detail}
    else:
        # 回退 legacy 镜像面：run_manifest 首条目 + primary 可下载。
        artifacts = response.json()["artifacts"]
        assert artifacts[0]["artifact_id"] == "run_manifest"
        assert any(entry["name"] == "primary.csv" for entry in artifacts)


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
async def test_unexpected_manifest_storage_error_downgrades_to_legacy(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async with api_client(tmp_path) as (application, _):
        repository = application.state.task_repository
        await seed_fixture(application, "task_storage_error")
        from app.datasets.build.cache import DatasetCacheV2

        cache = DatasetCacheV2(repository.tasks_dir.parent.parent / "cache")
        cache_entry = next(
            entry
            for entry in cache.list(namespace="build", limit=10_000)
            if entry.build_id == _DUAL_READ_BUILD_ID
        )
        manifest_path = cache_entry.directory / "dataset_manifest.json"
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

    # V2 语义：cache 存储错误降级回退 legacy 镜像面（不 500）。
    assert response.status_code == 200


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
            entry for entry in artifacts if entry["name"] == "primary.csv"
        )
        downloaded = await client.get(
            f"/api/v1/tasks/task_chunked/artifacts/{main_entry['artifact_id']}"
        )
        # Undo the monkeypatch before app teardown so background bookkeeping
        # (which legitimately reads small JSON state) is not affected.
        monkeypatch.undo()

    assert listed.status_code == 200
    assert downloaded.status_code == 200
    assert downloaded.content.startswith(b"record_id,gene_id")
    # The listed digest is the manifest-recorded (trusted) digest; the file
    # is served from the V2 cache entry (cache-first), not the legacy dir.
    from app.datasets.build.cache import DatasetCacheV2

    cache = DatasetCacheV2(repository.tasks_dir.parent.parent / "cache")
    cache_entry = next(
        entry
        for entry in cache.list(namespace="build", limit=10_000)
        if entry.build_id == _DUAL_READ_BUILD_ID
    )
    assert main_entry["sha256"] == hashlib.sha256(
        (cache_entry.directory / "merged" / "primary.csv").read_bytes()
    ).hexdigest()


# ---------------------------------------------------------------------------
# Phase 7 T2 dual-read: artifact endpoints read the V2 dataset cache first
# ---------------------------------------------------------------------------

#: F7-01: the V2 expression runner stamps the manifest's ``task_id`` with the
#: agent-supplied build_id (the spec carries no task id), so production
#: manifests are tied to a task by the build dir shape
#: ``tasks_dir/<task_id>/datasets_build/<build_id>/`` — never by task_id.
_DUAL_READ_BUILD_ID = "build_dual_read"


def _seed_v2_cache_entry(
    repository: object,
    task_id: str,
    *,
    primary_rows: bytes = b"record_id,gene_id\nrow_1,TP53\n",
) -> tuple[str, Path]:
    """Commit one V2 cache entry in the real production shape.

    The build output dir is ``tasks_dir/<task_id>/datasets_build/<build_id>/``
    (the same path ``execute_dataset_build`` writes) and the manifest's
    ``task_id`` field holds the build_id, mirroring ExpressionBuildRunner.
    ``cache.commit`` copies that build dir into the content-addressed cache
    root (``<output_dir>/../cache``). Returns ``(dataset_id, entry_dir)``.
    """
    import hashlib as _hashlib

    from app.datasets.build.cache import DatasetCacheV2
    from app.datasets.contracts import (
        AcquisitionMode,
        ArtifactRole,
        DatasetBuildSpec,
        SourceBinding,
        SourceBindingAcquisition,
    )
    from app.domain.contracts import DataLevel, SourceAsset, asset_id_from_sha256

    cache_root = repository.tasks_dir.parent.parent / "cache"
    output_dir = (
        repository.tasks_dir / task_id / "datasets_build" / _DUAL_READ_BUILD_ID
    )
    output_dir.mkdir(parents=True, exist_ok=True)
    primary = output_dir / "merged" / "primary.csv"
    primary.parent.mkdir(parents=True, exist_ok=True)
    primary.write_bytes(primary_rows)
    schema = output_dir / "schema.json"
    schema_bytes = b'{"schema_id": "gene_expression.long.v1"}'
    schema.write_bytes(schema_bytes)
    manifest_path = output_dir / "dataset_manifest.json"
    manifest_payload = {
        "manifest_id": "manifest_dual_read",
        "task_id": _DUAL_READ_BUILD_ID,
        "build_id": _DUAL_READ_BUILD_ID,
        "dataset_family": "gene_expression",
        "row_granularity": "gene_sample_measurement",
        "schema_ref": "gene_expression.long.v1",
        "primary_key": ["record_id"],
        "row_count": 1,
        "sha256": "a" * 64,
                "artifacts": [
                    {
                        "artifact_id": "artifact_primary",
                        "role": ArtifactRole.PRIMARY_DATASET.value,
                        "relative_path": "merged/primary.csv",
                        "media_type": "text/csv",
                        "size_bytes": len(primary_rows),
                        "sha256": _hashlib.sha256(primary_rows).hexdigest(),
                    },
                    {
                        "artifact_id": "artifact_schema",
                        "role": ArtifactRole.SCHEMA.value,
                        "relative_path": "schema.json",
                        "media_type": "application/json",
                        "size_bytes": len(schema_bytes),
                        "sha256": _hashlib.sha256(schema_bytes).hexdigest(),
                    },
                ],
                "source_summary": {"src_gdc": 1},
                "validation_summary": {"status": "passed"},
        "confidence_summary": {},
        "provenance_summary": {"source_count": 1},
    }
    # 自洽 sha256：manifest 内容含自身 digest（先占位写出→读回→更新→重写）。
    manifest_path.write_text(
        json.dumps(manifest_payload, ensure_ascii=False), "utf-8"
    )
    manifest_payload["sha256"] = _hashlib.sha256(
        manifest_path.read_bytes()
    ).hexdigest()
    manifest_path.write_text(
        json.dumps(manifest_payload, ensure_ascii=False) + "\n", "utf-8"
    )
    source_path = (
        Path(__file__).parents[1] / "fixtures" / "gdc" / "gdc_expression.tsv"
    )
    checksum = _hashlib.sha256(source_path.read_bytes()).hexdigest()
    spec = DatasetBuildSpec(
        build_id=_DUAL_READ_BUILD_ID,
        objective="compare TP53 expression",
        dataset_family="gene_expression",
        row_granularity="gene_sample_measurement",
        schema_ref="gene_expression.long.v1",
        source_bindings=[
            SourceBinding(
                binding_id="binding_gdc",
                source="gdc",
                acquisition=SourceBindingAcquisition(
                    mode=AcquisitionMode.BUILTIN, provider_id="gdc.v1"
                ),
                adapter_id="gdc.expression.v1",
            )
        ],
        merge_strategy="append_by_canonical_row",
        validation_profile_ref="gene_expression.release.v1",
        normalization_profile_ref="gene_expression.normalization.v1",
    )
    assets = {
        "binding_gdc": SourceAsset(
            asset_id=asset_id_from_sha256(checksum),
            kind="source",
            relative_path="source_assets/gdc_expression.tsv",
            sha256=checksum,
            size_bytes=source_path.stat().st_size,
            media_type="text/tab-separated-values",
            source_id="src_gdc",
            successful_attempt_id="attempt_1",
            data_level=DataLevel.REPOSITORY_PROCESSED,
        )
    }
    entry = DatasetCacheV2(cache_root).commit(
        namespace="build",
        output_dir=output_dir,
        spec=spec,
        source_assets=assets,
        keywords=["TP53"],
    )
    return entry.dataset_id, entry.directory


def _mirror_v1_bridge(repository: object, task_id: str) -> None:
    """Dual-write reality: mirror the task's V2 build onto the legacy V1
    artifacts surface with V1-style (relative-path-hashed) artifact ids, so
    the legacy fallback would serve if the cache match failed."""
    from app.datasets.build.v1_bridge import mirror_build_to_legacy_artifacts

    build_dir = repository.tasks_dir / task_id / "datasets_build" / _DUAL_READ_BUILD_ID
    mirror_build_to_legacy_artifacts(
        task_id=task_id,
        task_root=repository.tasks_dir / task_id,
        build_dir=build_dir,
        objective="compare TP53 expression",
    )


def _v1_bridge_artifact_id(relative_path: str) -> str:
    """The V1 bridge derives path-unique ids by hashing the relative path."""
    import hashlib as _hashlib

    return "artifact_" + _hashlib.sha256(
        relative_path.encode("utf-8")
    ).hexdigest()[:32]


@pytest.mark.asyncio
async def test_artifact_api_reads_v2_cache_first(tmp_path: Path) -> None:
    """A V2 build committed to the dataset cache is served by the legacy
    artifact API (dual-read): list + download resolve through the cache."""
    task_id = "task_cache_dual"
    run_id = "run_cache_dual"
    async with api_client(tmp_path) as (application, client):
        repository = application.state.task_repository
        await repository.save_snapshot(
            snapshot_with_run(task_id, run_id, RunStatus.COMPLETED)
        )
        dataset_id, _entry_dir = _seed_v2_cache_entry(repository, task_id)

        listed = await client.get(f"/api/v1/tasks/{task_id}/artifacts")
        primary = await client.get(
            f"/api/v1/tasks/{task_id}/artifacts/artifact_primary"
        )
        run_manifest = await client.get(
            f"/api/v1/tasks/{task_id}/artifacts/run_manifest"
        )

    assert listed.status_code == 200
    payload = listed.json()
    assert payload["degraded"] is False
    artifacts = payload["artifacts"]
    assert artifacts[0]["artifact_id"] == "run_manifest"
    assert artifacts[0]["name"] == "dataset_manifest.json"
    primary_entry = next(
        entry
        for entry in artifacts
        if entry["artifact_id"] == "artifact_primary"
    )
    assert primary_entry["role"] == "primary_dataset"
    assert primary_entry["name"] == "primary.csv"
    assert primary.status_code == 200
    assert primary.content.startswith(b"record_id,gene_id")
    assert run_manifest.status_code == 200
    assert json.loads(run_manifest.content)["task_id"] == _DUAL_READ_BUILD_ID
    assert dataset_id.startswith("dataset_")


@pytest.mark.asyncio
async def test_artifact_api_cache_wins_over_legacy_dirs(tmp_path: Path) -> None:
    """When both the V2 cache entry and a legacy artifacts/ surface exist
    for a task, the cache is authoritative (new builds dual-write both)."""
    task_id = "task_cache_priority"
    run_id = "run_cache_priority"
    async with api_client(tmp_path) as (application, client):
        repository = application.state.task_repository
        await repository.save_snapshot(
            snapshot_with_run(task_id, run_id, RunStatus.COMPLETED)
        )
        _seed_v2_cache_entry(
            repository,
            task_id,
            primary_rows=b"record_id,gene_id\nrow_cache,TP53\n",
        )
        # A stale legacy surface with different content must NOT win.
        artifacts_dir = repository.tasks_dir / task_id / "artifacts"
        artifacts_dir.mkdir(parents=True, exist_ok=True)
        (artifacts_dir / "main_data.csv").write_text(
            "record_id,gene_id\nrow_legacy,TP53\n", "utf-8"
        )

        listed = await client.get(f"/api/v1/tasks/{task_id}/artifacts")
        primary_entry = next(
            entry
            for entry in listed.json()["artifacts"]
            if entry["role"] == "primary_dataset"
        )
        downloaded = await client.get(
            f"/api/v1/tasks/{task_id}/artifacts/{primary_entry['artifact_id']}"
        )

    assert listed.status_code == 200
    assert primary_entry["name"] == "primary.csv"
    assert downloaded.content.startswith(b"record_id,gene_id\nrow_cache")


@pytest.mark.asyncio
async def test_artifact_api_cache_path_requires_completed_run(
    tmp_path: Path,
) -> None:
    """Mirrors legacy semantics: cached artifacts surface only once the run
    is COMPLETED (mid-run the cache entry is not exposed)."""
    task_id = "task_cache_running"
    run_id = "run_cache_running"
    async with api_client(tmp_path) as (application, client):
        repository = application.state.task_repository
        await repository.save_snapshot(
            snapshot_with_run(task_id, run_id, RunStatus.RUNNING)
        )
        _seed_v2_cache_entry(repository, task_id)

        listed = await client.get(f"/api/v1/tasks/{task_id}/artifacts")
        download = await client.get(
            f"/api/v1/tasks/{task_id}/artifacts/artifact_primary"
        )

    assert listed.status_code == 200
    assert listed.json() == {"artifacts": [], "degraded": False}
    assert download.status_code == 404
    assert download.json() == {"detail": "Artifact not found"}


@pytest.mark.asyncio
async def test_artifact_api_cache_integrity_conflict_falls_back_to_legacy(
    tmp_path: Path,
) -> None:
    """A tampered cached artifact skips the cache entry and falls back.

    C2c: the listing no longer 409s on a corrupt cache file — it degrades to
    the legacy mirror. Without a mirror the listing is empty, not an error.
    """
    task_id = "task_cache_corrupt"
    run_id = "run_cache_corrupt"
    async with api_client(tmp_path) as (application, client):
        repository = application.state.task_repository
        await repository.save_snapshot(
            snapshot_with_run(task_id, run_id, RunStatus.COMPLETED)
        )
        _dataset_id, entry_dir = _seed_v2_cache_entry(repository, task_id)
        primary = entry_dir / "merged" / "primary.csv"
        primary.write_bytes(primary.read_bytes() + b"x")

        listed = await client.get(f"/api/v1/tasks/{task_id}/artifacts")

    assert listed.status_code == 200
    assert listed.json() == {"artifacts": [], "degraded": False}


@pytest.mark.asyncio
async def test_artifact_api_cache_matches_task_via_build_dir_shape(
    tmp_path: Path,
) -> None:
    """F7-01 regression: the dual-read ties a cache entry to a task through
    the dataset build directory shape
    (``tasks_dir/<task_id>/datasets_build/<build_id>/``), never the
    manifest's ``task_id`` field — the V2 expression runner stamps that
    field with the agent-supplied build_id. A production-shaped manifest
    (task_id == build_id) must resolve through the cache (content-addressed
    ids), even with the V1 bridge mirror present."""
    task_id = "task_build_dir_match"
    run_id = "run_build_dir_match"
    async with api_client(tmp_path) as (application, client):
        repository = application.state.task_repository
        await repository.save_snapshot(
            snapshot_with_run(task_id, run_id, RunStatus.COMPLETED)
        )
        dataset_id, _entry_dir = _seed_v2_cache_entry(repository, task_id)
        _mirror_v1_bridge(repository, task_id)
        v1_bridge_id = _v1_bridge_artifact_id("merged/primary.csv")

        listed = await client.get(f"/api/v1/tasks/{task_id}/artifacts")
        primary = await client.get(
            f"/api/v1/tasks/{task_id}/artifacts/artifact_primary"
        )
        legacy_download = await client.get(
            f"/api/v1/tasks/{task_id}/artifacts/{v1_bridge_id}"
        )

    assert listed.status_code == 200
    assert listed.json()["degraded"] is False
    artifact_ids = [entry["artifact_id"] for entry in listed.json()["artifacts"]]
    assert "artifact_primary" in artifact_ids  # cache/content-addressed id
    assert "artifact_schema" in artifact_ids
    assert v1_bridge_id not in artifact_ids  # V1 bridge id never served
    assert primary.status_code == 200
    assert primary.content.startswith(b"record_id,gene_id")
    # Cache-first: the V1-bridge id is unknown to the cache path and is not
    # served by falling back to the legacy surface.
    assert legacy_download.status_code == 404
    assert dataset_id.startswith("dataset_")


# F7-05: path-traversal pins for the artifact path guards. The guards are
# correct by inspection; these regression tests prove a malicious
# relative_path can never resolve (or read) outside the build/cache dir.
# ---------------------------------------------------------------------------


def test_verified_build_artifact_path_rejects_traversal(tmp_path: Path) -> None:
    """``_verified_build_artifact_path`` must reject traversal/absolute
    paths with 409 before any file access — even when the target exists."""
    from app.api.routes import _verified_build_artifact_path
    from fastapi import HTTPException

    build_dir = tmp_path / "build_x"
    build_dir.mkdir()
    secret = tmp_path / "secret.csv"
    secret.write_text("top-secret\n", "utf-8")
    (build_dir / "ok.csv").write_text("fine\n", "utf-8")

    for malicious in ("../secret.csv", "../../etc/passwd", "/etc/passwd"):
        with pytest.raises(HTTPException) as exc:
            _verified_build_artifact_path(build_dir, malicious)
        assert exc.value.status_code == 409
        assert exc.value.detail == "Invalid build artifact path"

    # The sentinel was never read: the guard fires on the containment
    # check, before is_file()/stat ever touch the filesystem.
    assert secret.read_text("utf-8") == "top-secret\n"
    # In-dir artifacts still resolve normally (the guard is not over-broad).
    assert _verified_build_artifact_path(build_dir, "ok.csv") == (
        build_dir / "ok.csv"
    ).resolve()


def test_verified_cache_artifact_path_rejects_traversal(tmp_path: Path) -> None:
    """``_verified_cache_artifact_path`` must reject traversal/absolute
    paths with 409 before any file access."""
    from app.api.routes import _verified_cache_artifact_path
    from fastapi import HTTPException

    entry_dir = tmp_path / "entry"
    entry_dir.mkdir()
    secret = tmp_path / "secret.txt"
    secret.write_text("s3cret\n", "utf-8")
    (entry_dir / "ok.json").write_text("{}", "utf-8")

    for malicious in ("../secret.txt", "../../etc/passwd", "/etc/hostname"):
        with pytest.raises(HTTPException) as exc:
            _verified_cache_artifact_path(entry_dir, malicious)
        assert exc.value.status_code == 409
        assert exc.value.detail == "Invalid cache artifact path"

    assert secret.read_text("utf-8") == "s3cret\n"
    assert _verified_cache_artifact_path(entry_dir, "ok.json") == (
        entry_dir / "ok.json"
    ).resolve()


@pytest.mark.asyncio
async def test_list_artifacts_caches_verified_digests_and_invalidates_on_touch(
    tmp_path: Path,
) -> None:
    """C3d: listing digests are cached (mtime+size key); touching a file
    invalidates exactly that entry; downloads stay out of the cache."""
    import os

    from app.api import routes as routes_module
    from app.datasets.build.cache import DatasetCacheV2

    async with api_client(tmp_path) as (application, client):
        await seed_fixture(application, "task_cached_digests")
        repository = application.state.task_repository
        cache = DatasetCacheV2(repository.tasks_dir.parent.parent / "cache")
        entry = next(
            candidate
            for candidate in cache.list(namespace="build", limit=10_000)
            if candidate.build_id == _DUAL_READ_BUILD_ID
        )

        calls: list[Path] = []
        real_hash = routes_module._file_sha256

        def counting_hash(
            path: Path,
            chunk_size: int = routes_module._HASH_CHUNK_SIZE,
        ) -> str:
            calls.append(path)
            return real_hash(path, chunk_size)

        routes_module._file_sha256 = counting_hash
        try:
            first = await client.get("/api/v1/tasks/task_cached_digests/artifacts")
            assert first.status_code == 200
            first_delta = len(calls)
            assert first_delta >= 3  # dataset_manifest.json + primary.csv + schema.json

            # 第二次 list：全部命中缓存，不重新读文件（delta == 0）
            second = await client.get("/api/v1/tasks/task_cached_digests/artifacts")
            assert second.status_code == 200
            second_delta = len(calls) - first_delta
            assert second_delta == 0

            # touch 一个 artifact（仅改 mtime，内容不变）→ 只重算该文件
            touched = entry.directory / "merged" / "primary.csv"
            stat = touched.stat()
            os.utime(
                touched,
                ns=(stat.st_atime_ns, stat.st_mtime_ns + 2_000_000_000),
            )
            third = await client.get("/api/v1/tasks/task_cached_digests/artifacts")
            assert third.status_code == 200
            third_delta = len(calls) - first_delta - second_delta
            assert third_delta == 1
            assert Path(calls[-1]) == touched
        finally:
            routes_module._file_sha256 = real_hash


@pytest.mark.asyncio
async def test_list_artifacts_includes_corrections_todo_csv(tmp_path: Path) -> None:
    """C2b: HIL 超时落盘的 corrections_todo.csv 必须出现在 list_artifacts 且可下载。

    cache-first 面（seed_fixture 双写 V2 cache + legacy 镜像）：corrections 文件
    独立于 manifest，两分支都应追加该条目。
    """
    async with api_client(tmp_path) as (application, client):
        repository = application.state.task_repository
        await seed_fixture(application, "task_corrections")
        artifacts_dir = repository.tasks_dir / "task_corrections" / "artifacts"
        (artifacts_dir / "corrections_todo.csv").write_text(
            "request_id,summary\nreq_1,GSE 数据源确认超时\n", "utf-8-sig"
        )

        response = await client.get("/api/v1/tasks/task_corrections/artifacts")
        assert response.status_code == 200
        entries = response.json()["artifacts"]
        corrections = next(
            (entry for entry in entries if entry["artifact_id"] == "corrections_todo"),
            None,
        )
        assert corrections is not None
        assert corrections["name"] == "corrections_todo.csv"
        assert corrections["role"] == "audit_report"
        assert corrections["media_type"] == "text/csv"
        assert corrections["size"] == (
            artifacts_dir / "corrections_todo.csv"
        ).stat().st_size

        download = await client.get(
            "/api/v1/tasks/task_corrections/artifacts/corrections_todo"
        )
        assert download.status_code == 200
        assert b"request_id" in download.content


@pytest.mark.asyncio
async def test_list_artifacts_without_corrections_file_unchanged(tmp_path: Path) -> None:
    """C2b: 无 corrections_todo.csv 时列表保持不变（无该条目，200）。"""

    async with api_client(tmp_path) as (application, client):
        repository = application.state.task_repository
        await seed_fixture(application, "task_no_corrections")
        assert not (
            repository.tasks_dir / "task_no_corrections" / "artifacts"
            / "corrections_todo.csv"
        ).exists()

        response = await client.get("/api/v1/tasks/task_no_corrections/artifacts")
        assert response.status_code == 200
        artifact_ids = [entry["artifact_id"] for entry in response.json()["artifacts"]]
        assert "corrections_todo" not in artifact_ids


@pytest.mark.asyncio
async def test_legacy_only_task_lists_corrections_todo(tmp_path: Path) -> None:
    """C2b: 无 cache 的 legacy 面（loaded None 分支）也列出 corrections 条目。"""

    async with api_client(tmp_path) as (application, client):
        repository = application.state.task_repository
        task_id = "task_legacy_corrections"
        await repository.save_snapshot(
            snapshot_with_run(task_id, f"run_{task_id}", RunStatus.COMPLETED)
        )
        artifacts_dir = repository.tasks_dir / task_id / "artifacts"
        artifacts_dir.mkdir(parents=True, exist_ok=True)
        (artifacts_dir / "corrections_todo.csv").write_text(
            "request_id,summary\nreq_2,遗留任务超时\n", "utf-8-sig"
        )

        response = await client.get(f"/api/v1/tasks/{task_id}/artifacts")
        assert response.status_code == 200
        entries = response.json()["artifacts"]
        assert any(entry["artifact_id"] == "corrections_todo" for entry in entries)


@pytest.mark.asyncio
async def test_legacy_loaded_none_downloads_corrections_todo(tmp_path: Path) -> None:
    """C2b fix: loaded-None 分支 list 列出 corrections 后，下载也必须 200。

    Reviewer finding (Medium): 下载端点在 ``loaded is None`` 守卫前 404，
    导致 legacy 面（无 manifest 镜像，仅 HIL 超时落盘）列出但下载不了。
    """

    async with api_client(tmp_path) as (application, client):
        repository = application.state.task_repository
        task_id = "task_legacy_corrections_dl"
        await repository.save_snapshot(
            snapshot_with_run(task_id, f"run_{task_id}", RunStatus.COMPLETED)
        )
        artifacts_dir = repository.tasks_dir / task_id / "artifacts"
        artifacts_dir.mkdir(parents=True, exist_ok=True)
        payload = "request_id,summary\nreq_2,遗留任务超时\n"
        (artifacts_dir / "corrections_todo.csv").write_text(payload, "utf-8-sig")

        listed = await client.get(f"/api/v1/tasks/{task_id}/artifacts")
        download = await client.get(
            f"/api/v1/tasks/{task_id}/artifacts/corrections_todo"
        )

    assert listed.status_code == 200
    assert any(
        entry["artifact_id"] == "corrections_todo"
        for entry in listed.json()["artifacts"]
    )
    assert download.status_code == 200
    assert download.content.endswith(payload.encode("utf-8"))


@pytest.mark.asyncio
async def test_legacy_normal_branch_lists_and_downloads_corrections_todo(
    tmp_path: Path,
) -> None:
    """C2b fix: legacy 正常分支（有效 manifest + corrections）list 与 download 均可用。"""

    from datetime import timedelta

    from app.domain.contracts import TaskState
    from app.domain.contracts.pipeline import (
        ArtifactManifestEntry,
        RunManifest,
        ValidationSummary,
    )

    async with api_client(tmp_path) as (application, client):
        repository = application.state.task_repository
        task_id = "task_legacy_normal_corrections"
        run_id = f"run_{task_id}"
        await repository.save_snapshot(
            snapshot_with_run(task_id, run_id, RunStatus.COMPLETED)
        )
        artifacts_dir = repository.tasks_dir / task_id / "artifacts"
        artifacts_dir.mkdir(parents=True, exist_ok=True)
        primary_bytes = b"record_id,gene_id\nrow_1,TP53\n"
        (artifacts_dir / "primary.csv").write_bytes(primary_bytes)
        corrections_payload = "request_id,summary\nreq_9,超时记录\n"
        (artifacts_dir / "corrections_todo.csv").write_text(
            corrections_payload, "utf-8-sig"
        )
        manifest = RunManifest(
            task_id=task_id,
            id_generation_version="1.0",
            request={"topic": "TP53 表达差异"},
            specification={"topic": "TP53 表达差异"},
            task_state=TaskState.COMPLETED,
            artifacts=[
                ArtifactManifestEntry(
                    artifact_id="artifact_primary",
                    role="primary_dataset",
                    name="primary.csv",
                    relative_path="artifacts/primary.csv",
                    media_type="text/csv",
                    size_bytes=len(primary_bytes),
                    sha256=__import__("hashlib").sha256(primary_bytes).hexdigest(),
                    generated_by_step_id="step_1",
                )
            ],
            validation=ValidationSummary(
                status="valid",
                checked_count=1,
                failed_count=0,
                report_path="validation_report.json",
            ),
            pipeline_version="1.0",
            started_at=NOW,
            finished_at=NOW + timedelta(seconds=1),
        )
        (artifacts_dir / "run_manifest.json").write_text(
            manifest.model_dump_json(), "utf-8"
        )

        listed = await client.get(f"/api/v1/tasks/{task_id}/artifacts")
        download = await client.get(
            f"/api/v1/tasks/{task_id}/artifacts/corrections_todo"
        )

    assert listed.status_code == 200
    listed_ids = [entry["artifact_id"] for entry in listed.json()["artifacts"]]
    assert "corrections_todo" in listed_ids
    assert "artifact_primary" in listed_ids
    assert download.status_code == 200
    assert download.content.endswith(corrections_payload.encode("utf-8"))
