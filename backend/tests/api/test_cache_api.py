"""V2 Dataset Cache API tests (Phase 7 T2).

``GET /api/v1/cache/datasets`` — merged listing of V2 cache entries and
legacy 22-column records (wrapped as ``gene_expression.long.legacy.v1``);
``GET /api/v1/cache/datasets/{dataset_id}`` — detail with manifest pointer +
artifact inventory (404 when unknown); artifact download for a cached dataset.
"""

from __future__ import annotations

import csv
import hashlib
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import pytest
from app.config import Settings
from app.datasets.build.cache import DatasetCacheV2
from app.datasets.contracts import (
    AcquisitionMode,
    ArtifactRole,
    DatasetBuildSpec,
    SourceBinding,
    SourceBindingAcquisition,
)
from app.domain.contracts import DataLevel, SourceAsset, asset_id_from_sha256
from app.main import create_app
from app.tools.cache_store import CACHE_MAIN_DATA_COLUMNS
from fastapi import FastAPI

FIXTURES = Path(__file__).parents[1] / "fixtures"


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


def _cache_root(repository: object) -> Path:
    return repository.tasks_dir.parent.parent / "cache"


def _binding(binding_id: str, source: str, adapter_id: str) -> SourceBinding:
    return SourceBinding(
        binding_id=binding_id,
        source=source,
        acquisition=SourceBindingAcquisition(
            mode=AcquisitionMode.BUILTIN, provider_id=f"{source}.v1"
        ),
        adapter_id=adapter_id,
    )


def _spec(bindings: list[SourceBinding], build_id: str) -> DatasetBuildSpec:
    return DatasetBuildSpec(
        build_id=build_id,
        objective="compare TP53 expression across sources",
        dataset_family="gene_expression",
        row_granularity="gene_sample_measurement",
        schema_ref="gene_expression.long.v1",
        source_bindings=bindings,
        merge_strategy="append_by_canonical_row",
        validation_profile_ref="gene_expression.release.v1",
        normalization_profile_ref="gene_expression.normalization.v1",
    )


def _source_asset(relative_path: str, source_id: str) -> SourceAsset:
    path = FIXTURES / relative_path
    checksum = hashlib.sha256(path.read_bytes()).hexdigest()
    return SourceAsset(
        asset_id=asset_id_from_sha256(checksum),
        kind="source",
        relative_path=f"source_assets/{relative_path}",
        sha256=checksum,
        size_bytes=path.stat().st_size,
        media_type="text/tab-separated-values",
        source_id=source_id,
        successful_attempt_id="attempt_1",
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _build_output(tmp_path: Path, build_id: str) -> Path:
    """Minimal build output dir with a real manifest + artifacts."""
    output_dir = tmp_path / build_id
    output_dir.mkdir(parents=True)
    primary = output_dir / "merged" / "primary.csv"
    primary.parent.mkdir(parents=True)
    primary_bytes = b"record_id,gene_id\nrow_1,TP53\n"
    primary.write_bytes(primary_bytes)
    schema = output_dir / "schema.json"
    schema_bytes = b'{"schema_id": "gene_expression.long.v1"}'
    schema.write_bytes(schema_bytes)
    manifest = output_dir / "dataset_manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "manifest_id": f"manifest_{build_id}",
                "task_id": f"task_{build_id}",
                "build_id": build_id,
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
                        "size_bytes": len(primary_bytes),
                        "sha256": _sha256_bytes(primary_bytes),
                    },
                    {
                        "artifact_id": "artifact_schema",
                        "role": ArtifactRole.SCHEMA.value,
                        "relative_path": "schema.json",
                        "media_type": "application/json",
                        "size_bytes": len(schema_bytes),
                        "sha256": _sha256_bytes(schema_bytes),
                    },
                ],
                "source_summary": {"src_gdc": 1},
                "validation_summary": {"status": "passed"},
                "confidence_summary": {},
                "provenance_summary": {"source_count": 1},
            },
            ensure_ascii=False,
        ),
        "utf-8",
    )
    return output_dir


def _seed_v2_entry(repository: object, tmp_path: Path, build_id: str) -> str:
    """Commit one V2 cache entry into the app's cache root; returns id."""
    cache = DatasetCacheV2(_cache_root(repository))
    output_dir = _build_output(tmp_path, build_id)
    spec = _spec([_binding("binding_gdc", "gdc", "gdc.expression.v1")], build_id)
    assets = {"binding_gdc": _source_asset("gdc/gdc_expression.tsv", "src_gdc")}
    entry = cache.commit(
        namespace="build",
        output_dir=output_dir,
        spec=spec,
        source_assets=assets,
        keywords=["TP53", "expression"],
    )
    return entry.dataset_id


