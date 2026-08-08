"""ExpressionBuildRunner + DatasetBuildExecutor integration tests (Phase 3 P2).

The real operation runner splits the expression chain into per-operation
handlers so the Phase 2 execution kernel can execute and checkpoint the
whole skeleton (parse -> canonicalize -> compatibility gate -> integrate ->
validate profile -> publish) with the Phase 6 release invariants gate.
"""

from __future__ import annotations

import asyncio
import csv
import hashlib
import json
from pathlib import Path

import pytest
from app.datasets.build.expression_runner import ExpressionBuildRunner
from app.datasets.contracts import (
    AcquisitionMode,
    AdapterParams,
    DatasetBuildSpec,
    SourceBinding,
    SourceBindingAcquisition,
    ValueScale,
)
from app.datasets.runtime import (
    DatasetBuildExecutor,
    OperationKind,
    OperationSpec,
    build_operation_plan,
)
from app.datasets.schema_registry import SchemaRegistry, build_gene_expression_schema
from app.domain.contracts import DataLevel, ErrorCode, SourceAsset, asset_id_from_sha256

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
async def test_published_version_preserves_manifest_relative_paths(
    tmp_path: Path,
) -> None:
    """B3: every manifest artifact must resolve inside the published version
    directory — relative paths (merged/primary.csv, schema.json, ...) are
    preserved, not flattened to basenames.
    """
    outcome, output_dir = await _run_executor(
        tmp_path,
        [_binding("binding_gdc", "gdc", "gdc.expression.v1")],
        {"binding_gdc": "gdc/gdc_expression.tsv"},
    )
    assert outcome.status == "completed"
    version_dir = next((output_dir / "publish").glob("build_runner_test_*"))
    published_manifest = json.loads(
        (version_dir / "dataset_manifest.json").read_text("utf-8")
    )
    assert published_manifest["artifacts"], "manifest must declare artifacts"
    for entry in published_manifest["artifacts"]:
        assert (version_dir / entry["relative_path"]).is_file(), (
            f"published artifact {entry['relative_path']} is missing "
            f"from the version directory"
        )


@pytest.mark.asyncio
async def test_publish_rejects_missing_manifest_artifact_after_validation(
    tmp_path: Path,
) -> None:
    """B4: deleting a manifest artifact after validation must fail the release
    gate so publish raises BuildError and nothing is promoted.
    """
    from app.datasets.build.errors import BuildError
    from app.datasets.runtime import OperationKind

    bindings = [_binding("binding_gdc", "gdc", "gdc.expression.v1")]
    spec = _spec(bindings)
    registry = SchemaRegistry([build_gene_expression_schema()])
    assets = {"binding_gdc": _source_asset("gdc/gdc_expression.tsv", "src_binding_gdc")}
    paths = {"binding_gdc": FIXTURES / "gdc/gdc_expression.tsv"}
    runner = ExpressionBuildRunner(
        spec=spec,
        registry=registry,
        source_assets=assets,
        source_paths=paths,
        output_dir=tmp_path,
    )

    async def wrapped(op, upstream):
        result = await runner.run_operation(op, upstream)
        if op.kind is OperationKind.VALIDATE_PROFILE:
            # Delete a non-provenance manifest artifact (schema.json): the
            # provenance-closure gate does not cover it, only the manifest
            # artifact inventory check does.
            (tmp_path / "schema.json").unlink()
        return result

    plan = build_operation_plan(spec)
    executor = DatasetBuildExecutor(
        task_id="task_runner",
        build_id=spec.build_id,
        run_id="run_runner",
        state_dir=tmp_path / "state" / spec.build_id,
        lock_path=tmp_path / "build.lock",
        task_root=tmp_path,
        plan=plan,
        run_operation=wrapped,
        implementation_versions={op.operation_id: "1.0.0" for op in plan},
    )
    outcome = await executor.run()

    assert outcome.status == "failed"
    assert outcome.error is not None
    assert "release invariants failed" in outcome.error.message
    assert not list((tmp_path / "publish").glob("build_runner_test_*"))

    # The publish operation itself raises BuildError for the same violation.
    with pytest.raises(BuildError, match="release invariants failed"):
        await runner.run_operation(plan[-1], {})


@pytest.mark.asyncio
async def test_publish_does_not_supersede_across_build_ids(tmp_path: Path) -> None:
    """Phase 5 T6: the supersede lookup is build-scoped — a publication of
    one build_id must NEVER supersede a publication of another build_id even
    when both share the same publish directory."""
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
    # Distinct build_ids -> neither supersedes the other.
    assert first_pub["supersedes_publication_id"] is None
    assert second_pub["supersedes_publication_id"] is None


@pytest.mark.asyncio
async def test_publish_supersedes_within_same_build(tmp_path: Path) -> None:
    """Phase 5 T6: re-publishing the SAME build_id with a new digest still
    supersedes that build's own prior version (build-scoped supersede chain)."""
    source_a = tmp_path / "src_a.tsv"
    source_b = tmp_path / "src_b.tsv"
    source_a.write_text("gene_id\tS1\tS2\nTP53\t1.5\t2\nBRCA1\t3\t4.25\n", "utf-8")
    source_b.write_text("gene_id\tS1\tS2\nTP53\t99\t100\nBRCA1\t101\t102\n", "utf-8")

    async def build_with(source_path: Path) -> tuple[object, list[dict[str, str]]]:
        spec = _spec([_binding("binding_gdc", "gdc", "gdc.expression.v1")], build_id="build_same")
        registry = SchemaRegistry([build_gene_expression_schema()])
        checksum = hashlib.sha256(source_path.read_bytes()).hexdigest()
        asset = SourceAsset(
            asset_id=asset_id_from_sha256(checksum),
            kind="source",
            relative_path=f"source_assets/{source_path.name}",
            sha256=checksum,
            size_bytes=source_path.stat().st_size,
            media_type="text/tab-separated-values",
            source_id="src_binding_gdc",
            successful_attempt_id="attempt_1",
            data_level=DataLevel.REPOSITORY_PROCESSED,
        )
        assets = {"binding_gdc": asset}
        paths = {"binding_gdc": source_path}
        runner = ExpressionBuildRunner(
            spec=spec,
            registry=registry,
            source_assets=assets,
            source_paths=paths,
            output_dir=tmp_path,
        )
        plan = build_operation_plan(spec)
        executor = DatasetBuildExecutor(
            task_id="task_runner",
            build_id=spec.build_id,
            run_id="run_runner",
            state_dir=tmp_path / "state" / spec.build_id,
            lock_path=tmp_path / "build.lock",
            task_root=tmp_path,
            plan=plan,
            run_operation=runner,
            source_assets=assets,
            implementation_versions={op.operation_id: "1.0.0" for op in plan},
        )
        outcome = await executor.run()
        return outcome, _primary_rows(tmp_path)

    first_outcome, _ = await build_with(source_a)
    assert first_outcome.status == "completed"
    first_pub_dir = list((tmp_path / "publish").glob("build_same_*"))[0]
    first_pub = json.loads(
        (first_pub_dir / "publication.json").read_text("utf-8")
    )
    assert first_pub["supersedes_publication_id"] is None

    second_outcome, _ = await build_with(source_b)
    assert second_outcome.status == "completed"
    publish_dirs = list((tmp_path / "publish").glob("build_same_*"))
    assert len(publish_dirs) == 2
    second_pub_dir = [d for d in publish_dirs if d.name != first_pub_dir.name][0]
    second_pub = json.loads(
        (second_pub_dir / "publication.json").read_text("utf-8")
    )
    # Same build_id -> the newer version supersedes the older one.
    assert second_pub["supersedes_publication_id"] == first_pub["publication_id"]


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


