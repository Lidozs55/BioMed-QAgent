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
