"""End-to-end demo chain tests (Phase 3 acceptance criteria).

- single GDC / single Xena / compatible GDC+Xena all produce a valid primary
  table with a role-based manifest;
- incompatible units are rejected with stable reason codes;
- provenance can be sampled back-traced;
- reruns are deterministic (same output digests).
"""

from __future__ import annotations

import csv
import hashlib
import json
from pathlib import Path

import pytest
from app.datasets.build.chain import build_expression_dataset
from app.datasets.build.errors import BuildError
from app.datasets.contracts import (
    AcquisitionMode,
    ArtifactRole,
    DatasetBuildSpec,
    SourceBinding,
    SourceBindingAcquisition,
)
from app.datasets.schema_registry import SchemaRegistry, build_gene_expression_schema
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


def _binding(binding_id: str, source: str, adapter_id: str) -> SourceBinding:
    return SourceBinding(
        binding_id=binding_id,
        source=source,
        acquisition=SourceBindingAcquisition(
            mode=AcquisitionMode.BUILTIN, provider_id=f"{source}.v1"
        ),
        adapter_id=adapter_id,
    )


def _spec(bindings: list[SourceBinding], merge_strategy: str = "append_by_canonical_row") -> DatasetBuildSpec:
    return DatasetBuildSpec(
        build_id="build_demo",
        objective="compare TP53 expression across sources",
        dataset_family="gene_expression",
        row_granularity="gene_sample_measurement",
        schema_ref="gene_expression.long.v1",
        source_bindings=bindings,
        merge_strategy=merge_strategy,
        validation_profile_ref="gene_expression.release.v1",
        normalization_profile_ref="gene_expression.normalization.v1",
    )


def _registry() -> SchemaRegistry:
    return SchemaRegistry([build_gene_expression_schema()])


def _run_chain(
    tmp_path: Path,
    bindings: list[SourceBinding],
    fixtures: dict[str, str],
) -> object:
    assets = {
        binding_id: _source_asset(fixtures[binding_id], f"src_{binding_id}")
        for binding_id, _ in [(b.binding_id, b) for b in bindings]
    }
    paths = {
        binding_id: FIXTURES / fixtures[binding_id]
        for binding_id in assets
    }
    return build_expression_dataset(
        spec=_spec(bindings),
        registry=_registry(),
        source_assets=assets,
        source_paths=paths,
        output_dir=tmp_path / "build",
    )


