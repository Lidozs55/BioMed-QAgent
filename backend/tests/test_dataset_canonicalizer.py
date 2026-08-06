"""Canonicalizer tests: namespace authorization, unit policy, audits."""

from __future__ import annotations

import csv
import hashlib
from pathlib import Path

from app.datasets.build.adapters import GdcExpressionAdapter, XenaMatrixAdapter
from app.datasets.build.canonicalizer import (
    CanonicalizationResult,
    authorize_namespace,
    canonicalize,
)
from app.datasets.build.profiles import _expression_normalization_v1
from app.datasets.schema_registry import build_gene_expression_schema
from app.domain.contracts import DataLevel, SourceAsset, asset_id_from_sha256

FIXTURES = Path(__file__).parent / "fixtures"


def _source_asset(relative_path: str) -> SourceAsset:
    path = FIXTURES / relative_path
    checksum = hashlib.sha256(path.read_bytes()).hexdigest()
    return SourceAsset(
        asset_id=asset_id_from_sha256(checksum),
        kind="source",
        relative_path=f"source_assets/{relative_path}",
        sha256=checksum,
        size_bytes=path.stat().st_size,
        media_type="text/tab-separated-values",
        source_id="src_test",
        successful_attempt_id="attempt_1",
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )


def _canonicalize(fixture: str, adapter, tmp_path: Path) -> CanonicalizationResult:
    asset = _source_asset(fixture)
    batch = adapter.parse(
        asset,
        FIXTURES / fixture,
        build_id="build_test",
        binding_id="binding_1",
        schema_ref="gene_expression.long.v1",
        output_dir=tmp_path,
    )
    return canonicalize(
        batch=batch,
        schema=build_gene_expression_schema(),
        profile=_expression_normalization_v1(),
        output_dir=tmp_path,
    )


def test_authorize_namespace_rules() -> None:
    assert authorize_namespace("ENSG00000141510") == (
        "ENSG00000141510", "ensembl_gene", "",
    )
    assert authorize_namespace("ENSG00000141510.17") == (
        "ENSG00000141510", "ensembl_gene", "17",
    )
    assert authorize_namespace("TP53") == ("TP53", "gene_symbol", "")
    assert authorize_namespace("BRCA1") == ("BRCA1", "gene_symbol", "")
    assert authorize_namespace("1007_s_at") is None
    assert authorize_namespace("") is None


def test_canonical_matrix_rows(tmp_path: Path) -> None:
    result = _canonicalize(
        "gdc/gdc_expression.tsv", GdcExpressionAdapter(), tmp_path
    )
    assert result.row_count == 4
    assert result.rejected_count == 0
    assert result.namespaces == ("gene_symbol",)
    columns = [field.name for field in build_gene_expression_schema().fields]
    with result.canonical_path.open(encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    assert list(rows[0].keys()) == columns
    assert rows[0]["gene_id"] == "TP53"
    assert rows[0]["gene_id_namespace"] == "gene_symbol"
    assert rows[0]["gene_id_version"] == ""
    assert rows[0]["gene_id_raw"] == "TP53"
    assert rows[0]["source_sample_alias"] == "S1"
    assert rows[0]["record_id"].startswith("rec_")


def test_canonical_star_ensembl_normalization(tmp_path: Path) -> None:
    result = _canonicalize(
        "gdc/gdc_star_counts.tsv", GdcExpressionAdapter(), tmp_path
    )
    # The annotation row was already rejected at the adapter (parse) level,
    # so the canonicalizer sees only the two ENSG rows.
    assert result.row_count == 2
    assert result.rejected_count == 0
    assert result.namespaces == ("ensembl_gene",)
    with result.canonical_path.open(encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    assert rows[0]["gene_id"] == "ENSG00000141510"
    assert rows[0]["gene_id_namespace"] == "ensembl_gene"
    assert rows[0]["gene_id_version"] == "17"
    log = (tmp_path / "canonical" / "binding_1_normalization_log.csv").read_text()
    assert "ensembl_version_split" in log
    assert "ENSG00000141510" in log


def test_canonical_rejected_rows_audit(tmp_path: Path) -> None:
    _canonicalize("gdc/gdc_star_counts.tsv", GdcExpressionAdapter(), tmp_path)
    # Parse-level rejection stays at the adapter output.
    parse_rejected = (tmp_path / "batches" / "binding_1_rejected.csv").read_text()
    assert "__no_feature" in parse_rejected
    assert "non_ensg_annotation_row" in parse_rejected
    # Canonicalizer audit is present (header only for this fixture).
    normalization_rejected = (
        tmp_path / "canonical" / "binding_1_rejected.csv"
    ).read_text()
    assert "unauthorized_namespace" not in normalization_rejected


def test_field_mappings_audit_written(tmp_path: Path) -> None:
    _canonicalize("gdc/gdc_expression.tsv", GdcExpressionAdapter(), tmp_path)
    mappings_path = tmp_path / "canonical" / "binding_1_field_mappings.csv"
    lines = mappings_path.read_text().splitlines()
    assert len(lines) == 6  # header + gene_id + 2 per sample (x2 samples)
    assert "adapter_declared" in lines[1]


def test_canonical_batch_metadata(tmp_path: Path) -> None:
    result = _canonicalize(
        "ncbi/gse178352/xena_matrix.tsv", XenaMatrixAdapter(), tmp_path
    )
    batch = result.batch
    assert batch.schema_ref == "gene_expression.long.v1"
    assert batch.row_count == 4
    assert batch.column_count == len(build_gene_expression_schema().fields)
    assert batch.file_asset.kind == "normalized"
    assert batch.statistics["gene_id_namespaces"] == ["gene_symbol"]


def test_canonical_is_deterministic(tmp_path: Path) -> None:
    first = _canonicalize("gdc/gdc_expression.tsv", GdcExpressionAdapter(), tmp_path)
    second = _canonicalize("gdc/gdc_expression.tsv", GdcExpressionAdapter(), tmp_path)
    assert first.canonical_path.read_bytes() == second.canonical_path.read_bytes()
    assert first.batch.file_asset.sha256 == second.batch.file_asset.sha256


def test_unknown_unit_rejected(tmp_path: Path) -> None:
    # GDC STAR uses unstranded counts; remove it from the allowed set to force
    # an unknown_unit rejection via a custom profile.
    from app.datasets.contracts import NormalizationProfile

    profile = _expression_normalization_v1()
    restricted = NormalizationProfile(
        profile_id="gene_expression.normalization.restricted.v1",
        dataset_family="gene_expression",
        allowed_namespaces=profile.allowed_namespaces,
        allowed_units=["expression_value"],  # tpm_unstranded not allowed
        allowed_semantics=profile.allowed_semantics,
        aggregation_policy="keep_all",
    )
    asset = _source_asset("gdc/gdc_star_counts.tsv")
    batch = GdcExpressionAdapter().parse(
        asset,
        FIXTURES / "gdc/gdc_star_counts.tsv",
        build_id="build_test",
        binding_id="binding_1",
        schema_ref="gene_expression.long.v1",
        output_dir=tmp_path,
    )
    result = canonicalize(
        batch=batch,
        schema=build_gene_expression_schema(),
        profile=restricted,
        output_dir=tmp_path,
    )
    assert result.row_count == 0
    assert result.rejected_count == 2
    rejected = (tmp_path / "canonical" / "binding_1_rejected.csv").read_text()
    assert "unknown_unit" in rejected