@pytest.mark.asyncio
async def test_runner_rerun_with_changed_source_invalidates_checkpoints(
    tmp_path: Path,
) -> None:
    """B2: replacing a source file must invalidate reused checkpoints.

    Re-running the same build_id after the source content changed must
    re-execute the pipeline and publish a NEW publication with the new
    values — the old checkpoint must not short-circuit. ``output_dir`` is
    set to the executor ``task_root`` so checkpoint file verification can
    actually succeed (otherwise a separate latent path quirk re-runs the
    middle operations and masks the digest gap).
    """

    source_a = tmp_path / "source_a.tsv"
    source_b = tmp_path / "source_b.tsv"
    source_a.write_text("gene_id\tS1\tS2\nTP53\t1.5\t2\nBRCA1\t3\t4.25\n", "utf-8")
    source_b.write_text("gene_id\tS1\tS2\nTP53\t99\t100\nBRCA1\t101\t102\n", "utf-8")

    async def build_with(source_path: Path) -> tuple[object, list[dict[str, str]]]:
        spec = _spec([_binding("binding_gdc", "gdc", "gdc.expression.v1")])
        registry = SchemaRegistry([build_gene_expression_schema()])
        checksum = hashlib.sha256(source_path.read_bytes()).hexdigest()
        asset = SourceAsset(
            asset_id=asset_id_from_sha256(checksum),
            kind="source",
            relative_path=f"source_assets/{source_path.name}",
            sha256=checksum,
            size_bytes=source_path.stat().st_size,
            media_type="text/tab-separated-values",
            source_id="src_binding_gdc",
            successful_attempt_id="attempt_1",
            data_level=DataLevel.REPOSITORY_PROCESSED,
        )
        assets = {"binding_gdc": asset}
        paths = {"binding_gdc": source_path}
        runner = ExpressionBuildRunner(
            spec=spec,
            registry=registry,
            source_assets=assets,
            source_paths=paths,
            output_dir=tmp_path,
        )
        plan = build_operation_plan(spec)
        executor = DatasetBuildExecutor(
            task_id="task_runner",
            build_id=spec.build_id,
            run_id="run_runner",
            state_dir=tmp_path / "state" / spec.build_id,
            lock_path=tmp_path / "build.lock",
            task_root=tmp_path,
            plan=plan,
            run_operation=runner,
            source_assets=assets,
            implementation_versions={op.operation_id: "1.0.0" for op in plan},
        )
        outcome = await executor.run()
        return outcome, _primary_rows(tmp_path)

    first_outcome, _ = await build_with(source_a)
    assert first_outcome.status == "completed"
    first_pub_dir = list((tmp_path / "publish").glob("build_runner_test_*"))[0]
    first_pub = json.loads(
        (first_pub_dir / "publication.json").read_text("utf-8")
    )

    second_outcome, rows = await build_with(source_b)
    assert second_outcome.status == "completed"
    publish_dirs = list((tmp_path / "publish").glob("build_runner_test_*"))
    assert len(publish_dirs) == 2
    second_pub_dir = [d for d in publish_dirs if d.name != first_pub_dir.name][0]
    second_pub = json.loads(
        (second_pub_dir / "publication.json").read_text("utf-8")
    )
    assert second_pub["publication_id"] != first_pub["publication_id"]

    # The new values must be in the newly published primary, not the stale one.
    assert {r["expression_value"] for r in rows} == {"99", "100", "101", "102"}

    # The acquire checkpoint was NOT reused: no SKIPPED acquire attempt and the
    # re-run acquire attempt carries a different input digest.
    attempts_path = tmp_path / "state" / "build_runner_test" / "operation_attempts.jsonl"
    attempts = [json.loads(line) for line in attempts_path.read_text().splitlines()]
    acquire_attempts = [
        a for a in attempts if a["operation_id"] == "acquire:binding_gdc"
    ]
    assert acquire_attempts[-1]["status"] == "succeeded"
    assert acquire_attempts[-1]["input_digest"] != acquire_attempts[0]["input_digest"]


def test_find_latest_publication_scopes_to_build_id(tmp_path: Path) -> None:
    """Phase 5 T6: ``find_latest_publication(..., build_id=...)`` must only
    consider version directories of THAT build — distinct builds sharing one
    publish directory never see each other's versions."""
    from datetime import UTC, datetime

    from app.datasets.build.invariants import find_latest_publication as _find_latest_publication

    publish_dir = tmp_path / "publish"
    base = datetime(2026, 8, 1, tzinfo=UTC)

    def _write(build_id: str, digest: str, published_at: datetime) -> None:
        version_dir = publish_dir / f"{build_id}_{digest}"
        version_dir.mkdir(parents=True)
        (version_dir / "publication.json").write_text(
            json.dumps(
                {
                    "publication_id": f"pub_{build_id}_{digest}",
                    "published_at": published_at.isoformat(),
                }
            ),
            "utf-8",
        )

    _write("build_a", "aaaaaaaaaaaaaaaa", base)
    _write("build_b", "bbbbbbbbbbbbbbbb", base)
    _write("build_a", "cccccccccccccccc", base)

    # build-scoped: each build sees only its own newest version.
    assert _find_latest_publication(publish_dir, build_id="build_a") == "pub_build_a_cccccccccccccccc"
    assert _find_latest_publication(publish_dir, build_id="build_b") == "pub_build_b_bbbbbbbbbbbbbbbb"


def test_find_latest_publication_selects_newest_by_published_at(
    tmp_path: Path,
) -> None:
    """B8: the supersedes chain must pick the newest by time, not ID order.

    publication_ids are ``pub_<build_id>_<digest-prefix>`` so digest order is
    unrelated to publication time. With chronologically published digests
    ``f...`` then ``a...`` then ``0...``, the newest is the middle ID by
    string order — the selection must return it.
    """
    from datetime import UTC, datetime, timedelta

    from app.datasets.build.invariants import find_latest_publication as _find_latest_publication

    publish_dir = tmp_path / "publish"
    base = datetime(2026, 8, 1, tzinfo=UTC)
    records = [
        ("pub_build_x_f1234567890abcdef", base),
        ("pub_build_x_a1234567890abcdef", base + timedelta(minutes=10)),
        ("pub_build_x_0123456789abcdef", base + timedelta(minutes=20)),
    ]
    for publication_id, published_at in records:
        version_dir = publish_dir / publication_id.removeprefix("pub_build_x_")
        version_dir.mkdir(parents=True)
        (version_dir / "publication.json").write_text(
            json.dumps(
                {
                    "publication_id": publication_id,
                    "published_at": published_at.isoformat(),
                }
            ),
            "utf-8",
        )

    # Lexicographic max is f...; the newest by time is 0... (published last).
    assert _find_latest_publication(publish_dir) == "pub_build_x_0123456789abcdef"


def test_find_latest_publication_tie_breaks_deterministically(
    tmp_path: Path,
) -> None:
    """Equal published_at timestamps resolve deterministically."""
    from datetime import UTC, datetime

    from app.datasets.build.invariants import find_latest_publication as _find_latest_publication

    publish_dir = tmp_path / "publish"
    same_time = datetime(2026, 8, 1, tzinfo=UTC)
    for publication_id in ("pub_build_x_b1234567890abcdef", "pub_build_x_a1234567890abcdef"):
        version_dir = publish_dir / publication_id.removeprefix("pub_build_x_")
        version_dir.mkdir(parents=True)
        (version_dir / "publication.json").write_text(
            json.dumps(
                {
                    "publication_id": publication_id,
                    "published_at": same_time.isoformat(),
                }
            ),
            "utf-8",
        )

    result = _find_latest_publication(publish_dir)
    assert result in (
        "pub_build_x_a1234567890abcdef",
        "pub_build_x_b1234567890abcdef",
    )
    # Deterministic: a second call returns the same choice.
    assert _find_latest_publication(publish_dir) == result


def test_find_latest_publication_ignores_malformed_records(tmp_path: Path) -> None:
    """Records without a parseable publication_id/published_at are skipped."""
    from datetime import UTC, datetime

    from app.datasets.build.invariants import find_latest_publication as _find_latest_publication

    publish_dir = tmp_path / "publish"
    good = publish_dir / "0123456789abcdef"
    good.mkdir(parents=True)
    (good / "publication.json").write_text(
        json.dumps(
            {
                "publication_id": "pub_build_x_0123456789abcdef",
                "published_at": datetime(2026, 8, 1, tzinfo=UTC).isoformat(),
            }
        ),
        "utf-8",
    )
    bad = publish_dir / "zzzz"
    bad.mkdir()
    (bad / "publication.json").write_text("{not json", "utf-8")

    assert _find_latest_publication(publish_dir) == "pub_build_x_0123456789abcdef"