def _seed_legacy_entry(
    repository: object,
    *,
    namespace: str,
    dataset_id: str,
    keywords: list[str] | None = None,
) -> None:
    """Write one legacy 22-column record into the app's cache root."""
    records = _cache_root(repository) / "records" / namespace / dataset_id
    records.mkdir(parents=True)
    row = {col: "" for col in CACHE_MAIN_DATA_COLUMNS}
    row.update(
        {
            "record_id": "row_1",
            "dataset_id": dataset_id,
            "gene_id": "ENSG00000141510",
            "sample_id": "TCGA-01",
            "expression_value": "3.5",
        }
    )
    with (records / "main_data.csv").open(
        "w", encoding="utf-8-sig", newline=""
    ) as handle:
        writer = csv.DictWriter(handle, fieldnames=list(CACHE_MAIN_DATA_COLUMNS))
        writer.writeheader()
        writer.writerow(row)
    (records / "manifest.json").write_text(
        json.dumps(
            {
                "dataset_id": dataset_id,
                "source_namespace": namespace,
                "topic": "TP53 expression",
                "description": "legacy cached dataset",
                "row_count": 1,
                "column_count": len(CACHE_MAIN_DATA_COLUMNS),
                "created_at": "2026-07-14T09:00:00+00:00",
                "created_by_task_id": "task_legacy",
                "source_files": [],
                "extra": {},
                "keywords": keywords or [],
            }
        ),
        "utf-8",
    )


@pytest.mark.asyncio
async def test_cache_api_lists_v2_and_legacy_merged(tmp_path: Path) -> None:
    async with api_client(tmp_path) as (application, client):
        repository = application.state.task_repository
        v2_id = _seed_v2_entry(repository, tmp_path, "build_alpha")
        _seed_legacy_entry(repository, namespace="user_import", dataset_id="dataset_legacy")

        response = await client.get("/api/v1/cache/datasets")

    assert response.status_code == 200
    payload = response.json()
    assert payload["schema_version"] == "1.0"
    items = payload["items"]
    by_id = {item["dataset_id"]: item for item in items}
    assert v2_id in by_id
    assert "dataset_legacy" in by_id
    v2_item = by_id[v2_id]
    assert v2_item["namespace"] == "build"
    assert v2_item["schema_ref"] == "gene_expression.long.v1"
    assert v2_item["row_count"] == 1
    assert v2_item["keywords"] == ["TP53", "expression"]
    assert v2_item["manifest_ref"].startswith("cache/datasets/build/")
    legacy_item = by_id["dataset_legacy"]
    assert legacy_item["namespace"] == "user_import"
    assert legacy_item["schema_ref"] == "gene_expression.long.legacy.v1"
    assert legacy_item["dataset_family"] == "gene_expression"
    assert legacy_item["manifest_ref"] == "cache/records/user_import/dataset_legacy/manifest.json"
    # Newest first: the V2 entry (committed now) precedes the legacy record.
    assert items[0]["dataset_id"] == v2_id


@pytest.mark.asyncio
async def test_cache_api_namespace_filter(tmp_path: Path) -> None:
    async with api_client(tmp_path) as (application, client):
        repository = application.state.task_repository
        _seed_v2_entry(repository, tmp_path, "build_alpha")
        _seed_legacy_entry(repository, namespace="user_import", dataset_id="dataset_legacy")

        v2_only = await client.get("/api/v1/cache/datasets", params={"namespace": "build"})
        legacy_only = await client.get(
            "/api/v1/cache/datasets", params={"namespace": "user_import"}
        )
        none = await client.get("/api/v1/cache/datasets", params={"namespace": "nope"})
        unsafe = await client.get(
            "/api/v1/cache/datasets", params={"namespace": "../escape"}
        )

    assert all(item["namespace"] == "build" for item in v2_only.json()["items"])
    assert v2_only.json()["items"][0]["schema_ref"] == "gene_expression.long.v1"
    assert all(
        item["namespace"] == "user_import" for item in legacy_only.json()["items"]
    )
    assert legacy_only.json()["items"][0]["dataset_id"] == "dataset_legacy"
    assert none.json()["items"] == []
    assert unsafe.status_code == 422


@pytest.mark.asyncio
async def test_cache_api_keyword_search(tmp_path: Path) -> None:
    async with api_client(tmp_path) as (application, client):
        repository = application.state.task_repository
        v2_id = _seed_v2_entry(repository, tmp_path, "build_alpha")
        _seed_legacy_entry(repository, namespace="user_import", dataset_id="dataset_legacy")

        hit = await client.get("/api/v1/cache/datasets", params={"keyword": "tp53"})
        miss = await client.get("/api/v1/cache/datasets", params={"keyword": "zzz"})
        empty = await client.get("/api/v1/cache/datasets", params={"keyword": "  "})

    ids = {item["dataset_id"] for item in hit.json()["items"]}
    assert v2_id in ids
    assert "dataset_legacy" in ids
    assert miss.json()["items"] == []
    assert empty.json()["items"] != []


