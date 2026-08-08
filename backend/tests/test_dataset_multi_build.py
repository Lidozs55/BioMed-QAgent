"""Phase 5 T6 red tests: MultiBuildOrchestrator (D6).

The orchestrator must:
* take ``list[DatasetBuildSpec]`` and return ``MultiBuildResult`` of
  ``BuildExecutionSummary`` (build_id / status / BuildResult /
  publication_id / audit summary — no BuildOutcome concept);
* execute builds sequentially with FAILURE ISOLATION — one build failing or
  yielding NO_DATA must not roll back or pollute the others;
* ASSERT no cross-build supersede between distinct builds' publications.

The two fixture builds use copy-dir source fixtures (no live network); each
build is an independent GSE-style build with its own output/state directory.
"""

from __future__ import annotations

import asyncio
import json
import shutil
from pathlib import Path

import pytest
from app.datasets.build.expression_runner import ExpressionBuildRunner
from app.datasets.build.multi_build import (
    BuildExecutionSummary,
    MultiBuildOrchestrator,
    MultiBuildResult,
)
from app.datasets.contracts import (
    AcquisitionMode,
    DatasetBuildSpec,
    SourceBinding,
    SourceBindingAcquisition,
)
from app.datasets.runtime import DatasetBuildExecutor, build_operation_plan
from app.datasets.schema_registry import SchemaRegistry, build_gene_expression_schema
from app.domain.contracts import DataLevel, SourceAsset, asset_id_from_sha256
from app.domain.contracts.dataset_state import BuildResult, BuildResultStatus

FIXTURES = Path(__file__).parent / "fixtures"


def _spec(build_id: str, binding_id: str = "binding_gdc") -> DatasetBuildSpec:
    return DatasetBuildSpec(
        build_id=build_id,
        objective="compare TP53 expression across sources",
        dataset_family="gene_expression",
        row_granularity="gene_sample_measurement",
        schema_ref="gene_expression.long.v1",
        source_bindings=[
            SourceBinding(
                binding_id=binding_id,
                source="gdc",
                acquisition=SourceBindingAcquisition(
                    mode=AcquisitionMode.BUILTIN, provider_id="gdc.v1"
                ),
                adapter_id="gdc.expression.v1",
            )
        ],
        merge_strategy="append_by_canonical_row",
        validation_profile_ref="gene_expression.release.v1",
        normalization_profile_ref="gene_expression.normalization.v1",
    )


def _copy_fixture(tmp_path: Path, build_id: str, binding_id: str) -> Path:
    """Copy-dir fixture: give each build its OWN independent source file."""
    dest = tmp_path / "sources" / build_id / f"{binding_id}.tsv"
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(FIXTURES / "gdc/gdc_expression.tsv", dest)
    return dest