class _FlagToken:
    def __init__(self) -> None:
        self._set = False

    def is_set(self) -> bool:
        return self._set

    def set(self) -> None:
        self._set = True


@pytest.mark.asyncio
async def test_cancellation_between_validate_and_publish_blocks_publication(
    tmp_path: Path,
) -> None:
    """D2: cancelling between validation and publish yields a cancelled
    outcome and no publication directory."""
    from app.datasets.runtime import OperationKind

    token = _FlagToken()
    bindings = [_binding("binding_gdc", "gdc", "gdc.expression.v1")]
    spec = _spec(bindings)
    registry = SchemaRegistry([build_gene_expression_schema()])
    assets = {"binding_gdc": _source_asset("gdc/gdc_expression.tsv", "src_binding_gdc")}
    paths = {"binding_gdc": FIXTURES / "gdc/gdc_expression.tsv"}
    runner = ExpressionBuildRunner(
        spec=spec,
        registry=registry,
        source_assets=assets,
        source_paths=paths,
        output_dir=tmp_path,
        cancellation_requested=token,
    )

    async def wrapped(op, upstream):
        result = await runner.run_operation(op, upstream)
        if op.kind is OperationKind.VALIDATE_PROFILE:
            token.set()
        return result

    plan = build_operation_plan(spec)
    executor = DatasetBuildExecutor(
        task_id="task_runner",
        build_id=spec.build_id,
        run_id="run_runner",
        state_dir=tmp_path / "state" / spec.build_id,
        lock_path=tmp_path / "build.lock",
        task_root=tmp_path,
        plan=plan,
        run_operation=wrapped,
        source_assets=assets,
        cancellation_requested=token,
        implementation_versions={op.operation_id: "1.0.0" for op in plan},
    )
    outcome = await executor.run()

    assert outcome.status == "cancelled"
    assert not list((tmp_path / "publish").glob("build_runner_test_*"))
    attempts = [
        json.loads(line)
        for line in (tmp_path / "state" / "build_runner_test" / "operation_attempts.jsonl")
        .read_text()
        .splitlines()
    ]
    publish_attempts = [a for a in attempts if a["operation_id"] == "publish"]
    assert all(a["status"] == "cancelled" for a in publish_attempts)


@pytest.mark.asyncio
async def test_runner_publish_refuses_cancelled_token_directly(
    tmp_path: Path,
) -> None:
    """D2 defense in depth: publish raises BuildCancelledError when the token
    is already set, even without the executor wrapper."""
    from app.datasets.runtime.executor import BuildCancelledError
    from app.datasets.runtime.operations import OperationKind, OperationSpec

    token = _FlagToken()
    token.set()
    bindings = [_binding("binding_gdc", "gdc", "gdc.expression.v1")]
    spec = _spec(bindings)
    registry = SchemaRegistry([build_gene_expression_schema()])
    assets = {"binding_gdc": _source_asset("gdc/gdc_expression.tsv", "src_binding_gdc")}
    paths = {"binding_gdc": FIXTURES / "gdc/gdc_expression.tsv"}
    runner = ExpressionBuildRunner(
        spec=spec,
        registry=registry,
        source_assets=assets,
        source_paths=paths,
        output_dir=tmp_path,
        cancellation_requested=token,
    )
    publish_op = OperationSpec(
        operation_id="publish",
        kind=OperationKind.PUBLISH,
        label="atomic publish",
        upstream=("validate_profile",),
    )
    with pytest.raises(BuildCancelledError):
        await runner.run_operation(publish_op, {})