@pytest.mark.asyncio
async def test_cache_api_detail_v2(tmp_path: Path) -> None:
    async with api_client(tmp_path) as (application, client):
        repository = application.state.task_repository
        v2_id = _seed_v2_entry(repository, tmp_path, "build_alpha")

        detail = await client.get(f"/api/v1/cache/datasets/{v2_id}")
        missing = await client.get("/api/v1/cache/datasets/dataset_nope")

    assert detail.status_code == 200
    payload = detail.json()
    assert payload["dataset_id"] == v2_id
    assert payload["schema_ref"] == "gene_expression.long.v1"
    assert payload["manifest_ref"].startswith("cache/datasets/build/")
    assert [entry["artifact_id"] for entry in payload["artifacts"]] == [
        "artifact_primary",
        "artifact_schema",
    ]
    primary = next(
        entry for entry in payload["artifacts"] if entry["role"] == "primary_dataset"
    )
    assert primary["relative_path"] == "merged/primary.csv"
    assert missing.status_code == 404
    assert missing.json() == {"detail": "Dataset not found"}


@pytest.mark.asyncio
async def test_cache_api_detail_legacy(tmp_path: Path) -> None:
    async with api_client(tmp_path) as (application, client):
        repository = application.state.task_repository
        _seed_legacy_entry(
            repository, namespace="user_import", dataset_id="dataset_legacy"
        )

        detail = await client.get("/api/v1/cache/datasets/dataset_legacy")

    assert detail.status_code == 200
    payload = detail.json()
    assert payload["schema_ref"] == "gene_expression.long.legacy.v1"
    assert payload["row_count"] == 1
    assert [entry["artifact_id"] for entry in payload["artifacts"]] == [
        "main_data",
        "manifest",
    ]
    main_data = payload["artifacts"][0]
    assert main_data["role"] == "primary_dataset"
    assert main_data["relative_path"] == "main_data.csv"
    assert main_data["media_type"] == "text/csv"


@pytest.mark.asyncio
async def test_cache_api_download_v2_artifact(tmp_path: Path) -> None:
    async with api_client(tmp_path) as (application, client):
        repository = application.state.task_repository
        v2_id = _seed_v2_entry(repository, tmp_path, "build_alpha")

        primary = await client.get(
            f"/api/v1/cache/datasets/{v2_id}/artifacts/artifact_primary"
        )
        manifest_file = await client.get(
            f"/api/v1/cache/datasets/{v2_id}/artifacts/dataset_manifest"
        )
        missing = await client.get(
            f"/api/v1/cache/datasets/{v2_id}/artifacts/artifact_nope"
        )

    assert primary.status_code == 200
    assert primary.headers["content-disposition"].endswith('filename="primary.csv"')
    assert primary.content.startswith(b"record_id,gene_id")
    assert manifest_file.status_code == 200
    assert json.loads(manifest_file.content)["build_id"] == "build_alpha"
    assert missing.status_code == 404
    assert missing.json() == {"detail": "Artifact not found"}


@pytest.mark.asyncio
async def test_cache_api_download_legacy_main_data(tmp_path: Path) -> None:
    async with api_client(tmp_path) as (application, client):
        repository = application.state.task_repository
        _seed_legacy_entry(
            repository, namespace="user_import", dataset_id="dataset_legacy"
        )

        main_data = await client.get(
            "/api/v1/cache/datasets/dataset_legacy/artifacts/main_data"
        )
        manifest_file = await client.get(
            "/api/v1/cache/datasets/dataset_legacy/artifacts/manifest"
        )

    assert main_data.status_code == 200
    assert main_data.headers["content-disposition"].endswith('filename="main_data.csv"')
    assert main_data.content.startswith(b"\xef\xbb\xbfrecord_id,dataset_id,source_id")
    assert manifest_file.status_code == 200
    assert manifest_file.json()["dataset_id"] == "dataset_legacy"


@pytest.mark.asyncio
async def test_cache_api_download_integrity_conflict(tmp_path: Path) -> None:
    async with api_client(tmp_path) as (application, client):
        repository = application.state.task_repository
        v2_id = _seed_v2_entry(repository, tmp_path, "build_alpha")
        cache = DatasetCacheV2(_cache_root(repository))
        entry = cache.find("build", v2_id)
        assert entry is not None
        primary = entry.directory / "merged" / "primary.csv"
        primary.write_bytes(primary.read_bytes() + b"tampered")

        response = await client.get(
            f"/api/v1/cache/datasets/{v2_id}/artifacts/artifact_primary"
        )

    assert response.status_code == 409
    assert response.json() == {"detail": "Artifact integrity check failed"}
