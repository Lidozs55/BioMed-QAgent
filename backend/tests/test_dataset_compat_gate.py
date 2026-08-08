"""Compatibility gate tests: compatible merge, unit/scale/namespace rejection."""

from __future__ import annotations

import hashlib
from dataclasses import replace
from pathlib import Path

from app.datasets.build.adapters import (
    GdcExpressionAdapter,
    GeoExpressionAdapter,
    XenaMatrixAdapter,
)
from app.datasets.build.canonicalizer import CanonicalizationResult, canonicalize
from app.datasets.build.compat_gate import check_expression_compatibility
from app.datasets.build.profiles import _expression_normalization_v1
from app.datasets.contracts import (
    AcquisitionMode,
    AdapterParams,
    DataBatch,
    DatasetBuildSpec,
    SourceBinding,
    SourceBindingAcquisition,
    ValueScale,
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


def _source_asset_for_path(path: Path) -> SourceAsset:
    checksum = hashlib.sha256(path.read_bytes()).hexdigest()
    return SourceAsset(
        asset_id=asset_id_from_sha256(checksum),
        kind="source",
        relative_path=f"source_assets/{path.name}",
        sha256=checksum,
        size_bytes=path.stat().st_size,
        media_type="text/tab-separated-values",
        source_id="src_geo",
        successful_attempt_id="attempt_1",
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )


#: Minimal GEO series-matrix expression block (probe-keyed ID_REF rows).
_SERIES_MATRIX = (
    "!Series_title = \"Test series\"\n"
    "!series_matrix_table_begin\n"
    "\"ID_REF\"\t\"GSM1\"\t\"GSM2\"\n"
    "\"AFFX-BioB-5\"\t1.5\t2.0\n"
    "\"1007_s_at\"\t3.0\t4.0\n"
    "!series_matrix_table_end\n"
)


def _probe_spec() -> DatasetBuildSpec:
    """Probe-level build spec (D2: ``gene_expression.probe_long.v1`` contract)."""
    return DatasetBuildSpec(
        build_id="build_test",
        objective="compare probe expression",
        dataset_family="gene_expression",
        row_granularity="probe_sample_measurement",
        schema_ref="gene_expression.probe_long.v1",
        source_bindings=[
            SourceBinding(
                binding_id="binding_geo",
                source="geo",
                acquisition=SourceBindingAcquisition(
                    mode=AcquisitionMode.BUILTIN, provider_id="geo.series.v1"
                ),
                adapter_id="geo.expression.v1",
            ),
        ],
        validation_profile_ref="gene_expression.probe_release.v1",
    )


def _probe_canonical(
    tmp_path: Path,
    *,
    binding_id: str,
    scale: str = "log2",
    semantics: str = "normalized_expression",
    unit: str = "log2_expression",
    namespaces: tuple[str, ...] = ("geo_probe",),
    row_count: int | None = None,
) -> CanonicalizationResult:
    """Parse a probe-level GEO series matrix and wrap it as a canonical result.

    The canonicalizer cannot consume the probe schema yet (probe→gene mapping
    canonicalization is T7), so the canonical statistics the gate reads are
    recorded here exactly as the canonicalizer would: per-row measurement
    identities and the observed gene-id namespaces.
    """
    matrix = tmp_path / f"{binding_id}_series_matrix.txt"
    matrix.write_text(_SERIES_MATRIX, encoding="utf-8")
    params = AdapterParams(
        format="series_matrix",
        value_semantics=semantics,
        value_scale=ValueScale(scale),
        expression_unit=unit,
        platform_ids=["GPL570"],
    )
    batch = GeoExpressionAdapter().parse(
        _source_asset_for_path(matrix),
        matrix,
        build_id="build_test",
        binding_id=binding_id,
        schema_ref="gene_expression.probe_long.v1",
        output_dir=tmp_path,
        parameters=params,
    )
    statistics = dict(batch.statistics)
    statistics["gene_id_namespaces"] = sorted(namespaces)
    statistics["measurement_identities"] = [
        [semantics, scale, unit] for _ in range(batch.row_count)
    ]
    canonical_batch: DataBatch = batch.model_copy(update={"statistics": statistics})
    return CanonicalizationResult(
        batch=canonical_batch,
        canonical_path=tmp_path / f"{binding_id}_canonical.csv",
        row_count=batch.row_count if row_count is None else row_count,
        rejected_count=0,
        namespaces=namespaces,
        audit_paths=(),
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


# ---------------------------------------------------------------------------
# Phase 5 T5: D4 gate matrix (spec §4 D4 — every row)
# ---------------------------------------------------------------------------


def test_unknown_scale_cross_source_merge_rejected(tmp_path: Path) -> None:
    """D4: unknown×unknown cross-source never merges.

    Two sources declaring the same *unknown* scale share a single identity,
    which the gate alone cannot prove equivalent — merging requires a
    server-owned evidence-backed normalization rule (Phase 5 registers none).
    """
    first = _probe_canonical(
        tmp_path, binding_id="binding_geo_a", scale="unknown"
    )
    second = _probe_canonical(
        tmp_path, binding_id="binding_geo_b", scale="unknown"
    )
    report = check_expression_compatibility(
        spec=_probe_spec(), results=[first, second]
    )
    assert report.compatible is False
    assert "measurement_identity_mismatch" in report.reasons


def test_unknown_scale_single_source_passes(tmp_path: Path) -> None:
    """D4: a single source with an honest unknown scale remains publishable."""
    only = _probe_canonical(tmp_path, binding_id="binding_geo_a", scale="unknown")
    report = check_expression_compatibility(spec=_probe_spec(), results=[only])
    assert report.compatible is True
    assert report.reasons == ()


def test_log2_vs_linear_identity_mismatch(tmp_path: Path) -> None:
    """D4: log2 vs linear (or any semantics/unit divergence) blocks the merge."""
    log2_source = _probe_canonical(
        tmp_path, binding_id="binding_geo_a", scale="log2"
    )
    linear_source = _probe_canonical(
        tmp_path, binding_id="binding_geo_b", scale="linear"
    )
    report = check_expression_compatibility(
        spec=_probe_spec(), results=[log2_source, linear_source]
    )
    assert report.compatible is False
    assert "measurement_identity_mismatch" in report.reasons


def test_known_and_unknown_scale_cross_source_rejected(tmp_path: Path) -> None:
    """D4: known × unknown also fails — the gate needs both sides provable."""
    known = _probe_canonical(tmp_path, binding_id="binding_geo_a", scale="log2")
    unknown = _probe_canonical(
        tmp_path, binding_id="binding_geo_b", scale="unknown"
    )
    report = check_expression_compatibility(
        spec=_probe_spec(), results=[known, unknown]
    )
    assert report.compatible is False
    assert "measurement_identity_mismatch" in report.reasons


def test_probe_and_gene_schema_sources_rejected(tmp_path: Path) -> None:
    """D2/D4: a probe-schema source never merges with a gene-schema source."""
    probe = _probe_canonical(tmp_path, binding_id="binding_probe")
    gene = _canonical(
        "gdc/gdc_expression.tsv", GdcExpressionAdapter(), tmp_path, "binding_gene"
    )
    report = check_expression_compatibility(spec=_spec(), results=[probe, gene])
    assert report.compatible is False
    assert "schema_mismatch" in report.reasons
    assert "granularity_mismatch" in report.reasons


def test_probe_level_build_mixed_namespace_sources_rejected(
    tmp_path: Path,
) -> None:
    """D2: a probe-level build cannot merge probe rows with gene rows."""
    probe_rows = _probe_canonical(
        tmp_path, binding_id="binding_geo_a", namespaces=("geo_probe",)
    )
    gene_rows = _probe_canonical(
        tmp_path, binding_id="binding_geo_b", namespaces=("ensembl_gene",)
    )
    report = check_expression_compatibility(
        spec=_probe_spec(), results=[probe_rows, gene_rows]
    )
    assert report.compatible is False
    assert "namespace_mismatch" in report.reasons


def test_probe_level_two_probe_sources_compatible(tmp_path: Path) -> None:
    """D4: probe×probe with an identical known identity passes the gate."""
    first = _probe_canonical(tmp_path, binding_id="binding_geo_a", scale="log2")
    second = _probe_canonical(tmp_path, binding_id="binding_geo_b", scale="log2")
    report = check_expression_compatibility(
        spec=_probe_spec(), results=[first, second]
    )
    assert report.compatible is True
    assert report.reasons == ()


def test_empty_source_does_not_forge_identity(tmp_path: Path) -> None:
    """D4: an empty source contributes no identity to a cross-source merge."""
    empty = _probe_canonical(
        tmp_path, binding_id="binding_geo_empty", scale="unknown", row_count=0
    )
    non_empty = _probe_canonical(
        tmp_path, binding_id="binding_geo_real", scale="log2"
    )
    report = check_expression_compatibility(
        spec=_probe_spec(), results=[empty, non_empty]
    )
    assert report.compatible is True
    assert "measurement_identity_mismatch" not in report.reasons


def test_no_results_reports_no_sources(tmp_path: Path) -> None:
    """D4: no sources at all → ``no_sources``; nothing reaches the integrator."""
    report = check_expression_compatibility(spec=_probe_spec(), results=[])
    assert report.compatible is False
    assert report.reasons == ("no_sources",)


def test_all_empty_sources_never_fabricate_identity(tmp_path: Path) -> None:
    """D4: every source empty → typed NO_DATA, never a fake merge.

    The gate performs no identity/namespace checks for empty sources (nothing
    is compared, nothing is fabricated); the chain (``source_yielded_no_rows``)
    and the runner's validation-failure NO_DATA path own the typed NO_DATA
    outcome the D4 matrix assigns to this row.
    """
    first = _probe_canonical(tmp_path, binding_id="binding_geo_a", row_count=0)
    second = _probe_canonical(tmp_path, binding_id="binding_geo_b", row_count=0)
    report = check_expression_compatibility(
        spec=_probe_spec(), results=[first, second]
    )
    assert "measurement_identity_mismatch" not in report.reasons
    assert "namespace_mismatch" not in report.reasons


def test_v1_pipeline_allowlist_unchanged() -> None:
    """T5: the V1 deterministic-pipeline allowlist is untouched by GEO V2 work."""
    from app.domain.contracts import Database
    from app.domain.contracts.enums import SUPPORTED_PIPELINE_SOURCE_COMBINATIONS

    expected = {
        frozenset({Database.GEO}),
        frozenset({Database.PUBMED, Database.GEO}),
        frozenset({Database.GDC}),
        frozenset({Database.UCSC_XENA}),
        frozenset({Database.GDC, Database.UCSC_XENA}),
        frozenset({Database.REACTOME}),
    }
    assert expected == SUPPORTED_PIPELINE_SOURCE_COMBINATIONS
    # GEO never merges with GDC/Xena in the deterministic pipeline (the D4
    # gate is the only cross-source GEO path, and it is V2-only).
    assert frozenset({Database.GEO, Database.GDC}) not in (
        SUPPORTED_PIPELINE_SOURCE_COMBINATIONS
    )
    assert frozenset({Database.GEO, Database.UCSC_XENA}) not in (
        SUPPORTED_PIPELINE_SOURCE_COMBINATIONS
    )
