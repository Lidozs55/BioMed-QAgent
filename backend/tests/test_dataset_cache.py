"""V2 Dataset Cache tests (Design §16 Phase 7 P0)."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest
from app.datasets.build.cache import CacheEntry, DatasetCacheV2, derive_dataset_id
from app.datasets.contracts import (
    AcquisitionMode,
    ArtifactRole,
    DatasetBuildSpec,
    SourceBinding,
    SourceBindingAcquisition,
)
from app.domain.contracts import DataLevel, SourceAsset, asset_id_from_sha256

FIXTURES = Path(__file__).parent / "fixtures"


def _binding(binding_id: str, source: str, adapter_id: str) -> SourceBinding:
    return SourceBinding(
        binding_id=binding_id,
        source=source,
        acquisition=SourceBindingAcquisition(
            mode=AcquisitionMode.BUILTIN, provider_id=f"{source}.v1"
        ),
        adapter_id=adapter_id,
    )


def _spec(bindings: list[SourceBinding], build_id: str = "build_cache_test") -> DatasetBuildSpec:
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


def _build_output(tmp_path: Path) -> Path:
    """Create a minimal build output dir with a real manifest + artifacts."""
    output_dir = tmp_path / "build"
    output_dir.mkdir(parents=True)
    primary = output_dir / "merged" / "primary.csv"
    primary.parent.mkdir(parents=True)
    primary.write_text("record_id,gene_id\nrow_1,TP53\n", "utf-8")
    schema = output_dir / "schema.json"
    schema.write_text('{"schema_id": "gene_expression.long.v1"}', "utf-8")
    provenance = output_dir / "provenance.json"
    provenance.write_text('{"sources": []}', "utf-8")
    manifest = output_dir / "dataset_manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "manifest_id": "manifest_test",
                "task_id": "task_test",
                "build_id": "build_cache_test",
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
                        "size_bytes": primary.stat().st_size,
                        "sha256": "b" * 64,
                    },
                    {
                        "artifact_id": "artifact_schema",
                        "role": ArtifactRole.SCHEMA.value,
                        "relative_path": "schema.json",
                        "media_type": "application/json",
                        "size_bytes": schema.stat().st_size,
                        "sha256": "c" * 64,
                    },
                    {
                        "artifact_id": "artifact_provenance",
                        "role": ArtifactRole.PROVENANCE.value,
                        "relative_path": "provenance.json",
                        "media_type": "application/json",
                        "size_bytes": provenance.stat().st_size,
                        "sha256": "d" * 64,
                    },
                ],
                "source_summary": {},
                "validation_summary": {"status": "passed"},
                "confidence_summary": {},
                "provenance_summary": {"source_count": 1},
            },
            ensure_ascii=False,
        ),
        "utf-8",
    )
    return output_dir


def test_commit_creates_content_addressed_entry(tmp_path: Path) -> None:
    cache = DatasetCacheV2(tmp_path / "cache")
    output_dir = _build_output(tmp_path)
    spec = _spec([_binding("binding_gdc", "gdc", "gdc.expression.v1")])
    assets = {"binding_gdc": _source_asset("gdc/gdc_expression.tsv", "src_gdc")}

    entry = cache.commit(
        namespace="user_import",
        output_dir=output_dir,
        spec=spec,
        source_assets=assets,
        keywords=["TP53", "expression"],
    )

    assert isinstance(entry, CacheEntry)
    assert entry.dataset_family == "gene_expression"
    assert entry.schema_ref == "gene_expression.long.v1"
    assert entry.row_count == 1
    assert entry.keywords == ("TP53", "expression")
    assert entry.directory.is_dir()
    # All declared artifacts are copied, subdirectories preserved.
    assert (entry.directory / "dataset_manifest.json").is_file()
    assert (entry.directory / "cache_manifest.json").is_file()
    assert (entry.directory / "merged" / "primary.csv").is_file()
    assert (entry.directory / "schema.json").is_file()
    assert (entry.directory / "provenance.json").is_file()


def test_same_identity_commits_are_idempotent(tmp_path: Path) -> None:
    cache = DatasetCacheV2(tmp_path / "cache")
    output_dir = _build_output(tmp_path)
    spec = _spec([_binding("binding_gdc", "gdc", "gdc.expression.v1")])
    assets = {"binding_gdc": _source_asset("gdc/gdc_expression.tsv", "src_gdc")}

    first = cache.commit(
        namespace="ns", output_dir=output_dir, spec=spec, source_assets=assets
    )
    second = cache.commit(
        namespace="ns", output_dir=output_dir, spec=spec, source_assets=assets
    )
    assert first.dataset_id == second.dataset_id
    entries = cache.list(namespace="ns")
    assert len(entries) == 1


def test_parameter_change_derives_new_key(tmp_path: Path) -> None:
    spec_a = _spec([_binding("binding_gdc", "gdc", "gdc.expression.v1")])
    spec_b = _spec([_binding("binding_xena", "ucsc_xena", "xena.matrix.v1")])
    assets_a = {"binding_gdc": _source_asset("gdc/gdc_expression.tsv", "src_gdc")}
    assets_b = {"binding_xena": _source_asset("ncbi/gse178352/xena_matrix.tsv", "src_xena")}
    assert derive_dataset_id(spec_a, assets_a) != derive_dataset_id(spec_b, assets_b)
    assert derive_dataset_id(spec_a, assets_a) == derive_dataset_id(spec_a, assets_a)


def test_find_and_search(tmp_path: Path) -> None:
    cache = DatasetCacheV2(tmp_path / "cache")
    output_dir = _build_output(tmp_path)
    spec = _spec([_binding("binding_gdc", "gdc", "gdc.expression.v1")])
    assets = {"binding_gdc": _source_asset("gdc/gdc_expression.tsv", "src_gdc")}
    entry = cache.commit(
        namespace="ns",
        output_dir=output_dir,
        spec=spec,
        source_assets=assets,
        keywords=["tp53"],
    )

    found = cache.find("ns", entry.dataset_id)
    assert found is not None
    assert found.manifest_id == "manifest_test"
    assert cache.find("ns", "dataset_does_not_exist") is None
    assert cache.find("other", entry.dataset_id) is None

    hits = cache.search("tp53")
    assert [h.dataset_id for h in hits] == [entry.dataset_id]
    assert cache.search("nope") == []


def test_invalid_namespace_rejected(tmp_path: Path) -> None:
    cache = DatasetCacheV2(tmp_path / "cache")
    with pytest.raises(ValueError):
        cache.commit(
            namespace="../escape",
            output_dir=_build_output(tmp_path),
            spec=_spec([_binding("binding_gdc", "gdc", "gdc.expression.v1")]),
            source_assets={"binding_gdc": _source_asset("gdc/gdc_expression.tsv", "src_gdc")},
        )
    with pytest.raises(ValueError):
        cache.find("a/b", "dataset_x")


def test_commit_missing_manifest_fails(tmp_path: Path) -> None:
    cache = DatasetCacheV2(tmp_path / "cache")
    empty = tmp_path / "empty"
    empty.mkdir()
    spec = _spec([_binding("binding_gdc", "gdc", "gdc.expression.v1")])
    assets = {"binding_gdc": _source_asset("gdc/gdc_expression.tsv", "src_gdc")}
    with pytest.raises(FileNotFoundError):
        cache.commit(
            namespace="ns",
            output_dir=empty,
            spec=spec,
            source_assets=assets,
        )