@pytest.mark.asyncio
async def test_cancellation_during_blocking_integrate_is_observed_and_blocks_publication(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """D2/H1: the heavy synchronous operations run off the event loop, so a
    cancellation requested while integrate is blocked in a worker thread is
    observed at the operation boundary — the build returns a cancelled
    outcome within bounded time and never publishes. Before the to_thread
    offload the loop was blocked for the whole operation, so a cancel request
    could not even be processed until the build had already published.
    """
    import threading
    import time

    from app.datasets.build import expression_runner as expression_runner_module

    token = _FlagToken()
    real_integrate = expression_runner_module.integrate
    integrate_started = threading.Event()

    def blocking_integrate(*args, **kwargs):
        integrate_started.set()
        time.sleep(0.4)
        return real_integrate(*args, **kwargs)

    monkeypatch.setattr(expression_runner_module, "integrate", blocking_integrate)

    bindings = [_binding("binding_gdc", "gdc", "gdc.expression.v1")]
    spec = _spec(bindings)
    registry = SchemaRegistry([build_gene_expression_schema()])
    assets = {"binding_gdc": _source_asset("gdc/gdc_expression.tsv", "src_binding_gdc")}
    paths = {"binding_gdc": FIXTURES / "gdc/gdc_expression.tsv"}
    runner = ExpressionBuildRunner(
        spec=spec,
        registry=registry,
        source_assets=assets,
        source_paths=paths,
        output_dir=tmp_path,
        cancellation_requested=token,
    )
    plan = build_operation_plan(spec)
    executor = DatasetBuildExecutor(
        task_id="task_runner",
        build_id=spec.build_id,
        run_id="run_runner",
        state_dir=tmp_path / "state" / spec.build_id,
        lock_path=tmp_path / "build.lock",
        task_root=tmp_path,
        plan=plan,
        run_operation=runner,
        source_assets=assets,
        cancellation_requested=token,
        implementation_versions={op.operation_id: "1.0.0" for op in plan},
    )
    run_task = asyncio.create_task(executor.run())
    # Wait for integrate to be in flight (inside its worker thread pre-fix, or
    # blocking the loop pre-fix) before requesting cancellation.
    await asyncio.to_thread(integrate_started.wait, 5.0)
    token.set()
    outcome = await asyncio.wait_for(run_task, timeout=2.0)
    assert outcome.status == "cancelled"
    assert not list((tmp_path / "publish").glob("build_runner_test_*"))


@pytest.mark.asyncio
async def test_cancelled_integrate_outputs_are_discarded_and_retry_publishes_clean(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """D2/K1: a cancellation observed at the operation boundary must DISCARD
    the cancelled operation's outputs — the completed-too-late worker thread's
    files never remain in the build workspace — and a retry of the same
    build_id with new inputs succeeds and publishes only the new run's data
    (no overlap with the cancelled attempt's leftovers). Python cannot
    interrupt the in-flight sync work; the honest close is output discard at
    the boundary plus a clean checkpoint in the state dir.
    """
    import threading
    import time

    from app.datasets.build import expression_runner as expression_runner_module

    token = _FlagToken()
    real_integrate = expression_runner_module.integrate
    integrate_started = threading.Event()

    def blocking_integrate(*args, **kwargs):
        integrate_started.set()
        time.sleep(0.4)
        return real_integrate(*args, **kwargs)

    monkeypatch.setattr(expression_runner_module, "integrate", blocking_integrate)

    bindings = [_binding("binding_gdc", "gdc", "gdc.expression.v1")]
    spec = _spec(bindings)
    registry = SchemaRegistry([build_gene_expression_schema()])
    output_dir = tmp_path / "build"
    assets = {"binding_gdc": _source_asset("gdc/gdc_expression.tsv", "src_binding_gdc")}
    paths = {"binding_gdc": FIXTURES / "gdc/gdc_expression.tsv"}
    runner = ExpressionBuildRunner(
        spec=spec,
        registry=registry,
        source_assets=assets,
        source_paths=paths,
        output_dir=output_dir,
        cancellation_requested=token,
    )
    plan = build_operation_plan(spec)
    executor = DatasetBuildExecutor(
        task_id="task_runner",
        build_id=spec.build_id,
        run_id="run_runner",
        state_dir=tmp_path / "state" / spec.build_id,
        lock_path=tmp_path / "build.lock",
        task_root=tmp_path,
        plan=plan,
        run_operation=runner,
        source_assets=assets,
        cancellation_requested=token,
        implementation_versions={op.operation_id: "1.0.0" for op in plan},
    )
    run_task = asyncio.create_task(executor.run())
    await asyncio.to_thread(integrate_started.wait, 5.0)
    token.set()
    outcome = await asyncio.wait_for(run_task, timeout=2.0)

    assert outcome.status == "cancelled"
    assert not list((output_dir / "publish").glob("build_runner_test_*"))
    # K1: the cancelled integrate operation's outputs are discarded — the
    # completed-too-late thread's merged primary must not remain in the build
    # workspace where a retry or an inspection could mistake it for valid
    # build state (or overlap with the next run's writes).
    assert not (output_dir / "merged" / "primary.csv").exists()
    assert not (output_dir / "merged" / "conflicts.csv").exists()

    # The state dir records the cancellation (clean checkpoint): no SUCCEEDED
    # integrate attempt exists for the retry to reuse, and the next run starts
    # from a clean integrate.
    attempts = [
        json.loads(line)
        for line in (
            tmp_path / "state" / spec.build_id / "operation_attempts.jsonl"
        )
        .read_text()
        .splitlines()
    ]
    integrate_attempts = [a for a in attempts if a["operation_id"] == "integrate"]
    assert integrate_attempts and all(
        a["status"] == "cancelled" for a in integrate_attempts
    )

    # Retry the same build_id with NEW inputs: the build succeeds and the
    # published artifact reflects only the new run's data.
    monkeypatch.setattr(expression_runner_module, "integrate", real_integrate)
    new_input = tmp_path / "new_input.tsv"
    new_input.write_text(
        "gene_id\tS1\tS2\nTP53\t9\t10\nBRCA1\t11\t12\n", encoding="utf-8"
    )
    checksum = hashlib.sha256(new_input.read_bytes()).hexdigest()
    new_asset = SourceAsset(
        asset_id=asset_id_from_sha256(checksum),
        kind="source",
        relative_path="source_assets/new_input.tsv",
        sha256=checksum,
        size_bytes=new_input.stat().st_size,
        media_type="text/tab-separated-values",
        source_id="src_binding_gdc",
        successful_attempt_id="attempt_1",
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )
    retry_runner = ExpressionBuildRunner(
        spec=spec,
        registry=registry,
        source_assets={"binding_gdc": new_asset},
        source_paths={"binding_gdc": new_input},
        output_dir=output_dir,
    )
    retry_executor = DatasetBuildExecutor(
        task_id="task_runner",
        build_id=spec.build_id,
        run_id="run_runner_2",
        state_dir=tmp_path / "state" / spec.build_id,
        lock_path=tmp_path / "build.lock",
        task_root=tmp_path,
        plan=plan,
        run_operation=retry_runner,
        source_assets={"binding_gdc": new_asset},
        implementation_versions={op.operation_id: "1.0.0" for op in plan},
    )
    retry = await retry_executor.run()

    assert retry.status == "completed"
    version_dir = next((output_dir / "publish").glob("build_runner_test_*"))
    with (version_dir / "merged" / "primary.csv").open(encoding="utf-8") as handle:
        published = list(csv.DictReader(handle))
    assert len(published) == 4  # 2 genes x 2 samples from the new input
    # Only the new run's data is published: none of the old input's values
    # (1.5 / 2 / 3 / 4.25) leaked into the new publication, and the gene
    # symbols are the canonical ensembl ids from the new input's rows.
    values = {row["expression_value"] for row in published}
    assert values == {"9", "10", "11", "12"}
    assert {row["sample_id"] for row in published} == {"S1", "S2"}
    assert {row["gene_id_namespace"] for row in published} == {"ensembl_gene"}


@pytest.mark.asyncio
async def test_timed_out_integrate_waits_for_straggler_before_lock_release(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """K1 residual (Phase 4 review): the operation-timeout path cancels only
    the await — the ``to_thread`` integrate worker keeps running and may still
    be writing merged/primary.csv. The executor must NOT return (and thus
    must NOT release the build lock) while that straggler may still be alive,
    or a same-build_id retry could validate/publish a file the late thread
    later overwrites. The executor waits for the straggler (bounded) before
    finalizing the timed-out failure and releasing the lock.
    """
    import threading

    from app.datasets.build import expression_runner as expression_runner_module

    real_integrate = expression_runner_module.integrate
    integrate_started = threading.Event()
    release_worker = threading.Event()

    def blocking_integrate(*args, **kwargs):
        integrate_started.set()
        # Simulate a worker mid-write when the operation timeout fires: the
        # thread keeps running (its future stays not-done) until the test
        # releases it.
        release_worker.wait(10.0)
        return real_integrate(*args, **kwargs)

    monkeypatch.setattr(expression_runner_module, "integrate", blocking_integrate)

    bindings = [_binding("binding_gdc", "gdc", "gdc.expression.v1")]
    spec = _spec(bindings)
    registry = SchemaRegistry([build_gene_expression_schema()])
    output_dir = tmp_path / "build"
    assets = {"binding_gdc": _source_asset("gdc/gdc_expression.tsv", "src_binding_gdc")}
    paths = {"binding_gdc": FIXTURES / "gdc/gdc_expression.tsv"}
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
        run_id="run_timeout_a",
        state_dir=tmp_path / "state" / spec.build_id,
        lock_path=tmp_path / "build.lock",
        task_root=tmp_path,
        plan=plan,
        run_operation=runner,
        source_assets=assets,
        implementation_versions={op.operation_id: "1.0.0" for op in plan},
        operation_timeout=0.5,
    )
    run_task = asyncio.create_task(executor.run())
    assert await asyncio.to_thread(integrate_started.wait, 5.0), "integrate never started"
    # The operation timeout (0.5s) fires while the integrate worker is
    # mid-write. (a) The executor must NOT resolve — and must NOT release the
    # build lock — before the straggler worker finishes.
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(asyncio.shield(run_task), timeout=1.0)
    # (b) Once the straggler finishes, the executor returns the timed-out
    # failure and releases the lock.
    release_worker.set()
    outcome = await asyncio.wait_for(run_task, timeout=5.0)
    assert outcome.status == "failed"
    assert outcome.error is not None
    assert outcome.error.code == ErrorCode.TIMEOUT
    assert outcome.error.retryable is True
    assert "integrate" in outcome.error.message

    # The timed-out integrate attempt is FAILED (clean checkpoint): no
    # SUCCEEDED integrate attempt exists for the retry to reuse.
    attempts = [
        json.loads(line)
        for line in (
            tmp_path / "state" / spec.build_id / "operation_attempts.jsonl"
        )
        .read_text()
        .splitlines()
    ]
    integrate_attempts = [a for a in attempts if a["operation_id"] == "integrate"]
    assert integrate_attempts and integrate_attempts[-1]["status"] == "failed"

    # (c) A subsequent same-build_id run proceeds cleanly: attempt A's
    # straggler is guaranteed finished before the lock was released, so the
    # retry never overlaps a live late worker; the published artifact
    # reflects only the retry's own inputs (A's late writes did not leak).
    monkeypatch.setattr(expression_runner_module, "integrate", real_integrate)
    new_input = tmp_path / "new_input.tsv"
    new_input.write_text(
        "gene_id\tS1\tS2\nTP53\t9\t10\nBRCA1\t11\t12\n", encoding="utf-8"
    )
    checksum = hashlib.sha256(new_input.read_bytes()).hexdigest()
    new_asset = SourceAsset(
        asset_id=asset_id_from_sha256(checksum),
        kind="source",
        relative_path="source_assets/new_input.tsv",
        sha256=checksum,
        size_bytes=new_input.stat().st_size,
        media_type="text/tab-separated-values",
        source_id="src_binding_gdc",
        successful_attempt_id="attempt_1",
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )
    retry_runner = ExpressionBuildRunner(
        spec=spec,
        registry=registry,
        source_assets={"binding_gdc": new_asset},
        source_paths={"binding_gdc": new_input},
        output_dir=output_dir,
    )
    retry_executor = DatasetBuildExecutor(
        task_id="task_runner",
        build_id=spec.build_id,
        run_id="run_retry_b",
        state_dir=tmp_path / "state" / spec.build_id,
        lock_path=tmp_path / "build.lock",
        task_root=tmp_path,
        plan=plan,
        run_operation=retry_runner,
        source_assets={"binding_gdc": new_asset},
        implementation_versions={op.operation_id: "1.0.0" for op in plan},
    )
    retry = await retry_executor.run()

    assert retry.status == "completed"
    published_values: set[str] = set()
    for version_dir in (output_dir / "publish").glob("build_runner_test_*"):
        with (version_dir / "merged" / "primary.csv").open(encoding="utf-8") as handle:
            rows = list(csv.DictReader(handle))
        published_values.update(row["expression_value"] for row in rows)
    # Only the retry's data was ever published: no fixture value from attempt
    # A (1.5 / 2 / 3 / 4.25) leaked into any publication.
    assert published_values == {"9", "10", "11", "12"}


@pytest.mark.asyncio
async def test_timed_out_worker_beyond_grace_marks_state_dir_and_retry_proceeds(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """K1 residual (Phase 4 review): the straggler wait is BOUNDED — a worker
    that still does not finish within the grace must not block the executor
    forever. The run still returns the timed-out failure, the state dir is
    marked so a retry cannot reuse the unstable workspace, and a subsequent
    same-build_id run (with new inputs) proceeds cleanly and publishes only
    its own data.
    """
    import threading

    from app.datasets.build import expression_runner as expression_runner_module

    real_integrate = expression_runner_module.integrate
    integrate_started = threading.Event()
    release_worker = threading.Event()

    def blocking_integrate(*args, **kwargs):
        integrate_started.set()
        release_worker.wait(10.0)
        return real_integrate(*args, **kwargs)

    monkeypatch.setattr(expression_runner_module, "integrate", blocking_integrate)

    bindings = [_binding("binding_gdc", "gdc", "gdc.expression.v1")]
    spec = _spec(bindings)
    registry = SchemaRegistry([build_gene_expression_schema()])
    output_dir = tmp_path / "build"
    assets = {"binding_gdc": _source_asset("gdc/gdc_expression.tsv", "src_binding_gdc")}
    paths = {"binding_gdc": FIXTURES / "gdc/gdc_expression.tsv"}
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
        run_id="run_timeout_a",
        state_dir=tmp_path / "state" / spec.build_id,
        lock_path=tmp_path / "build.lock",
        task_root=tmp_path,
        plan=plan,
        run_operation=runner,
        source_assets=assets,
        implementation_versions={op.operation_id: "1.0.0" for op in plan},
        operation_timeout=0.5,
        straggler_grace=0.05,
    )
    run_task = asyncio.create_task(executor.run())
    assert await asyncio.to_thread(integrate_started.wait, 5.0), "integrate never started"
    # The straggler grace (0.05s) elapses while the worker is still blocked:
    # the executor returns the timed-out failure WITHOUT waiting for the
    # worker, marks the state dir, and releases the lock.
    outcome = await asyncio.wait_for(run_task, timeout=5.0)
    assert outcome.status == "failed"
    assert outcome.error is not None
    assert outcome.error.code == ErrorCode.TIMEOUT
    marker = tmp_path / "state" / spec.build_id / ".worker_unfinished"
    assert marker.is_file()
    payload = json.loads(marker.read_text("utf-8"))
    assert payload["build_id"] == spec.build_id
    assert payload["operation_id"] == "integrate"

    # The straggler thread is still alive here (it outlived the grace):
    # release it and wait for it to actually finish before the retry so the
    # retry's writes cannot interleave with the late worker's.
    release_worker.set()
    await asyncio.gather(
        *(asyncio.wrap_future(worker) for worker in runner.in_flight_workers()),
        return_exceptions=True,
    )

    # The marker is honored (logged + cleared) by the next run; the retry
    # re-executes the failed integrate (its attempt is FAILED, never
    # reusable) and downstream via the digest closure, publishing only its
    # own data.
    monkeypatch.setattr(expression_runner_module, "integrate", real_integrate)
    new_input = tmp_path / "new_input.tsv"
    new_input.write_text(
        "gene_id\tS1\tS2\nTP53\t9\t10\nBRCA1\t11\t12\n", encoding="utf-8"
    )
    checksum = hashlib.sha256(new_input.read_bytes()).hexdigest()
    new_asset = SourceAsset(
        asset_id=asset_id_from_sha256(checksum),
        kind="source",
        relative_path="source_assets/new_input.tsv",
        sha256=checksum,
        size_bytes=new_input.stat().st_size,
        media_type="text/tab-separated-values",
        source_id="src_binding_gdc",
        successful_attempt_id="attempt_1",
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )
    retry_runner = ExpressionBuildRunner(
        spec=spec,
        registry=registry,
        source_assets={"binding_gdc": new_asset},
        source_paths={"binding_gdc": new_input},
        output_dir=output_dir,
    )
    retry_executor = DatasetBuildExecutor(
        task_id="task_runner",
        build_id=spec.build_id,
        run_id="run_retry_b",
        state_dir=tmp_path / "state" / spec.build_id,
        lock_path=tmp_path / "build.lock",
        task_root=tmp_path,
        plan=plan,
        run_operation=retry_runner,
        source_assets={"binding_gdc": new_asset},
        implementation_versions={op.operation_id: "1.0.0" for op in plan},
    )
    retry = await retry_executor.run()

    assert retry.status == "completed"
    published_values: set[str] = set()
    for version_dir in (output_dir / "publish").glob("build_runner_test_*"):
        with (version_dir / "merged" / "primary.csv").open(encoding="utf-8") as handle:
            rows = list(csv.DictReader(handle))
        published_values.update(row["expression_value"] for row in rows)
    assert published_values == {"9", "10", "11", "12"}


@pytest.mark.asyncio
async def test_grace_expired_straggler_blocks_same_build_retry_until_worker_finishes(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """K1 residual (wave 9): the worker-unfinished marker is a real exclusion.

    A grace-expired straggler is STILL alive (blocked on a test-controlled
    event); a same-build_id retry started while it is alive must not enter
    the plan — it polls the marker until the straggler's finally removes it,
    then proceeds. The retry's publication reflects only its own inputs; the
    straggler's late writes never land in the retry's paths.
    """
    import os
    import threading

    from app.datasets.build import expression_runner as expression_runner_module
    from app.datasets.runtime import executor as executor_module

    real_integrate = expression_runner_module.integrate
    integrate_started = threading.Event()
    release_worker = threading.Event()
    worker_finished = threading.Event()

    def blocking_integrate(*args, **kwargs):
        integrate_started.set()
        release_worker.wait(10.0)
        result = real_integrate(*args, **kwargs)
        worker_finished.set()
        return result

    monkeypatch.setattr(expression_runner_module, "integrate", blocking_integrate)

    bindings = [_binding("binding_gdc", "gdc", "gdc.expression.v1")]
    spec = _spec(bindings)
    registry = SchemaRegistry([build_gene_expression_schema()])
    output_dir = tmp_path / "build"
    assets = {"binding_gdc": _source_asset("gdc/gdc_expression.tsv", "src_binding_gdc")}
    paths = {"binding_gdc": FIXTURES / "gdc/gdc_expression.tsv"}
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
        run_id="run_timeout_a",
        state_dir=tmp_path / "state" / spec.build_id,
        lock_path=tmp_path / "build.lock",
        task_root=tmp_path,
        plan=plan,
        run_operation=runner,
        source_assets=assets,
        implementation_versions={op.operation_id: "1.0.0" for op in plan},
        operation_timeout=0.5,
        straggler_grace=0.05,
    )
    outcome = await executor.run()
    assert outcome.status == "failed"
    assert outcome.error is not None
    assert outcome.error.code == ErrorCode.TIMEOUT
    marker = tmp_path / "state" / spec.build_id / ".worker_unfinished"
    assert marker.is_file()
    marker_payload = json.loads(marker.read_text("utf-8"))
    # Wave 10: the marker carries process + worker identity so a retry can
    # tell a LIVE in-process straggler (same pid + process nonce) from a
    # marker whose owning process is gone (stale).
    assert marker_payload["pid"] == os.getpid()
    assert marker_payload["process_nonce"] == executor_module._PROCESS_NONCE
    assert isinstance(marker_payload["worker_id"], str) and marker_payload["worker_id"]
    # The straggler thread is STILL alive: the executor returned without
    # waiting (grace 0.05s) and the worker is still blocked mid-write. The
    # marker's presence is the authoritative alive signal — its finally
    # (which removes the marker) has not run.
    assert not worker_finished.is_set()

    # A same-build_id retry with new inputs starts WHILE the straggler is
    # alive: the marker is a real exclusion, so the retry must NOT enter the
    # plan (it polls the marker until the straggler's finally removes it).
    monkeypatch.setattr(expression_runner_module, "integrate", real_integrate)
    new_input = tmp_path / "new_input.tsv"
    new_input.write_text(
        "gene_id\tS1\tS2\nTP53\t9\t10\nBRCA1\t11\t12\n", encoding="utf-8"
    )
    checksum = hashlib.sha256(new_input.read_bytes()).hexdigest()
    new_asset = SourceAsset(
        asset_id=asset_id_from_sha256(checksum),
        kind="source",
        relative_path="source_assets/new_input.tsv",
        sha256=checksum,
        size_bytes=new_input.stat().st_size,
        media_type="text/tab-separated-values",
        source_id="src_binding_gdc",
        successful_attempt_id="attempt_1",
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )
    retry_runner = ExpressionBuildRunner(
        spec=spec,
        registry=registry,
        source_assets={"binding_gdc": new_asset},
        source_paths={"binding_gdc": new_input},
        output_dir=output_dir,
    )
    retry_entered = threading.Event()

    async def recording_operation(op, upstream):
        retry_entered.set()
        return await retry_runner.run_operation(op, upstream)

    retry_executor = DatasetBuildExecutor(
        task_id="task_runner",
        build_id=spec.build_id,
        run_id="run_retry_b",
        state_dir=tmp_path / "state" / spec.build_id,
        lock_path=tmp_path / "build.lock",
        task_root=tmp_path,
        plan=plan,
        run_operation=recording_operation,
        source_assets={"binding_gdc": new_asset},
        implementation_versions={op.operation_id: "1.0.0" for op in plan},
        unstable_poll_interval=0.01,
        unstable_poll_cap=5.0,
    )
    retry_task = asyncio.create_task(retry_executor.run())
    # While the straggler is alive the retry stays in its exclusion poll: it
    # does not resolve and never executes an operation.
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(asyncio.shield(retry_task), timeout=0.4)
    assert not retry_entered.is_set(), (
        "retry entered the plan while the straggler was still alive"
    )
    assert marker.is_file()

    # Release the straggler: its finally removes the marker, the retry's poll
    # observes the workspace stabilizing and proceeds to publish its own data.
    release_worker.set()
    retry = await asyncio.wait_for(retry_task, timeout=10.0)
    assert retry.status == "completed"
    assert not marker.exists()
    published_values: set[str] = set()
    for version_dir in (output_dir / "publish").glob("build_runner_test_*"):
        with (version_dir / "merged" / "primary.csv").open(encoding="utf-8") as handle:
            rows = list(csv.DictReader(handle))
        published_values.update(row["expression_value"] for row in rows)
    assert published_values == {"9", "10", "11", "12"}


@pytest.mark.asyncio
async def test_stale_worker_unfinished_marker_ttl_unblocks_retry(
    tmp_path: Path,
) -> None:
    """K1 residual (wave 9): a marker older than the TTL is stale by
    definition (worker threads die with the process) — the retry removes it
    and proceeds, never a permanent block after a crash.
    """
    import os
    import time

    marker = tmp_path / "state" / "build_runner_test" / ".worker_unfinished"
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(
        json.dumps(
            {"build_id": "build_runner_test", "operation_id": "integrate"}
        )
        + "\n",
        "utf-8",
    )
    # mtime far beyond any filesystem timestamp granularity vs. the TTL.
    past = time.time() - 5.0
    os.utime(marker, (past, past))

    bindings = [_binding("binding_gdc", "gdc", "gdc.expression.v1")]
    spec = _spec(bindings)
    registry = SchemaRegistry([build_gene_expression_schema()])
    assets = {"binding_gdc": _source_asset("gdc/gdc_expression.tsv", "src_binding_gdc")}
    paths = {"binding_gdc": FIXTURES / "gdc/gdc_expression.tsv"}
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
        run_id="run_retry_stale",
        state_dir=tmp_path / "state" / spec.build_id,
        lock_path=tmp_path / "build.lock",
        task_root=tmp_path,
        plan=plan,
        run_operation=runner,
        implementation_versions={op.operation_id: "1.0.0" for op in plan},
        unstable_marker_ttl=0.5,
    )
    outcome = await executor.run()

    assert outcome.status == "completed"
    assert not marker.exists()
    assert _primary_rows(output_dir)


@pytest.mark.asyncio
async def test_worker_unfinished_marker_persists_past_poll_cap_returns_retryable_conflict(
    tmp_path: Path,
) -> None:
    """K1 residual (wave 9): when the marker persists beyond the poll cap
    (no straggler finishes), the executor returns a RETRYABLE conflict
    outcome — the workspace is genuinely unstable and no operation runs.
    """
    marker = tmp_path / "state" / "build_runner_test" / ".worker_unfinished"
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(
        json.dumps(
            {"build_id": "build_runner_test", "operation_id": "integrate"}
        )
        + "\n",
        "utf-8",
    )

    bindings = [_binding("binding_gdc", "gdc", "gdc.expression.v1")]
    spec = _spec(bindings)
    registry = SchemaRegistry([build_gene_expression_schema()])
    assets = {"binding_gdc": _source_asset("gdc/gdc_expression.tsv", "src_binding_gdc")}
    paths = {"binding_gdc": FIXTURES / "gdc/gdc_expression.tsv"}
    runner = ExpressionBuildRunner(
        spec=spec,
        registry=registry,
        source_assets=assets,
        source_paths=paths,
        output_dir=tmp_path / "build",
    )
    plan = build_operation_plan(spec)
    executor = DatasetBuildExecutor(
        task_id="task_runner",
        build_id=spec.build_id,
        run_id="run_conflict",
        state_dir=tmp_path / "state" / spec.build_id,
        lock_path=tmp_path / "build.lock",
        task_root=tmp_path,
        plan=plan,
        run_operation=runner,
        implementation_versions={op.operation_id: "1.0.0" for op in plan},
        unstable_poll_interval=0.01,
        unstable_poll_cap=0.3,
    )
    outcome = await executor.run()

    assert outcome.status == "failed"
    assert outcome.error is not None
    assert outcome.error.retryable is True
    assert "unstable" in outcome.error.message
    # The marker is left in place so the next retry re-checks the workspace.
    assert marker.is_file()


@pytest.mark.asyncio
async def test_same_process_marker_persists_past_poll_cap_returns_retryable_conflict(
    tmp_path: Path,
) -> None:
    """K1 residual (wave 10): a marker owned by THIS process (same pid +
    process nonce) means the straggler thread is LIVE in-process — the retry
    polls it and must NEVER auto-delete it (the thread may still be writing
    the build's deterministic paths). When the poll cap expires a retryable
    conflict is returned and the marker is left for the next retry.
    """
    import os

    from app.datasets.runtime import executor as executor_module

    marker = tmp_path / "state" / "build_runner_test" / ".worker_unfinished"
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(
        json.dumps(
            {
                "build_id": "build_runner_test",
                "operation_id": "integrate",
                "pid": os.getpid(),
                "process_nonce": executor_module._PROCESS_NONCE,
                "worker_id": "w_live_ghost",
                "ts": "2026-08-08T00:00:00+00:00",
            }
        )
        + "\n",
        "utf-8",
    )

    bindings = [_binding("binding_gdc", "gdc", "gdc.expression.v1")]
    spec = _spec(bindings)
    registry = SchemaRegistry([build_gene_expression_schema()])
    assets = {"binding_gdc": _source_asset("gdc/gdc_expression.tsv", "src_binding_gdc")}
    paths = {"binding_gdc": FIXTURES / "gdc/gdc_expression.tsv"}
    runner = ExpressionBuildRunner(
        spec=spec,
        registry=registry,
        source_assets=assets,
        source_paths=paths,
        output_dir=tmp_path / "build",
    )
    plan = build_operation_plan(spec)
    executor = DatasetBuildExecutor(
        task_id="task_runner",
        build_id=spec.build_id,
        run_id="run_conflict",
        state_dir=tmp_path / "state" / spec.build_id,
        lock_path=tmp_path / "build.lock",
        task_root=tmp_path,
        plan=plan,
        run_operation=runner,
        implementation_versions={op.operation_id: "1.0.0" for op in plan},
        unstable_poll_interval=0.01,
        unstable_poll_cap=0.3,
    )
    outcome = await executor.run()

    assert outcome.status == "failed"
    assert outcome.error is not None
    assert outcome.error.retryable is True
    assert "unstable" in outcome.error.message
    # A same-process marker is NEVER auto-deleted: the straggler thread is
    # live in this process, so its finally is the only legitimate remover.
    assert marker.is_file()


@pytest.mark.asyncio
async def test_dead_process_marker_removed_and_retry_proceeds(
    tmp_path: Path,
) -> None:
    """K1 residual (wave 10): a marker whose pid/process nonce does not match
    this process means the owning process is gone — its worker threads died
    with it, so the workspace is stable by definition. The retry removes the
    stale marker and proceeds: no permanent block after a crash.
    """
    marker = tmp_path / "state" / "build_runner_test" / ".worker_unfinished"
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(
        json.dumps(
            {
                "build_id": "build_runner_test",
                "operation_id": "integrate",
                "pid": 424242,  # a dead process
                "process_nonce": "deadbeef-dead-beef-4bad-deadbeefdead",
                "worker_id": "w_dead",
                "ts": "2026-08-08T00:00:00+00:00",
            }
        )
        + "\n",
        "utf-8",
    )

    bindings = [_binding("binding_gdc", "gdc", "gdc.expression.v1")]
    spec = _spec(bindings)
    registry = SchemaRegistry([build_gene_expression_schema()])
    assets = {"binding_gdc": _source_asset("gdc/gdc_expression.tsv", "src_binding_gdc")}
    paths = {"binding_gdc": FIXTURES / "gdc/gdc_expression.tsv"}
    runner = ExpressionBuildRunner(
        spec=spec,
        registry=registry,
        source_assets=assets,
        source_paths=paths,
        output_dir=tmp_path / "build",
    )
    plan = build_operation_plan(spec)
    executor = DatasetBuildExecutor(
        task_id="task_runner",
        build_id=spec.build_id,
        run_id="run_retry_dead",
        state_dir=tmp_path / "state" / spec.build_id,
        lock_path=tmp_path / "build.lock",
        task_root=tmp_path,
        plan=plan,
        run_operation=runner,
        implementation_versions={op.operation_id: "1.0.0" for op in plan},
    )
    outcome = await executor.run()

    assert outcome.status == "completed"
    assert not marker.exists()
    assert _primary_rows(tmp_path / "build")


@pytest.mark.asyncio
async def test_worker_resolving_during_grace_does_not_write_orphan_marker(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """K1 residual (wave 10): the orphan-race closure. When the straggler's
    raw future resolves during the grace wait (its finally already ran, so
    any marker it could clean never existed), the executor must NOT write a
    marker: a fresh same-process marker with no live worker would block
    retries up to the poll cap. A subsequent retry proceeds immediately.
    """
    import concurrent.futures

    from app.datasets.runtime import DatasetBuildExecutor as Executor

    pending = concurrent.futures.Future()
    probe_calls = {"count": 0}

    def resolving_during_grace_probe():
        probe_calls["count"] += 1
        if probe_calls["count"] == 1:
            return (pending,)
        # The re-probe after the grace timeout finds nothing in flight: the
        # straggler resolved during the grace wait (worker finally ran).
        return ()

    async def noop_operation(op, upstream):
        raise AssertionError("no operation should run")

    executor = Executor(
        task_id="task_runner",
        build_id="build_runner_test",
        run_id="run_a",
        state_dir=tmp_path / "state" / "build_runner_test",
        lock_path=tmp_path / "build.lock",
        task_root=tmp_path,
        plan=(),
        run_operation=noop_operation,
        straggler_grace=0.05,
    )
    monkeypatch.setattr(
        executor, "_in_flight_worker_futures", resolving_during_grace_probe
    )

    await executor._await_straggler_workers()

    marker = tmp_path / "state" / "build_runner_test" / ".worker_unfinished"
    assert not marker.exists(), "orphan marker written for a resolved worker"
    # A subsequent retry proceeds immediately: no marker blocks it.
    assert await executor._exclude_unstable_workspace() is None


@pytest.mark.asyncio
async def test_marker_dropped_when_worker_resolves_between_probe_and_write(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """K1 residual (wave 10): write-then-verify closure of the marker write.
    If the named worker's future resolves between the executor's probe and
    the atomic marker write (its finally unlinked before the marker existed),
    the marker is dropped immediately — no fresh orphan marker can ever
    block a retry.
    """
    import concurrent.futures

    from app.datasets.runtime import DatasetBuildExecutor as Executor

    pending = concurrent.futures.Future()
    resolved = concurrent.futures.Future()
    resolved.set_result(None)
    probe_calls = {"count": 0}

    def probe():
        probe_calls["count"] += 1
        if probe_calls["count"] == 1:
            return (pending,)
        # The re-probe inside the marker step finds the straggler ALREADY
        # resolved: the worker finished during the grace, just late.
        return (resolved,)

    async def noop_operation(op, upstream):
        raise AssertionError("no operation should run")

    executor = Executor(
        task_id="task_runner",
        build_id="build_runner_test",
        run_id="run_a",
        state_dir=tmp_path / "state" / "build_runner_test",
        lock_path=tmp_path / "build.lock",
        task_root=tmp_path,
        plan=(),
        run_operation=noop_operation,
        straggler_grace=0.05,
    )
    monkeypatch.setattr(executor, "_in_flight_worker_futures", probe)

    await executor._await_straggler_workers()

    marker = tmp_path / "state" / "build_runner_test" / ".worker_unfinished"
    assert not marker.exists(), "marker survived for a worker that already finished"


def test_worker_cleanup_leaves_other_workers_marker_untouched(
    tmp_path: Path,
) -> None:
    """K1 residual (wave 10): a worker's finally read-compares the marker —
    it unlinks ONLY its own marker (``worker_id`` match). A marker written
    for another worker (or absent/corrupt) is left untouched; the executor
    re-checks ownership on the retry side, so a marker for a still-live
    straggler must survive until THAT straggler's finally runs.
    """
    bindings = [_binding("binding_gdc", "gdc", "gdc.expression.v1")]
    spec = _spec(bindings)
    registry = SchemaRegistry([build_gene_expression_schema()])
    assets = {"binding_gdc": _source_asset("gdc/gdc_expression.tsv", "src_binding_gdc")}
    paths = {"binding_gdc": FIXTURES / "gdc/gdc_expression.tsv"}
    runner = ExpressionBuildRunner(
        spec=spec,
        registry=registry,
        source_assets=assets,
        source_paths=paths,
        output_dir=tmp_path / "build",
    )
    marker = tmp_path / "state" / "build_runner_test" / ".worker_unfinished"
    marker.parent.mkdir(parents=True, exist_ok=True)
    runner.set_worker_marker_path(marker)

    # A marker owned by ANOTHER worker is left untouched by this finally.
    marker.write_text(json.dumps({"worker_id": "w_other"}) + "\n", "utf-8")
    runner._cleanup_worker_marker("w_mine")
    assert marker.is_file()

    # This worker's own marker is removed.
    marker.write_text(json.dumps({"worker_id": "w_mine"}) + "\n", "utf-8")
    runner._cleanup_worker_marker("w_mine")
    assert not marker.exists()

    # A corrupt marker is best-effort: no exception, left untouched.
    marker.write_text("{not json\n", "utf-8")
    runner._cleanup_worker_marker("w_mine")
    assert marker.is_file()

    # An absent marker raises nothing.
    marker.unlink()
    runner._cleanup_worker_marker("w_mine")


def test_worker_completion_signal_race_safe_against_interleaved_cancel() -> None:
    """K1 residual (wave 9): a cancellation landing between the done() check
    and set_result() in the worker's finally must not raise
    InvalidStateError (the check-then-act race on the completion future).
    """
    import concurrent.futures

    from app.datasets.build.expression_runner import _complete_worker_future

    completion = concurrent.futures.Future()

    def _done_returns_false() -> bool:
        return False

    # Freeze the guard's view at "not done": the executor's straggler-grace
    # path then cancels the future before the set_result call lands.
    completion.done = _done_returns_false
    completion.cancel()
    _complete_worker_future(completion)
    assert completion.cancelled()


def test_find_latest_publication_normalizes_naive_timestamps(tmp_path: Path) -> None:
    """B8/H5: older publication records may carry naive ISO timestamps;
    mixing naive and timezone-aware values must not raise TypeError, and the
    chronologically-later aware record wins deterministically.
    """
    from app.datasets.build.invariants import find_latest_publication as _find_latest_publication

    publish_dir = tmp_path / "publish"
    records = [
        ("pub_build_x_aaaa", "2026-08-08T00:00:00"),  # naive
        ("pub_build_x_bbbb", "2026-08-08T01:00:00+00:00"),  # aware, later
    ]
    for publication_id, published_at in records:
        version_dir = publish_dir / publication_id.removeprefix("pub_build_x_")
        version_dir.mkdir(parents=True)
        (version_dir / "publication.json").write_text(
            json.dumps(
                {"publication_id": publication_id, "published_at": published_at}
            ),
            "utf-8",
        )

    assert _find_latest_publication(publish_dir) == "pub_build_x_bbbb"


@pytest.mark.asyncio
async def test_publish_refuses_when_pending_check_flips_after_validation(
    tmp_path: Path,
) -> None:
    """D1/H2: the publish operation rechecks a pending-input gate immediately
    before the immutable promotion — a correction that became pending between
    validation and publish refuses the version dir and surfaces the refusal
    as the outcome error (never a silent promotion).
    """
    from app.datasets.build.expression_runner import _PUBLICATION_REFUSED_PREFIX
    from app.datasets.runtime import OperationKind

    pending = {"value": False}
    bindings = [_binding("binding_gdc", "gdc", "gdc.expression.v1")]
    spec = _spec(bindings)
    registry = SchemaRegistry([build_gene_expression_schema()])
    assets = {"binding_gdc": _source_asset("gdc/gdc_expression.tsv", "src_binding_gdc")}
    paths = {"binding_gdc": FIXTURES / "gdc/gdc_expression.tsv"}
    runner = ExpressionBuildRunner(
        spec=spec,
        registry=registry,
        source_assets=assets,
        source_paths=paths,
        output_dir=tmp_path,
        pending_check=lambda: pending["value"],
    )

    async def wrapped(op, upstream):
        result = await runner.run_operation(op, upstream)
        if op.kind is OperationKind.VALIDATE_PROFILE:
            pending["value"] = True
        return result

    plan = build_operation_plan(spec)
    executor = DatasetBuildExecutor(
        task_id="task_runner",
        build_id=spec.build_id,
        run_id="run_runner",
        state_dir=tmp_path / "state" / spec.build_id,
        lock_path=tmp_path / "build.lock",
        task_root=tmp_path,
        plan=plan,
        run_operation=wrapped,
        implementation_versions={op.operation_id: "1.0.0" for op in plan},
    )
    outcome = await executor.run()

    assert outcome.status == "failed"
    assert outcome.error is not None
    assert outcome.error.message.startswith(_PUBLICATION_REFUSED_PREFIX)
    assert not list((tmp_path / "publish").glob("build_runner_test_*"))
    # No stray staged directory survives the refusal.
    assert not list((tmp_path / "publish").glob(".*.tmp"))


@pytest.mark.asyncio
async def test_failed_outcome_carries_structured_no_data_reason(
    tmp_path: Path,
) -> None:
    """H3: an empty source surfaces a structured reason_code in the outcome
    error details (no substring matching at the tool boundary).
    """
    header_only = tmp_path / "empty.tsv"
    header_only.write_text("gene_id\tS1\tS2\n", encoding="utf-8")
    bindings = [_binding("binding_gdc", "gdc", "gdc.expression.v1")]
    spec = _spec(bindings)
    registry = SchemaRegistry([build_gene_expression_schema()])
    checksum = hashlib.sha256(header_only.read_bytes()).hexdigest()
    asset = SourceAsset(
        asset_id=asset_id_from_sha256(checksum),
        kind="source",
        relative_path="source_assets/empty.tsv",
        sha256=checksum,
        size_bytes=header_only.stat().st_size,
        media_type="text/tab-separated-values",
        source_id="src_binding_gdc",
        successful_attempt_id="attempt_1",
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )
    runner = ExpressionBuildRunner(
        spec=spec,
        registry=registry,
        source_assets={"binding_gdc": asset},
        source_paths={"binding_gdc": header_only},
        output_dir=tmp_path,
    )
    plan = build_operation_plan(spec)
    executor = DatasetBuildExecutor(
        task_id="task_runner",
        build_id=spec.build_id,
        run_id="run_runner",
        state_dir=tmp_path / "state" / spec.build_id,
        lock_path=tmp_path / "build.lock",
        task_root=tmp_path,
        plan=plan,
        run_operation=runner,
        implementation_versions={op.operation_id: "1.0.0" for op in plan},
    )
    outcome = await executor.run()

    assert outcome.status == "failed"
    assert outcome.error is not None
    assert outcome.error.details.get("reason_code") == "no_primary_data"
    assert outcome.error.details.get("failed_operation") == "parse:binding_gdc"


def test_runner_forwards_binding_adapter_params_to_geo_adapter(
    tmp_path: Path,
) -> None:
    """Phase 5 D1: run_operation forwards binding.parameters to adapter.parse.

    The GEO adapter receives the typed ``AdapterParams``; the parsed batch
    must reflect the declared format/semantics/scale/unit — proving the
    parameters flow through the runner (never inferred from the file name).
    """
    import gzip as gzip_module

    matrix = tmp_path / "GSE1_series_matrix.txt.gz"
    text = (
        "!series_matrix_table_begin\n"
        "\"ID_REF\"\t\"GSM1\"\t\"GSM2\"\n"
        "\"AFFX-BioB-5\"\t1.5\t2.0\n"
        "!series_matrix_table_end\n"
    )
    with gzip_module.open(matrix, "wt", encoding="utf-8") as handle:
        handle.write(text)

    binding = SourceBinding(
        binding_id="binding_geo",
        source="geo",
        acquisition=SourceBindingAcquisition(
            mode=AcquisitionMode.BUILTIN, provider_id="geo.series.v1"
        ),
        adapter_id="geo.expression.v1",
        accession="GSE1",
        parameters=AdapterParams(
            format="series_matrix",
            value_semantics="normalized_expression_value",
            value_scale=ValueScale.LOG2,
            expression_unit="normalized_expression_value",
            platform_ids=["GPL570"],
        ).model_dump(mode="json"),
    )
    spec = _spec([binding])
    registry = SchemaRegistry([build_gene_expression_schema()])
    checksum = hashlib.sha256(matrix.read_bytes()).hexdigest()
    asset = SourceAsset(
        asset_id=asset_id_from_sha256(checksum),
        kind="source",
        relative_path="source_assets/series.txt.gz",
        sha256=checksum,
        size_bytes=matrix.stat().st_size,
        media_type="text/tab-separated-values",
        source_id="src_binding_geo",
        successful_attempt_id="attempt_1",
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )
    runner = ExpressionBuildRunner(
        spec=spec,
        registry=registry,
        source_assets={"binding_geo": asset},
        source_paths={"binding_geo": matrix},
        output_dir=tmp_path,
    )
    parse_op = OperationSpec(
        operation_id="parse:binding_geo",
        kind=OperationKind.PARSE,
        label="解析 geo",
        category="binding_geo",
        upstream=("acquire:binding_geo",),
    )
    output = asyncio.run(runner.run_operation(parse_op, {}))
    assert output.output["batch_id"] == "batch_binding_geo"

    batch = runner._batches["binding_geo"]
    assert batch.parser_id == "geo.expression.v1"
    assert batch.statistics["format"] == "series_matrix"
    assert batch.statistics["value_semantics"] == "normalized_expression_value"
    assert batch.statistics["value_scale"] == "log2"
    assert batch.statistics["expression_unit"] == "normalized_expression_value"
    rows = (tmp_path / batch.file_asset.relative_path).read_text().splitlines()[1:]
    assert len(rows) == 2
    assert all(",geo_probe," in row for row in rows)
    assert all(",log2," in row for row in rows)
