"""DatasetManifest V2 tests: role inventory, digest determinism."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from app.datasets.build.adapters import GdcExpressionAdapter, XenaMatrixAdapter
from app.datasets.build.canonicalizer import canonicalize
from app.datasets.build.integrator import integrate
from app.datasets.build.manifest import (
    MANIFEST_FILE,
    PROVENANCE_FILE,
    SCHEMA_FILE,
    build_manifest,
    build_provenance_document,
    package_digest,
)
from app.datasets.build.profiles import _expression_normalization_v1
from app.datasets.contracts import (
    ArtifactRole,
    DatasetBuildSpec,
    ValidationResult,
    ValidationResultStatus,
)
from app.datasets.schema_registry import build_gene_expression_schema
from app.domain.contracts import DataLevel, SourceAsset, asset_id_from_sha256

FIXTURES = Path(__file__).parent / "fixtures"


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


def _spec() -> DatasetBuildSpec:
    from app.datasets.contracts import (
        AcquisitionMode,
        SourceBinding,
        SourceBindingAcquisition,
    )

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
            )
        ],
        validation_profile_ref="gene_expression.release.v1",
    )


def _validation(status: ValidationResultStatus = ValidationResultStatus.PASSED) -> ValidationResult:
    return ValidationResult(
        manifest_digest="a" * 64,
        profile_ref="gene_expression.release.v1",
        status=status,
        checked_count=5,
        failed_count=0 if status is ValidationResultStatus.PASSED else 1,
        report_path="validation_report.json",
    )


def _build_chain(tmp_path: Path):
    """Run adapter -> canonicalize -> integrate for GDC+Xena mirror fixtures."""
    schema = build_gene_expression_schema()
    profile = _expression_normalization_v1()
    assets = {
        "binding_gdc": _source_asset("gdc/gdc_expression.tsv", "src_gdc"),
        "binding_xena": _source_asset(
            "ncbi/gse178352/xena_matrix.tsv", "src_xena"
        ),
    }
    results = []
    for binding_id, asset in assets.items():
        adapter = GdcExpressionAdapter() if binding_id == "binding_gdc" else XenaMatrixAdapter()
        batch = adapter.parse(
            asset,
            FIXTURES / (
                "gdc/gdc_expression.tsv"
                if binding_id == "binding_gdc"
                else "ncbi/gse178352/xena_matrix.tsv"
            ),
            build_id="build_test",
            binding_id=binding_id,
            schema_ref="gene_expression.long.v1",
            output_dir=tmp_path,
        )
        results.append(
            canonicalize(batch=batch, schema=schema, profile=profile, output_dir=tmp_path)
        )
    integration = integrate(
        results=results,
        merge_strategy="append_by_canonical_row",
        schema=schema,
        build_id="build_test",
        output_dir=tmp_path,
    )
    return schema, results, integration, assets


def test_manifest_role_inventory(tmp_path: Path) -> None:
    schema, results, integration, assets = _build_chain(tmp_path)
    provenance = build_provenance_document(
        schema=schema,
        integration=integration,
        canonical_results=results,
        source_assets=assets,
        output_dir=tmp_path,
    )
    audit_paths = [
        path
        for result in results
        for path in result.audit_paths
        if path.exists()
    ]
    manifest = build_manifest(
        task_id="task_test",
        build_id="build_test",
        spec=_spec(),
        schema=schema,
        integration=integration,
        canonical_results=results,
        provenance_path=provenance,
        audit_paths=audit_paths,
        validation=_validation(),
        source_summary={"binding_gdc": {"row_count": 4}, "binding_xena": {"row_count": 4}},
        output_dir=tmp_path,
    )
    roles = {entry.role for entry in manifest.artifacts}
    assert ArtifactRole.PRIMARY_DATASET in roles
    assert ArtifactRole.SCHEMA in roles
    assert ArtifactRole.PROVENANCE in roles
    assert ArtifactRole.AUDIT_REPORT in roles
    primaries = [
        entry for entry in manifest.artifacts
        if entry.role is ArtifactRole.PRIMARY_DATASET
    ]
    assert len(primaries) == 1
    assert primaries[0].relative_path == "merged/primary.csv"
    assert manifest.row_count == 4  # 3 mirror rows deduped, 1 conflict kept first
    assert manifest.provenance_summary["dedup_count"] == 3
    assert manifest.provenance_summary["conflict_count"] == 1
    assert (tmp_path / MANIFEST_FILE).is_file()
    assert (tmp_path / SCHEMA_FILE).is_file()
    assert (tmp_path / PROVENANCE_FILE).is_file()
    loaded = json.loads((tmp_path / MANIFEST_FILE).read_text())
    assert loaded["sha256"] == manifest.sha256
    assert loaded["validation_summary"]["status"] == "passed"


def test_manifest_digest_is_deterministic(tmp_path: Path) -> None:
    schema, results, integration, assets = _build_chain(tmp_path)
    provenance = build_provenance_document(
        schema=schema,
        integration=integration,
        canonical_results=results,
        source_assets=assets,
        output_dir=tmp_path,
    )
    audit_paths = [
        path for result in results for path in result.audit_paths if path.exists()
    ]
    first = build_manifest(
        task_id="task_test",
        build_id="build_test",
        spec=_spec(),
        schema=schema,
        integration=integration,
        canonical_results=results,
        provenance_path=provenance,
        audit_paths=audit_paths,
        validation=_validation(),
        source_summary={},
        output_dir=tmp_path,
    )
    # Rebuild in a fresh directory: identical artifact contents -> same digest.
    fresh = tmp_path / "fresh"
    fresh.mkdir()
    schema2, results2, integration2, assets2 = _build_chain(fresh)
    provenance2 = build_provenance_document(
        schema=schema2,
        integration=integration2,
        canonical_results=results2,
        source_assets=assets2,
        output_dir=fresh,
    )
    audit_paths2 = [
        path for result in results2 for path in result.audit_paths if path.exists()
    ]
    second = build_manifest(
        task_id="task_test",
        build_id="build_test",
        spec=_spec(),
        schema=schema2,
        integration=integration2,
        canonical_results=results2,
        provenance_path=provenance2,
        audit_paths=audit_paths2,
        validation=_validation(),
        source_summary={},
        output_dir=fresh,
    )
    assert first.sha256 == second.sha256
    assert first.manifest_id == second.manifest_id


def test_package_digest_sorted_and_stable() -> None:
    from app.datasets.contracts import ManifestArtifactEntry

    entries = [
        ManifestArtifactEntry(
            artifact_id="a2", role=ArtifactRole.AUDIT_REPORT,
            relative_path="z.csv", media_type="text/csv",
            size_bytes=1, sha256="2" * 64,
        ),
        ManifestArtifactEntry(
            artifact_id="a1", role=ArtifactRole.PRIMARY_DATASET,
            relative_path="a.csv", media_type="text/csv",
            size_bytes=1, sha256="1" * 64,
        ),
    ]
    assert package_digest(entries) == package_digest(list(reversed(entries)))


def test_provenance_document_backtraces(tmp_path: Path) -> None:
    schema, results, integration, assets = _build_chain(tmp_path)
    provenance = build_provenance_document(
        schema=schema,
        integration=integration,
        canonical_results=results,
        source_assets=assets,
        output_dir=tmp_path,
    )
    document = json.loads(provenance.read_text())
    assert document["schema_ref"] == "gene_expression.long.v1"
    assert len(document["sources"]) == 2
    assert document["sources"][0]["asset_id"].startswith("asset_")
    assert document["sample_backtraces"][0]["gene_id"] == "TP53"
    assert document["sample_backtraces"][0]["transforms"][0]["transform"] == (
        "namespace_authorize"
    )
    assert len(document["field_mappings"]) > 0


def test_compute_provenance_coverage(tmp_path: Path) -> None:
    """Coverage counts traced vs untraced primary rows."""
    from app.datasets.build.manifest import compute_provenance_coverage

    primary = tmp_path / "primary.csv"
    primary.write_text(
        "gene_id,sample_id,asset_id,expression_value\n"
        "TP53,S1,asset_traced1,1.5\n"
        "BRCA1,S2,asset_traced2,2.5\n"
        "TP53,S3,,3.5\n"
        "TP53,S4,asset_unknown,4.5\n",
        "utf-8",
    )
    coverage = compute_provenance_coverage(
        primary, {"asset_traced1", "asset_traced2"}
    )
    assert coverage["traced_rows"] == 2
    assert coverage["untraced_rows"] == 2
    assert coverage["coverage_ratio"] == 0.5


def test_build_confidence_summary_from_report(tmp_path: Path) -> None:
    """confidence_summary counts detector anomalies from confidence_report.csv."""
    from app.datasets.build.manifest import build_confidence_summary

    (tmp_path / "confidence_report.csv").write_text(
        "column,detector,applicable,statistic,anomaly,detail\n"
        "expression_value,constant_column,true,,true,all values identical\n"
        "expression_value,arithmetic_progression,true,,false,no sequence\n",
        "utf-8",
    )
    summary = build_confidence_summary(tmp_path)
    assert summary["detected_anomaly_count"] == 1
    assert summary["report_file"] == "confidence_report.csv"


def test_build_confidence_summary_missing_report(tmp_path: Path) -> None:
    """No confidence report -> empty summary."""
    from app.datasets.build.manifest import build_confidence_summary

    assert build_confidence_summary(tmp_path) == {}


def test_artifact_id_includes_relative_path(tmp_path: Path) -> None:
    """C3a: identical bytes at two relative paths must not collide.

    Content-addressed ids previously hashed only the file bytes, so two
    artifacts with the same content produced the same ``artifact_`` id even
    though they live at different relative paths. The id digest now includes
    the relative path, keeping the wire shape (``artifact_`` + 32 hex).
    """

    from app.datasets.build.manifest import _entry

    (tmp_path / "a").mkdir()
    (tmp_path / "b").mkdir()
    first = tmp_path / "a" / "dup.csv"
    second = tmp_path / "b" / "dup.csv"
    first.write_bytes(b"identical bytes\n")
    second.write_bytes(b"identical bytes\n")

    first_entry = _entry(ArtifactRole.AUDIT_REPORT, first, tmp_path)
    second_entry = _entry(ArtifactRole.AUDIT_REPORT, second, tmp_path)

    assert first_entry.relative_path == "a/dup.csv"
    assert second_entry.relative_path == "b/dup.csv"
    assert first_entry.sha256 == second_entry.sha256
    assert first_entry.artifact_id != second_entry.artifact_id
    assert first_entry.artifact_id.startswith("artifact_")
    assert len(first_entry.artifact_id) == len("artifact_") + 32


def test_artifact_id_stable_for_same_relative_path(tmp_path: Path) -> None:
    """The id is deterministic: same path + same bytes → same id."""

    from app.datasets.build.manifest import _entry

    (tmp_path / "a").mkdir()
    path = tmp_path / "a" / "dup.csv"
    path.write_bytes(b"identical bytes\n")

    first_entry = _entry(ArtifactRole.AUDIT_REPORT, path, tmp_path)
    second_entry = _entry(ArtifactRole.AUDIT_REPORT, path, tmp_path)

    assert first_entry.artifact_id == second_entry.artifact_id
