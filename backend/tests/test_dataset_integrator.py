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
    # Same fixture content in both sources: 4 mirror rows deduplicated.
    assert result.row_count == 4
    assert result.dedup_count == 4
    assert result.conflict_count == 0
    assert result.batch.statistics["dedup_count"] == 4


def test_value_conflict_audited(tmp_path: Path) -> None:
    gdc = _canonical(
        "gdc/gdc_expression.tsv", GdcExpressionAdapter(), tmp_path, "binding_gdc"
    )
    xena = _canonical(
        "ncbi/gse178352/xena_matrix.tsv", XenaMatrixAdapter(), tmp_path, "binding_xena"
    )
    # Tweak the xena canonical file so TP53/S1 differs from the gdc value.
    rows = _rows(xena.canonical_path)
    for row in rows:
        if row["gene_id"] == "TP53" and row["sample_id"] == "S1":
            row["expression_value"] = "9.9"
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
    assert result.row_count == 4  # first source value kept
    assert result.dedup_count == 3
    assert result.conflict_count == 1
    conflicts = _rows(result.conflicts_path)
    assert conflicts[0]["gene_id"] == "TP53"
    assert conflicts[0]["first_value"] == "1.5"
    assert conflicts[0]["second_value"] == "9.9"
    assert conflicts[0]["action"] == "kept_first_source"
    merged = _rows(result.merged_path)
    tp53_s1 = next(
        r for r in merged if r["gene_id"] == "TP53" and r["sample_id"] == "S1"
    )
    assert tp53_s1["expression_value"] == "1.5"


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
