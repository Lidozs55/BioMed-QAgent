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
    header = list(SOURCE_LONG_COLUMNS)
    first = dict(zip(header, rows[0].split(","), strict=True))
    assert first["dataset_id"] == "build_test"
    assert first["gene_id_raw"] == "ENSG00000141510.17"  # verbatim with version
    assert first["is_normalized"] == "true"  # tpm metric
    assert first["expression_value"] == "85.5"
    assert first["expression_unit"] == "tpm_unstranded"


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


def test_non_finite_value_audited_not_fatal(tmp_path: Path) -> None:
    """Garbage / blank / NaN / Inf values are row-level rejections, never fatal."""
    malformed = tmp_path / "bad_value.tsv"
    malformed.write_text(
        "gene_id\tS1\nTP53\tnan-value\n", encoding="utf-8"
    )
    asset = _source_asset_for_path(malformed)
    batch = GdcExpressionAdapter().parse(
        asset,
        malformed,
        build_id="build_test",
        binding_id="binding_1",
        schema_ref="gene_expression.long.v1",
        output_dir=tmp_path,
    )
    assert batch.row_count == 0
    assert batch.statistics["rejected_count"] == 1
    assert batch.statistics["source_row_count"] == 1
    rejected = (tmp_path / "batches" / "binding_1_rejected.csv").read_text()
    assert "non_finite_value" in rejected
    assert "nan-value" in rejected


def test_nan_and_inf_values_audited(tmp_path: Path) -> None:
    malformed = tmp_path / "special.tsv"
    malformed.write_text(
        "gene_id\tS1\tS2\nTP53\tnan\tinf\nBRCA1\t3\t4.25\n",
        encoding="utf-8",
    )
    asset = _source_asset_for_path(malformed)
    batch = GdcExpressionAdapter().parse(
        asset,
        malformed,
        build_id="build_test",
        binding_id="binding_1",
        schema_ref="gene_expression.long.v1",
        output_dir=tmp_path,
    )
    assert batch.row_count == 2  # only BRCA1 cells survive
    assert batch.statistics["rejected_count"] == 2
    rejected = (tmp_path / "batches" / "binding_1_rejected.csv").read_text()
    assert "nan" in rejected and "inf" in rejected


def test_gdc_annotation_columns_ignored(tmp_path: Path) -> None:
    """GDC files-API exports may include gene_name/gene_type annotation columns."""
    annotated = tmp_path / "annotated.tsv"
    annotated.write_text(
        "gene_id\tgene_name\tgene_type\tS1\tS2\n"
        "ENSG00000141510\tTP53\tprotein_coding\t1.5\t2\n",
        encoding="utf-8",
    )
    asset = _source_asset_for_path(annotated)
    batch = GdcExpressionAdapter().parse(
        asset,
        annotated,
        build_id="build_test",
        binding_id="binding_1",
        schema_ref="gene_expression.long.v1",
        output_dir=tmp_path,
    )
    assert batch.statistics["sample_count"] == 2
    assert batch.row_count == 2
    rows = (tmp_path / batch.file_asset.relative_path).read_text().splitlines()[1:]
    assert all("protein_coding" not in row for row in rows)
    assert all("gene_name" not in row for row in rows)


def test_gzip_source_parsed(tmp_path: Path) -> None:
    import gzip as gzip_module

    gz_path = tmp_path / "gdc_expression.tsv.gz"
    raw = (FIXTURES / "gdc/gdc_expression.tsv").read_bytes()
    with gzip_module.open(gz_path, "wb") as handle:
        handle.write(raw)
    asset = _source_asset_for_path(gz_path)
    batch = GdcExpressionAdapter().parse(
        asset,
        gz_path,
        build_id="build_test",
        binding_id="binding_1",
        schema_ref="gene_expression.long.v1",
        output_dir=tmp_path,
    )
    assert batch.row_count == 4


def test_star_counts_unstranded_fallback(tmp_path: Path) -> None:
    """Header without tpm_unstranded falls back to raw unstranded counts."""
    star = tmp_path / "star_counts_raw.tsv"
    star.write_text(
        "gene_id\tgene_name\tgene_type\tunstranded\n"
        "ENSG00000141510.17\tTP53\tprotein_coding\t120\n",
        encoding="utf-8",
    )
    asset = _source_asset_for_path(star)
    batch = GdcExpressionAdapter().parse(
        asset,
        star,
        build_id="build_test",
        binding_id="binding_1",
        schema_ref="gene_expression.long.v1",
        output_dir=tmp_path,
    )
    assert batch.statistics["format"] == "star_counts"
    header = list(SOURCE_LONG_COLUMNS)
    row = dict(
        zip(
            header,
            (tmp_path / batch.file_asset.relative_path)
            .read_text()
            .splitlines()[1]
            .split(","),
            strict=True,
        )
    )
    assert row["value_semantics"] == "raw_count"
    assert row["expression_unit"] == "unstranded"
    assert row["is_normalized"] == "false"
    assert row["is_integer_expected"] == "true"


def test_blank_line_parity(tmp_path: Path) -> None:
    """Blank lines: GDC matrix is structurally strict, Xena skips them."""
    gdc_file = tmp_path / "gdc_blank.tsv"
    gdc_file.write_text("gene_id\tS1\nTP53\t1.5\n\nBRCA1\t3\n", encoding="utf-8")
    gdc_asset = _source_asset_for_path(gdc_file)
    with pytest.raises(AdapterError, match="invalid GDC expression row"):
        GdcExpressionAdapter().parse(
            gdc_asset,
            gdc_file,
            build_id="build_test",
            binding_id="binding_1",
            schema_ref="gene_expression.long.v1",
            output_dir=tmp_path,
        )

    xena_file = tmp_path / "xena_blank.tsv"
    xena_file.write_text("gene_id\tS1\nTP53\t1.5\n\nBRCA1\t3\n", encoding="utf-8")
    xena_asset = _source_asset_for_path(xena_file)
    batch = XenaMatrixAdapter().parse(
        xena_asset,
        xena_file,
        build_id="build_test",
        binding_id="binding_1",
        schema_ref="gene_expression.long.v1",
        output_dir=tmp_path,
    )
    assert batch.row_count == 2


def test_unknown_adapter_rejected() -> None:
    with pytest.raises(AdapterError, match="unknown source adapter"):
        get_adapter("geo.probe.v1")


def test_adapter_registry_entries() -> None:
    assert "gdc.expression.v1" in {
        "gdc.expression.v1", "xena.matrix.v1",
    }
    assert get_adapter("xena.matrix.v1").source_database == "ucsc_xena"
