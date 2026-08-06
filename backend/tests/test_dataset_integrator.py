"""Integrator tests: append, mirror dedup, conflicts, strategy enforcement."""

from __future__ import annotations

import csv
import hashlib
from pathlib import Path

import pytest
from app.datasets.build.adapters import GdcExpressionAdapter, XenaMatrixAdapter
from app.datasets.build.canonicalizer import canonicalize
from app.datasets.build.errors import IntegratorError
from app.datasets.build.integrator import integrate
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


def _canonical(fixture: str, adapter, tmp_path: Path, binding_id: str):
    asset = _source_asset(fixture)
    batch = adapter.parse(
        asset,
        FIXTURES / fixture,
        build_id="build_test",
        binding_id=binding_id,
        schema_ref="gene_expression.long.v1",
        output_dir=tmp_path,
    )
    return canonicalize(
        batch=batch,
        schema=build_gene_expression_schema(),
        profile=_expression_normalization_v1(),
        output_dir=tmp_path,
    )


def _rows(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def test_single_source_passthrough(tmp_path: Path) -> None:
    gdc = _canonical(
        "gdc/gdc_expression.tsv", GdcExpressionAdapter(), tmp_path, "binding_gdc"
    )
    result = integrate(
        results=[gdc],
        merge_strategy="append_by_canonical_row",
        schema=build_gene_expression_schema(),
        build_id="build_test",
        output_dir=tmp_path,
    )
    assert result.row_count == 4
    assert result.dedup_count == 0
    assert result.conflict_count == 0
    assert result.batch.file_asset.kind == "artifact"
    assert len(_rows(result.merged_path)) == 4


def test_mirror_duplicates_dedup(tmp_path: Path) -> None:
    # Identical content from two bindings: 4 mirror rows deduplicated.
    gdc = _canonical(
        "gdc/gdc_expression.tsv", GdcExpressionAdapter(), tmp_path, "binding_a"
    )
    xena = _canonical(
        "gdc/gdc_expression.tsv", GdcExpressionAdapter(), tmp_path, "binding_b"
    )
    result = integrate(
        results=[gdc, xena],
        merge_strategy="append_by_canonical_row",
        schema=build_gene_expression_schema(),
        build_id="build_test",
        output_dir=tmp_path,
    )
    assert result.row_count == 4
    assert result.dedup_count == 4
    assert result.conflict_count == 0
    assert result.batch.statistics["dedup_count"] == 4


def test_value_conflict_audited(tmp_path: Path) -> None:
    """xena_matrix.tsv deliberately diverges on TP53/S2 (9.9 vs 2)."""
    gdc = _canonical(
        "gdc/gdc_expression.tsv", GdcExpressionAdapter(), tmp_path, "binding_gdc"
    )
    xena = _canonical(
        "ncbi/gse178352/xena_matrix.tsv", XenaMatrixAdapter(), tmp_path, "binding_xena"
    )
    result = integrate(
        results=[gdc, xena],
        merge_strategy="append_by_canonical_row",
        schema=build_gene_expression_schema(),
        build_id="build_test",
        output_dir=tmp_path,
    )
    assert result.row_count == 4  # first source value kept
    assert result.dedup_count == 3  # TP53/S1, BRCA1/S1, BRCA1/S2 mirror
    assert result.conflict_count == 1  # TP53/S2 diverges
    conflicts = _rows(result.conflicts_path)
    assert conflicts[0]["gene_id"] == "TP53"
    assert conflicts[0]["sample_id"] == "S2"
    assert conflicts[0]["first_value"] == "2"
    assert conflicts[0]["second_value"] == "9.9"
    assert conflicts[0]["action"] == "kept_first_source"
    merged = _rows(result.merged_path)
    tp53_s2 = next(
        r for r in merged if r["gene_id"] == "TP53" and r["sample_id"] == "S2"
    )
    assert tp53_s2["expression_value"] == "2"


def test_numeric_equivalent_values_dedup(tmp_path: Path) -> None:
    """"1.0" vs "1" are numerically equal and must dedup, not conflict."""
    gdc = _canonical(
        "gdc/gdc_expression.tsv", GdcExpressionAdapter(), tmp_path, "binding_a"
    )
    xena = _canonical(
        "gdc/gdc_expression.tsv", GdcExpressionAdapter(), tmp_path, "binding_b"
    )
    rows = _rows(xena.canonical_path)
    for row in rows:
        if row["gene_id"] == "TP53" and row["sample_id"] == "S1":
            row["expression_value"] = "1.50"
    header = list(rows[0].keys())
    with xena.canonical_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=header)
        writer.writeheader()
        writer.writerows(rows)
    result = integrate(
        results=[gdc, xena],
        merge_strategy="append_by_canonical_row",
        schema=build_gene_expression_schema(),
        build_id="build_test",
        output_dir=tmp_path,
    )
    assert result.dedup_count == 4
    assert result.conflict_count == 0