async def _run_single_build(
    tmp_path: Path,
    spec: DatasetBuildSpec,
    source_path: Path,
) -> BuildExecutionSummary:
    """Run one real build (ExpressionBuildRunner + DatasetBuildExecutor) and
    return its BuildExecutionSummary — the production seam the orchestrator
    aggregates. Each build gets an isolated output/state directory."""
    binding_id = spec.source_bindings[0].binding_id
    registry = SchemaRegistry([build_gene_expression_schema()])
    checksum = __import__("hashlib").sha256(source_path.read_bytes()).hexdigest()
    asset = SourceAsset(
        asset_id=asset_id_from_sha256(checksum),
        kind="source",
        relative_path=f"source_assets/{source_path.name}",
        sha256=checksum,
        size_bytes=source_path.stat().st_size,
        media_type="text/tab-separated-values",
        source_id=f"src_{binding_id}",
        successful_attempt_id="attempt_1",
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )
    assets = {binding_id: asset}
    paths = {binding_id: source_path}
    output_dir = tmp_path / "builds" / spec.build_id
    state_dir = tmp_path / "state" / spec.build_id
    runner = ExpressionBuildRunner(
        spec=spec,
        registry=registry,
        source_assets=assets,
        source_paths=paths,
        output_dir=output_dir,
    )
    plan = build_operation_plan(spec)
    executor = DatasetBuildExecutor(
        task_id="task_multi",
        build_id=spec.build_id,
        run_id="run_multi",
        state_dir=state_dir,
        lock_path=tmp_path / "build.lock",
        task_root=tmp_path,
        plan=plan,
        run_operation=runner,
        source_assets=assets,
        implementation_versions={op.operation_id: "1.0.0" for op in plan},
    )
    outcome = await executor.run()
    if outcome.status != "completed":
        return BuildExecutionSummary(
            build_id=spec.build_id,
            status=None,
            error_message=(
                outcome.error.message if outcome.error is not None else outcome.status
            ),
        )
    publication_id: str | None = None
    supersedes: str | None = None
    audit_files: list[str] = []
    for version_dir in (output_dir / "publish").glob(f"{spec.build_id}_*"):
        record = json.loads((version_dir / "publication.json").read_text("utf-8"))
        publication_id = record["publication_id"]
        supersedes = record["supersedes_publication_id"]
        manifest_path = version_dir / "dataset_manifest.json"
        if manifest_path.is_file():
            manifest = json.loads(manifest_path.read_text("utf-8"))
            audit_files = [
                entry["relative_path"]
                for entry in manifest.get("artifacts", [])
                if entry.get("role") == "audit_report"
            ]
    result = BuildResult(
        status=BuildResultStatus.SUCCEEDED,
        valid_row_count=4,
        successful_sources=[binding_id],
        rejected_sources=[],
        publication_id=publication_id,
        reason_codes=[],
        user_summary=f"build {spec.build_id} published",
    )
    return BuildExecutionSummary(
        build_id=spec.build_id,
        status=BuildResultStatus.SUCCEEDED,
        result=result,
        publication_id=publication_id,
        supersedes_publication_id=supersedes,
        audit_summary=audit_files,
    )


async def _run_orchestrator(
    tmp_path: Path,
    build_ids: list[str],
) -> MultiBuildResult:
    specs = [_spec(build_id) for build_id in build_ids]
    sources = {
        build_id: _copy_fixture(tmp_path, build_id, "binding_gdc")
        for build_id in build_ids
    }

    async def run_build(spec: DatasetBuildSpec) -> BuildExecutionSummary:
        return await _run_single_build(tmp_path, spec, sources[spec.build_id])

    orchestrator = MultiBuildOrchestrator(run_build=run_build)
    return await orchestrator.run(specs)


def test_orchestrator_two_fixture_builds_have_distinct_publications(
    tmp_path: Path,
) -> None:
    """Two copy-dir fixture builds -> distinct build_ids and publication_ids,
    each SUCCEEDED, and neither supersedes the other."""
    result = asyncio.run(_run_orchestrator(tmp_path, ["build_geo_a", "build_geo_b"]))
    assert len(result.builds) == 2
    a, b = result.builds
    assert a.build_id != b.build_id
    assert a.status is BuildResultStatus.SUCCEEDED
    assert b.status is BuildResultStatus.SUCCEEDED
    assert a.publication_id is not None
    assert b.publication_id is not None
    assert a.publication_id != b.publication_id
    # No cross-build supersede: neither publication references the other.
    assert a.supersedes_publication_id is None
    assert b.supersedes_publication_id is None
    # BuildResult is the authoritative business outcome per build.
    assert a.result is not None and a.result.status is BuildResultStatus.SUCCEEDED
    assert b.result is not None and b.result.status is BuildResultStatus.SUCCEEDED


