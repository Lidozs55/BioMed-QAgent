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

    from app.datasets.build.expression_runner import _find_latest_publication

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

    from app.datasets.build.expression_runner import _find_latest_publication

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

    from app.datasets.build.expression_runner import _find_latest_publication

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


def test_find_latest_publication_normalizes_naive_timestamps(tmp_path: Path) -> None:
    """B8/H5: older publication records may carry naive ISO timestamps;
    mixing naive and timezone-aware values must not raise TypeError, and the
    chronologically-later aware record wins deterministically.
    """
    from app.datasets.build.expression_runner import _find_latest_publication

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
