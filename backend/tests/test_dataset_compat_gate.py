"""Compatibility gate tests: compatible merge, unit/scale/namespace rejection."""

from __future__ import annotations

import hashlib
from dataclasses import replace
from pathlib import Path

from app.datasets.build.adapters import GdcExpressionAdapter, XenaMatrixAdapter
from app.datasets.build.canonicalizer import canonicalize
from app.datasets.build.compat_gate import check_expression_compatibility
from app.datasets.build.profiles import _expression_normalization_v1
from app.datasets.contracts import (
    AcquisitionMode,
    DatasetBuildSpec,
    SourceBinding,
    SourceBindingAcquisition,
)
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


def _spec() -> DatasetBuildSpec:
    return DatasetBuildSpec(
        build_id="build_test",
        objective="compare TP53 expression",
        dataset_family="gene_expression",
        row_granularity="gene_sample_measurement",
        schema_ref="gene_expression.long.v1",
        source_bindings=[
            SourceBinding(
                binding_id="binding_gdc",
                source="gdc",
                acquisition=SourceBindingAcquisition(
                    mode=AcquisitionMode.BUILTIN, provider_id="gdc.files.v1"
                ),
                adapter_id="gdc.expression.v1",
            ),
            SourceBinding(
                binding_id="binding_xena",
                source="ucsc_xena",
                acquisition=SourceBindingAcquisition(
                    mode=AcquisitionMode.BUILTIN, provider_id="xena.v1"
                ),
                adapter_id="xena.matrix.v1",
            ),
        ],
        validation_profile_ref="gene_expression.release.v1",
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


def test_compatible_gdc_xena_merge_passes(tmp_path: Path) -> None:
    gdc = _canonical(
        "gdc/gdc_expression.tsv", GdcExpressionAdapter(), tmp_path, "binding_gdc"
    )
    xena = _canonical(
        "ncbi/gse178352/xena_matrix.tsv", XenaMatrixAdapter(), tmp_path, "binding_xena"
    )
    report = check_expression_compatibility(spec=_spec(), results=[gdc, xena])
    assert report.compatible is True
    assert report.reasons == ()


def test_single_source_passes(tmp_path: Path) -> None:
    gdc = _canonical(
        "gdc/gdc_expression.tsv", GdcExpressionAdapter(), tmp_path, "binding_gdc"
    )
    report = check_expression_compatibility(spec=_spec(), results=[gdc])
    assert report.compatible is True


def test_unit_mismatch_rejected(tmp_path: Path) -> None:
    # GDC matrix is generic expression_value; STAR counts are tpm_unstranded.
    matrix = _canonical(
        "gdc/gdc_expression.tsv", GdcExpressionAdapter(), tmp_path, "binding_matrix"
    )
    star = _canonical(
        "gdc/gdc_star_counts.tsv", GdcExpressionAdapter(), tmp_path, "binding_star"
    )
    report = check_expression_compatibility(spec=_spec(), results=[matrix, star])
    assert report.compatible is False
    assert "measurement_identity_mismatch" in report.reasons


def test_namespace_mismatch_rejected(tmp_path: Path) -> None:
    # Xena fixture is gene_symbol-keyed; GDC STAR is ensembl_gene-keyed.
    xena = _canonical(
        "ncbi/gse178352/xena_matrix.tsv", XenaMatrixAdapter(), tmp_path, "binding_xena"
    )
    star = _canonical(
        "gdc/gdc_star_counts.tsv", GdcExpressionAdapter(), tmp_path, "binding_star"
    )
    report = check_expression_compatibility(spec=_spec(), results=[xena, star])
    assert report.compatible is False
    assert "namespace_mismatch" in report.reasons


def test_family_mismatch_rejected(tmp_path: Path) -> None:
    gdc = _canonical(
        "gdc/gdc_expression.tsv", GdcExpressionAdapter(), tmp_path, "binding_gdc"
    )
    mismatched = replace(gdc, batch=gdc.batch.model_copy(update={"dataset_family": "pathway_member"}))
    report = check_expression_compatibility(spec=_spec(), results=[mismatched])
    assert report.compatible is False
    assert "family_mismatch" in report.reasons


def test_missing_mapping_evidence_rejected(tmp_path: Path) -> None:
    gdc = _canonical(
        "gdc/gdc_expression.tsv", GdcExpressionAdapter(), tmp_path, "binding_gdc"
    )
    no_evidence = replace(
        gdc,
        batch=gdc.batch.model_copy(update={"declared_mappings": []}),
    )
    report = check_expression_compatibility(spec=_spec(), results=[no_evidence])
    assert report.compatible is False
    assert "missing_mapping_evidence" in report.reasons


def test_schema_mismatch_rejected(tmp_path: Path) -> None:
    gdc = _canonical(
        "gdc/gdc_expression.tsv", GdcExpressionAdapter(), tmp_path, "binding_gdc"
    )
    mismatched = replace(
        gdc,
        batch=gdc.batch.model_copy(update={"schema_ref": "pathway_member.v1"}),
    )
    report = check_expression_compatibility(spec=_spec(), results=[mismatched])
    assert report.compatible is False
    assert "schema_mismatch" in report.reasons