def _primary_rows(result) -> list[dict[str, str]]:
    with (result.output_dir / "merged" / "primary.csv").open(encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def test_single_gdc_build_succeeds(tmp_path: Path) -> None:
    result = _run_chain(
        tmp_path,
        [_binding("binding_gdc", "gdc", "gdc.expression.v1")],
        {"binding_gdc": "gdc/gdc_expression.tsv"},
    )
    assert result.status == "succeeded"
    assert result.reason_codes == ()
    assert result.validation.status.value == "passed"
    assert result.manifest is not None
    assert result.manifest.row_count == 4
    rows = _primary_rows(result)
    assert len(rows) == 4
    assert {r["gene_id_namespace"] for r in rows} == {"gene_symbol"}
    assert all(r["expression_unit"] == "expression_value" for r in rows)


def test_single_xena_build_succeeds(tmp_path: Path) -> None:
    result = _run_chain(
        tmp_path,
        [_binding("binding_xena", "ucsc_xena", "xena.matrix.v1")],
        {"binding_xena": "ncbi/gse178352/xena_matrix.tsv"},
    )
    assert result.status == "succeeded"
    assert result.manifest.row_count == 4


def test_compatible_gdc_xena_merge_succeeds(tmp_path: Path) -> None:
    result = _run_chain(
        tmp_path,
        [
            _binding("binding_gdc", "gdc", "gdc.expression.v1"),
            _binding("binding_xena", "ucsc_xena", "xena.matrix.v1"),
        ],
        {
            "binding_gdc": "gdc/gdc_expression.tsv",
            "binding_xena": "ncbi/gse178352/xena_matrix.tsv",
        },
    )
    assert result.status == "succeeded"
    # 3 mirror rows deduplicated, 1 conflict (TP53/S2) kept first-source.
    assert result.manifest.row_count == 4
    assert result.manifest.provenance_summary["dedup_count"] == 3
    assert result.manifest.provenance_summary["conflict_count"] == 1
    assert len(result.manifest.artifacts) >= 5  # primary + schema + provenance + audits
    roles = {entry.role for entry in result.manifest.artifacts}
    assert ArtifactRole.PRIMARY_DATASET in roles
    assert ArtifactRole.SCHEMA in roles
    assert ArtifactRole.PROVENANCE in roles
    assert ArtifactRole.AUDIT_REPORT in roles
    rows = _primary_rows(result)
    assert len(rows) == 4


def test_stale_outputs_cleared_on_rejection(tmp_path: Path) -> None:
    """A rejected rerun into the same output_dir must not leak prior artifacts."""
    output_dir = tmp_path / "build"
    first = _run_chain(
        tmp_path,
        [_binding("binding_gdc", "gdc", "gdc.expression.v1")],
        {"binding_gdc": "gdc/gdc_expression.tsv"},
    )
    assert first.status == "succeeded"
    assert (output_dir / "merged" / "primary.csv").is_file()
    assert (output_dir / "dataset_manifest.json").is_file()

    # Same workspace, incompatible pair -> rejection must clear the workspace.
    rejected = build_expression_dataset(
        spec=_spec(
            [
                _binding("binding_matrix", "gdc", "gdc.expression.v1"),
                _binding("binding_star", "gdc", "gdc.expression.v1"),
            ]
        ),
        registry=_registry(),
        source_assets={
            "binding_matrix": _source_asset("gdc/gdc_expression.tsv", "src_m"),
            "binding_star": _source_asset("gdc/gdc_star_counts.tsv", "src_s"),
        },
        source_paths={
            "binding_matrix": FIXTURES / "gdc/gdc_expression.tsv",
            "binding_star": FIXTURES / "gdc/gdc_star_counts.tsv",
        },
        output_dir=output_dir,
    )
    assert rejected.status == "rejected"
    assert not (output_dir / "merged" / "primary.csv").exists()
    assert not (output_dir / "dataset_manifest.json").exists()


def test_zero_row_source_rejected(tmp_path: Path) -> None:
    """A source that canonicalizes to zero rows must not silently vanish."""
    probe_matrix = tmp_path / "probe_matrix.tsv"
    probe_matrix.write_text(
        "gene_id\tS1\n1007_s_at\t1.5\n1053_at\t2.5\n", encoding="utf-8"
    )
    probe_checksum = hashlib.sha256(probe_matrix.read_bytes()).hexdigest()
    probe_asset = SourceAsset(
        asset_id=asset_id_from_sha256(probe_checksum),
        kind="source",
        relative_path="source_assets/probe_matrix.tsv",
        sha256=probe_checksum,
        size_bytes=probe_matrix.stat().st_size,
        media_type="text/tab-separated-values",
        source_id="src_probe",
        successful_attempt_id="attempt_1",
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )
    healthy = _source_asset("gdc/gdc_expression.tsv", "src_healthy")
    result = build_expression_dataset(
        spec=_spec(
            [
                _binding("binding_healthy", "gdc", "gdc.expression.v1"),
                _binding("binding_probe", "gdc", "gdc.expression.v1"),
            ]
        ),
        registry=_registry(),
        source_assets={
            "binding_healthy": healthy,
            "binding_probe": probe_asset,
        },
        source_paths={
            "binding_healthy": FIXTURES / "gdc/gdc_expression.tsv",
            "binding_probe": probe_matrix,
        },
        output_dir=tmp_path / "build",
    )
    assert result.status == "rejected"
    assert "source_yielded_no_rows" in result.reason_codes
    assert result.manifest is None


def test_missing_binding_raises_build_error(tmp_path: Path) -> None:
    spec = _spec([_binding("binding_gdc", "gdc", "gdc.expression.v1")])
    with pytest.raises(BuildError, match="no source asset supplied"):
        build_expression_dataset(
            spec=spec,
            registry=_registry(),
            source_assets={},
            source_paths={},
            output_dir=tmp_path / "build",
        )


def test_incompatible_units_rejected(tmp_path: Path) -> None:
    # GDC matrix (expression_value) + GDC STAR counts (tpm_unstranded).
    result = _run_chain(
        tmp_path,
        [
            _binding("binding_matrix", "gdc", "gdc.expression.v1"),
            _binding("binding_star", "gdc", "gdc.expression.v1"),
        ],
        {
            "binding_matrix": "gdc/gdc_expression.tsv",
            "binding_star": "gdc/gdc_star_counts.tsv",
        },
    )
    assert result.status == "rejected"
    assert "measurement_identity_mismatch" in result.reason_codes
    assert result.manifest is None
    assert not (result.output_dir / "merged" / "primary.csv").exists()


def test_provenance_sample_backtrace(tmp_path: Path) -> None:
    result = _run_chain(
        tmp_path,
        [_binding("binding_gdc", "gdc", "gdc.expression.v1")],
        {"binding_gdc": "gdc/gdc_expression.tsv"},
    )
    provenance = json.loads((result.output_dir / "provenance.json").read_text())
    assert provenance["schema_ref"] == "gene_expression.long.v1"
    assert provenance["sources"][0]["asset_id"].startswith("asset_")
    backtrace = provenance["sample_backtraces"][0]
    assert backtrace["gene_id"] == "TP53"
    assert backtrace["source_logical_file"] == "gdc_expression.tsv"
    assert backtrace["source_line_number"] == "2"
    assert backtrace["transforms"][0]["output"] == "TP53"


def test_rerun_is_deterministic(tmp_path: Path) -> None:
    first = _run_chain(
        tmp_path,
        [_binding("binding_gdc", "gdc", "gdc.expression.v1")],
        {"binding_gdc": "gdc/gdc_expression.tsv"},
    )
    second = _run_chain(
        tmp_path,
        [_binding("binding_gdc", "gdc", "gdc.expression.v1")],
        {"binding_gdc": "gdc/gdc_expression.tsv"},
    )
    assert first.manifest.sha256 == second.manifest.sha256
    assert (
        first.manifest.artifacts[0].sha256 == second.manifest.artifacts[0].sha256
    )


def test_unknown_adapter_execution_failure(tmp_path: Path) -> None:
    spec = _spec([_binding("binding_geo", "geo", "geo.probe.v1")])
    assets = {"binding_geo": _source_asset("gdc/gdc_expression.tsv", "src_geo")}
    paths = {"binding_geo": FIXTURES / "gdc/gdc_expression.tsv"}
    with pytest.raises(BuildError, match="unknown source adapter"):
        build_expression_dataset(
            spec=spec,
            registry=_registry(),
            source_assets=assets,
            source_paths=paths,
            output_dir=tmp_path / "build",
        )