def test_orchestrator_failure_isolation(tmp_path: Path) -> None:
    """One build failing must not roll back or pollute the other build."""
    specs = [_spec("build_geo_a"), _spec("build_geo_b")]
    sources = {
        build_id: _copy_fixture(tmp_path, build_id, "binding_gdc")
        for build_id in ("build_geo_a", "build_geo_b")
    }

    async def run_build(spec: DatasetBuildSpec) -> BuildExecutionSummary:
        if spec.build_id == "build_geo_b":
            raise RuntimeError("simulated GSE failure")
        return await _run_single_build(tmp_path, spec, sources[spec.build_id])

    orchestrator = MultiBuildOrchestrator(run_build=run_build)
    result = asyncio.run(orchestrator.run(specs))

    assert len(result.builds) == 2
    a, b = result.builds
    assert a.status is BuildResultStatus.SUCCEEDED
    assert a.publication_id is not None
    # The failing build is reported as failed without poisoning the batch.
    assert b.status is None
    assert b.publication_id is None
    assert "simulated GSE failure" in (b.error_message or "")
    # The successful build's publication is intact on disk.
    version_dirs = list(
        (tmp_path / "builds" / "build_geo_a" / "publish").glob("build_geo_a_*")
    )
    assert len(version_dirs) == 1


def test_orchestrator_no_data_isolation(tmp_path: Path) -> None:
    """A NO_DATA build (no publication) must not affect the other build."""
    specs = [_spec("build_geo_a"), _spec("build_geo_b")]
    sources = {
        build_id: _copy_fixture(tmp_path, build_id, "binding_gdc")
        for build_id in ("build_geo_a", "build_geo_b")
    }

    async def run_build(spec: DatasetBuildSpec) -> BuildExecutionSummary:
        if spec.build_id == "build_geo_b":
            return BuildExecutionSummary(
                build_id=spec.build_id,
                status=BuildResultStatus.NO_DATA,
                result=BuildResult(
                    status=BuildResultStatus.NO_DATA,
                    valid_row_count=0,
                    successful_sources=[],
                    rejected_sources=["binding_gdc"],
                    publication_id=None,
                    reason_codes=["no_primary_data"],
                    user_summary="no primary data",
                ),
                publication_id=None,
            )
        return await _run_single_build(tmp_path, spec, sources[spec.build_id])

    orchestrator = MultiBuildOrchestrator(run_build=run_build)
    result = asyncio.run(orchestrator.run(specs))

    a, b = result.builds
    assert a.status is BuildResultStatus.SUCCEEDED
    assert a.publication_id is not None
    assert b.status is BuildResultStatus.NO_DATA
    assert b.publication_id is None


def test_orchestrator_asserts_no_cross_build_supersede(tmp_path: Path) -> None:
    """If a build's publication illegally supersedes ANOTHER build's
    publication, the orchestrator must raise instead of silently returning
    a polluted MultiBuildResult."""
    specs = [_spec("build_geo_a"), _spec("build_geo_b")]
    sources = {
        build_id: _copy_fixture(tmp_path, build_id, "binding_gdc")
        for build_id in ("build_geo_a", "build_geo_b")
    }

    async def run_build(spec: DatasetBuildSpec) -> BuildExecutionSummary:
        summary = await _run_single_build(tmp_path, spec, sources[spec.build_id])
        if spec.build_id == "build_geo_a":
            captured["pub_a"] = summary.publication_id
        if spec.build_id == "build_geo_b" and captured.get("pub_a"):
            # Simulate a supersede regression: build B supersedes build A.
            return summary.model_copy(
                update={"supersedes_publication_id": captured["pub_a"]}
            )
        return summary

    orchestrator = MultiBuildOrchestrator(run_build=run_build)
    captured: dict[str, str | None] = {}
    with pytest.raises(ValueError, match="cross-build supersede"):
        asyncio.run(orchestrator.run(specs))


def test_orchestrator_rejects_unknown_build_id_from_callback(tmp_path: Path) -> None:
    """The callback must return a summary for the build it was asked to run."""
    specs = [_spec("build_geo_a")]

    async def run_build(spec: DatasetBuildSpec) -> BuildExecutionSummary:
        return BuildExecutionSummary(build_id="some_other_build")

    orchestrator = MultiBuildOrchestrator(run_build=run_build)
    with pytest.raises(ValueError, match="build_geo_a"):
        asyncio.run(orchestrator.run(specs))
