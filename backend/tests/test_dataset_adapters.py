"""SourceAdapter tests: GDC matrix / STAR-counts, Xena matrix, fail-closed."""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest
from app.datasets.build.adapters import (
    SOURCE_LONG_COLUMNS,
    GdcExpressionAdapter,
    XenaMatrixAdapter,
    get_adapter,
)
from app.datasets.build.errors import AdapterError
from app.datasets.contracts import (
    ConfidenceLevel,
    MappingMethod,
    MappingReviewStatus,
)
from app.domain.contracts import DataLevel, SourceAsset, asset_id_from_sha256

FIXTURES = Path(__file__).parent / "fixtures"


def _source_asset(relative_path: str, source_id: str = "src_test") -> SourceAsset:
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


def _source_asset_for_path(path: Path, source_id: str = "src_test") -> SourceAsset:
    checksum = hashlib.sha256(path.read_bytes()).hexdigest()
    return SourceAsset(
        asset_id=asset_id_from_sha256(checksum),
        kind="source",
        relative_path=f"source_assets/{path.name}",
        sha256=checksum,
        size_bytes=path.stat().st_size,
        media_type="text/tab-separated-values",
        source_id=source_id,
        successful_attempt_id="attempt_1",
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )


def _run_adapter(adapter, fixture: str, output_dir: Path, source_id: str = "src_test"):
    asset = _source_asset(fixture, source_id=source_id)
    return adapter.parse(
        asset,
        FIXTURES / fixture,
        build_id="build_test",
        binding_id="binding_1",
        schema_ref="gene_expression.long.v1",
        output_dir=output_dir,
    )


def test_gdc_matrix_batch_shape(tmp_path: Path) -> None:
    batch = _run_adapter(GdcExpressionAdapter(), "gdc/gdc_expression.tsv", tmp_path)
    assert batch.batch_id == "batch_binding_1"
    assert batch.dataset_family == "gene_expression"
    assert batch.row_granularity == "gene_sample_measurement"
    assert batch.schema_ref == "gene_expression.long.v1"
    assert batch.parser_id == "gdc.expression.v1"
    assert batch.row_count == 4  # 2 genes x 2 samples
    assert batch.column_count == len(SOURCE_LONG_COLUMNS)
    assert batch.statistics["format"] == "expression_matrix"
    assert batch.statistics["sample_count"] == 2
    assert batch.statistics["rejected_count"] == 0
    assert batch.warnings == []


def test_gdc_matrix_declared_mappings(tmp_path: Path) -> None:
    batch = _run_adapter(GdcExpressionAdapter(), "gdc/gdc_expression.tsv", tmp_path)
    pairs = {(m.source_field, m.target_field) for m in batch.declared_mappings}
    assert ("gene_id", "gene_id_raw") in pairs
    assert ("S1", "sample_id") in pairs
    assert ("S1", "expression_value") in pairs
    sample_mapping = next(
        m for m in batch.declared_mappings
        if m.source_field == "S1" and m.target_field == "sample_id"
    )
    assert sample_mapping.transform == "wide_to_long_sample_id"
    assert all(
        m.mapping_method is MappingMethod.ADAPTER_DECLARED
        and m.review_status is MappingReviewStatus.ACCEPTED
        and m.confidence_level is ConfidenceLevel.HIGH
        for m in batch.declared_mappings
    )


def test_gdc_matrix_rows_are_source_long(tmp_path: Path) -> None:
    batch = _run_adapter(GdcExpressionAdapter(), "gdc/gdc_expression.tsv", tmp_path)
    lines = batch.file_asset.relative_path
    content = (tmp_path / lines).read_text().splitlines()
    header, *rows = content
    assert header.split(",") == list(SOURCE_LONG_COLUMNS)
    assert len(rows) == 4
    first = dict(zip(header.split(","), rows[0].split(","), strict=True))
    assert first["gene_id_raw"] == "TP53"
    assert first["sample_id"] == "S1"
    assert first["expression_value"] == "1.5"
    assert first["expression_unit"] == "expression_value"
    assert first["source_line_number"] == "2"