def test_measurement_type_is_part_of_identity(tmp_path: Path) -> None:
    """Rows differing only in measurement_type are distinct rows."""
    gdc = _canonical(
        "gdc/gdc_expression.tsv", GdcExpressionAdapter(), tmp_path, "binding_a"
    )
    xena = _canonical(
        "gdc/gdc_expression.tsv", GdcExpressionAdapter(), tmp_path, "binding_b"
    )
    rows = _rows(xena.canonical_path)
    for row in rows:
        row["measurement_type"] = "alternate_measurement"
    header = list(rows[0].keys())
    with xena.canonical_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=header)
        writer.writeheader()
        writer.writerows(rows)
    result = integrate(
        results=[gdc, xena],
        merge_strategy="append_by_canonical_row",
        schema=build_gene_expression_schema(),
        build_id="build_test",
        output_dir=tmp_path,
    )
    assert result.row_count == 8  # no dedup: different measurement_type
    assert result.dedup_count == 0


def test_nan_mirror_rows_dedup_not_conflict(tmp_path: Path) -> None:
    """NaN mirrors are duplicates (not conflicts) — NaN equals NaN for dedup."""
    gdc = _canonical(
        "gdc/gdc_expression.tsv", GdcExpressionAdapter(), tmp_path, "binding_a"
    )
    xena = _canonical(
        "gdc/gdc_expression.tsv", GdcExpressionAdapter(), tmp_path, "binding_b"
    )
    rows = _rows(xena.canonical_path)
    for row in rows:
        if row["gene_id"] == "TP53" and row["sample_id"] == "S1":
            row["expression_value"] = "nan"
    header = list(rows[0].keys())
    with xena.canonical_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=header)
        writer.writeheader()
        writer.writerows(rows)
    # First source also carries NaN for the same identity.
    rows_gdc = _rows(gdc.canonical_path)
    for row in rows_gdc:
        if row["gene_id"] == "TP53" and row["sample_id"] == "S1":
            row["expression_value"] = "nan"
    with gdc.canonical_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=header)
        writer.writeheader()
        writer.writerows(rows_gdc)
    result = integrate(
        results=[gdc, xena],
        merge_strategy="append_by_canonical_row",
        schema=build_gene_expression_schema(),
        build_id="build_test",
        output_dir=tmp_path,
    )
    assert result.dedup_count == 4
    assert result.conflict_count == 0


def test_unsupported_merge_strategy_rejected(tmp_path: Path) -> None:
    gdc = _canonical(
        "gdc/gdc_expression.tsv", GdcExpressionAdapter(), tmp_path, "binding_gdc"
    )
    with pytest.raises(IntegratorError, match="unsupported merge strategy"):
        integrate(
            results=[gdc],
            merge_strategy="agent_injected_strategy",
            schema=build_gene_expression_schema(),
            build_id="build_test",
            output_dir=tmp_path,
        )


def test_zero_sources_rejected(tmp_path: Path) -> None:
    with pytest.raises(IntegratorError, match="zero sources"):
        integrate(
            results=[],
            merge_strategy="append_by_canonical_row",
            schema=build_gene_expression_schema(),
            build_id="build_test",
            output_dir=tmp_path,
        )
