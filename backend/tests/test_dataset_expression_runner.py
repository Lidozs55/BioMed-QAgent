"""ExpressionBuildRunner + DatasetBuildExecutor integration tests (Phase 3 P2).

The real operation runner splits the expression chain into per-operation
handlers so the Phase 2 execution kernel can execute and checkpoint the
whole skeleton (parse -> canonicalize -> compatibility gate -> integrate ->
validate profile -> publish) with the Phase 6 release invariants gate.
"""

from __future__ import annotations

import csv
import hashlib
import json
from pathlib import Path

import pytest
from app.datasets.build.expression_runner import ExpressionBuildRunner
from app.datasets.contracts import (
    AcquisitionMode,
    DatasetBuildSpec,
    SourceBinding,
    SourceBindingAcquisition,
)
from app.datasets.runtime import (
    DatasetBuildExecutor,
    build_operation_plan,
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


def _spec(bindings: list[SourceBinding], build_id: str = "build_runner_test") -> DatasetBuildSpec:
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


async def _run_executor(
    tmp_path: Path,
    bindings: list[SourceBinding],
    fixtures: dict[str, str],
    build_id: str = "build_runner_test",
) -> tuple[object, Path]:
    spec = _spec(bindings, build_id=build_id)
    registry = SchemaRegistry([build_gene_expression_schema()])
    assets = {
        binding_id: _source_asset(fixtures[binding_id], f"src_{binding_id}")
        for binding_id in fixtures
    }
    paths = {binding_id: FIXTURES / fixtures[binding_id] for binding_id in fixtures}
    output_dir = tmp_path / "build"
    runner = ExpressionBuildRunner(
        spec=spec,
        registry=registry,
        source_assets=assets,
        source_paths=paths,
        output_dir=output_dir,
    )
    plan = build_operation_plan(spec)
    executor = DatasetBuildExecutor(
        task_id="task_runner",
        build_id=spec.build_id,
        run_id="run_runner",
        state_dir=tmp_path / "state" / build_id,
        lock_path=tmp_path / "build.lock",
        task_root=tmp_path,
        plan=plan,
        run_operation=runner,
        implementation_versions={op.operation_id: "1.0.0" for op in plan},
    )
    outcome = await executor.run()
    return outcome, output_dir


def _primary_rows(output_dir: Path) -> list[dict[str, str]]:
    with (output_dir / "merged" / "primary.csv").open(encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


@pytest.mark.asyncio
async def test_runner_drives_full_build_single_source(tmp_path: Path) -> None:
    """A single GDC source completes the whole skeleton through publish."""
    outcome, output_dir = await _run_executor(
        tmp_path,
        [_binding("binding_gdc", "gdc", "gdc.expression.v1")],
        {"binding_gdc": "gdc/gdc_expression.tsv"},
    )
    assert outcome.status == "completed"
    assert outcome.error is None
    rows = _primary_rows(output_dir)
    assert len(rows) == 4
    assert {r["gene_id_namespace"] for r in rows} == {"ensembl_gene"}
    assert (output_dir / "dataset_manifest.json").is_file()
    assert (output_dir / "validation_report.json").is_file()
    assert (output_dir / "provenance.json").is_file()
    # Publish operation produced an immutable version directory.
    publish_dirs = list((output_dir / "publish").glob("build_runner_test_*"))
    assert len(publish_dirs) == 1
    assert (publish_dirs[0] / "dataset_manifest.json").is_file()


@pytest.mark.asyncio
async def test_runner_drives_compatible_two_source_merge(tmp_path: Path) -> None:
    """GDC + Xena compatible sources merge and validate end to end."""
    outcome, output_dir = await _run_executor(
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
    assert outcome.status == "completed"
    rows = _primary_rows(output_dir)
    assert len(rows) >= 4
    manifest = json.loads(
        (output_dir / "dataset_manifest.json").read_text("utf-8")
    )
    assert manifest["validation_summary"]["status"] == "passed"


@pytest.mark.asyncio
async def test_runner_records_operation_attempts(tmp_path: Path) -> None:
    """Every plan operation is recorded as a SUCCEEDED attempt."""
    outcome, _ = await _run_executor(
        tmp_path,
        [_binding("binding_gdc", "gdc", "gdc.expression.v1")],
        {"binding_gdc": "gdc/gdc_expression.tsv"},
    )
    assert outcome.status == "completed"
    assert len(outcome.completed_operation_ids) == 7  # acquire/parse/canon/compat/integrate/validate/publish


@pytest.mark.asyncio
async def test_runner_rerun_reuses_succeeded_attempts(tmp_path: Path) -> None:
    """A second run of the same build reuses prior SUCCEEDED attempts."""
    first, _ = await _run_executor(
        tmp_path,
        [_binding("binding_gdc", "gdc", "gdc.expression.v1")],
        {"binding_gdc": "gdc/gdc_expression.tsv"},
    )
    assert first.status == "completed"
    attempts_path = tmp_path / "state" / "build_runner_test" / "operation_attempts.jsonl"
    assert attempts_path.is_file()
    attempts = [json.loads(line) for line in attempts_path.read_text().splitlines()]
    assert all(a["status"] == "succeeded" for a in attempts)

    # Same inputs -> second run reuses (SKIPPED) attempts.
    second, _ = await _run_executor(
        tmp_path,
        [_binding("binding_gdc", "gdc", "gdc.expression.v1")],
        {"binding_gdc": "gdc/gdc_expression.tsv"},
    )
    assert second.status == "completed"
    attempts_after = [json.loads(line) for line in attempts_path.read_text().splitlines()]
    assert any(a["status"] == "skipped" for a in attempts_after)


@pytest.mark.asyncio
async def test_publish_supersedes_previous_version(tmp_path: Path) -> None:
    """A later build's publication supersedes the prior build's publication."""
    first, output_dir = await _run_executor(
        tmp_path,
        [_binding("binding_gdc", "gdc", "gdc.expression.v1")],
        {"binding_gdc": "gdc/gdc_expression.tsv"},
        build_id="build_v1",
    )
    assert first.status == "completed"
    second, _ = await _run_executor(
        tmp_path,
        [
            _binding("binding_gdc", "gdc", "gdc.expression.v1"),
            _binding("binding_xena", "ucsc_xena", "xena.matrix.v1"),
        ],
        {
            "binding_gdc": "gdc/gdc_expression.tsv",
            "binding_xena": "ncbi/gse178352/xena_matrix.tsv",
        },
        build_id="build_v2",
    )
    assert second.status == "completed"

    publications = [
        json.loads((d / "publication.json").read_text("utf-8"))
        for d in (output_dir / "publish").iterdir()
        if d.is_dir() and (d / "publication.json").is_file()
    ]
    publications.sort(key=lambda p: p["published_at"])
    assert len(publications) == 2
    first_pub, second_pub = publications
    assert first_pub["publication_id"] != second_pub["publication_id"]
    # The newest publication supersedes the prior one.
    assert second_pub["supersedes_publication_id"] == first_pub["publication_id"]
    assert first_pub["supersedes_publication_id"] is None


@pytest.mark.asyncio
async def test_manifest_carries_coverage_and_confidence(tmp_path: Path) -> None:
    """provenance coverage + confidence_summary land in the persisted manifest."""
    outcome, output_dir = await _run_executor(
        tmp_path,
        [_binding("binding_gdc", "gdc", "gdc.expression.v1")],
        {"binding_gdc": "gdc/gdc_expression.tsv"},
    )
    assert outcome.status == "completed"
    manifest = json.loads(
        (output_dir / "dataset_manifest.json").read_text("utf-8")
    )
    coverage = manifest["provenance_summary"]["coverage"]
    assert coverage["traced_rows"] == 4
    assert coverage["untraced_rows"] == 0
    assert coverage["coverage_ratio"] == 1.0
    assert manifest["confidence_summary"]["report_file"] == "confidence_report.csv"