def test_gdc_star_counts_batch(tmp_path: Path) -> None:
    batch = _run_adapter(GdcExpressionAdapter(), "gdc/gdc_star_counts.tsv", tmp_path)
    assert batch.statistics["format"] == "star_counts"
    assert batch.statistics["source_row_count"] == 2
    assert batch.row_count == 2  # __no_feature row rejected, not silently dropped
    assert batch.statistics["rejected_count"] == 1
    assert batch.warnings == []
    rows = (tmp_path / batch.file_asset.relative_path).read_text().splitlines()[1:]
    assert len(rows) == 2
    first = rows[0].split(",")
    assert first[1] == "build_test"  # dataset_id
    assert first[4] == "ENSG00000141510.17"  # gene_id_raw verbatim with version
    assert first[9].lower() == "true"  # is_normalized for tpm
    assert first[11] == "85.5"  # expression_value
    assert first[12] == "tpm_unstranded"  # expression_unit


def test_gdc_star_rejected_rows_audited(tmp_path: Path) -> None:
    _run_adapter(GdcExpressionAdapter(), "gdc/gdc_star_counts.tsv", tmp_path)
    rejected_path = tmp_path / "batches" / "binding_1_rejected.csv"
    lines = rejected_path.read_text().splitlines()
    assert len(lines) == 2  # header + one rejected row
    assert "__no_feature" in lines[1]
    assert "non_ensg_annotation_row" in lines[1]


def test_xena_matrix_batch(tmp_path: Path) -> None:
    batch = _run_adapter(
        XenaMatrixAdapter(), "ncbi/gse178352/xena_matrix.tsv", tmp_path
    )
    assert batch.parser_id == "xena.matrix.v1"
    assert batch.statistics["format"] == "expression_matrix"
    assert batch.row_count == 4
    assert len(batch.declared_mappings) == 5  # gene_id + 2 per sample


def test_checksum_mismatch_fails_closed(tmp_path: Path) -> None:
    asset = _source_asset("gdc/gdc_expression.tsv")
    tampered = SourceAsset(
        asset_id=asset_id_from_sha256("0" * 64),
        kind="source",
        relative_path="source_assets/gdc/gdc_expression.tsv",
        sha256="0" * 64,
        size_bytes=asset.size_bytes,
        media_type="text/tab-separated-values",
        source_id="src_test",
        successful_attempt_id="attempt_1",
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )
    with pytest.raises(AdapterError, match="checksum"):
        GdcExpressionAdapter().parse(
            tampered,
            FIXTURES / "gdc/gdc_expression.tsv",
            build_id="build_test",
            binding_id="binding_1",
            schema_ref="gene_expression.long.v1",
            output_dir=tmp_path,
        )
    assert not (tmp_path / "batches").exists()


def test_malformed_header_fails_closed(tmp_path: Path) -> None:
    malformed = tmp_path / "malformed.tsv"
    malformed.write_text("sample_id\tvalue\n", encoding="utf-8")
    asset = _source_asset_for_path(malformed)
    with pytest.raises(AdapterError, match="gene_id"):
        GdcExpressionAdapter().parse(
            asset,
            malformed,
            build_id="build_test",
            binding_id="binding_1",
            schema_ref="gene_expression.long.v1",
            output_dir=tmp_path,
        )


def test_non_numeric_value_fails_closed(tmp_path: Path) -> None:
    malformed = tmp_path / "bad_value.tsv"
    malformed.write_text("gene_id\tS1\nTP53\tnan-value\n", encoding="utf-8")
    asset = _source_asset_for_path(malformed)
    with pytest.raises(AdapterError, match="non-numeric"):
        GdcExpressionAdapter().parse(
            asset,
            malformed,
            build_id="build_test",
            binding_id="binding_1",
            schema_ref="gene_expression.long.v1",
            output_dir=tmp_path,
        )
    assert not (tmp_path / "batches" / "binding_1.csv").exists()


def test_unknown_adapter_rejected() -> None:
    with pytest.raises(AdapterError, match="unknown source adapter"):
        get_adapter("geo.probe.v1")


def test_adapter_registry_entries() -> None:
    assert "gdc.expression.v1" in {
        "gdc.expression.v1", "xena.matrix.v1",
    }
    assert get_adapter("xena.matrix.v1").source_database == "ucsc_xena"
