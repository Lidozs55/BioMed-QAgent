"""execute_dataset_build V2 tool tests (Phase 2: PipelineRunner -> Legacy)."""

from __future__ import annotations

import asyncio
import json
import shutil
from pathlib import Path

import pytest
from agents.tool_context import ToolContext
from app.agent_loop.context import RunContext
from app.agent_loop.main_input_broker import MainInputBroker
from app.pipeline.dataset_build_tool import execute_dataset_build
from app.tools.workdir import create_task_workdir

FIXTURES = Path(__file__).parent / "fixtures"


def _spec_json(binding_id: str = "binding_gdc", adapter_id: str = "gdc.expression.v1") -> str:
    return json.dumps({
        "build_id": "build_tool_test",
        "objective": "compare TP53 expression",
        "dataset_family": "gene_expression",
        "row_granularity": "gene_sample_measurement",
        "schema_ref": "gene_expression.long.v1",
        "source_bindings": [
            {
                "binding_id": binding_id,
                "source": "gdc",
                "acquisition": {"mode": "builtin", "provider_id": "gdc.v1"},
                "adapter_id": adapter_id,
            }
        ],
        "merge_strategy": "append_by_canonical_row",
        "validation_profile_ref": "gene_expression.release.v1",
        "normalization_profile_ref": "gene_expression.normalization.v1",
    })


def _mixed_spec_json() -> str:
    """A two-binding spec: empty-capable GDC binding plus a Xena binding."""
    return json.dumps({
        "build_id": "build_tool_test",
        "objective": "compare TP53 expression",
        "dataset_family": "gene_expression",
        "row_granularity": "gene_sample_measurement",
        "schema_ref": "gene_expression.long.v1",
        "source_bindings": [
            {
                "binding_id": "binding_gdc",
                "source": "gdc",
                "acquisition": {"mode": "builtin", "provider_id": "gdc.v1"},
                "adapter_id": "gdc.expression.v1",
            },
            {
                "binding_id": "binding_xena",
                "source": "ucsc_xena",
                "acquisition": {
                    "mode": "builtin",
                    "provider_id": "ucsc_xena.v1",
                },
                "adapter_id": "xena.matrix.v1",
            },
        ],
        "merge_strategy": "append_by_canonical_row",
        "validation_profile_ref": "gene_expression.release.v1",
        "normalization_profile_ref": "gene_expression.normalization.v1",
    })


def _spec_with_build_id(build_id: str) -> str:
    spec = json.loads(_spec_json())
    spec["build_id"] = build_id
    return json.dumps(spec)


def _make_ctx(tmp_path: Path, task_id: str = "test_build_tool") -> ToolContext:
    rc = RunContext(task_id=task_id)
    rc._work_dir = create_task_workdir(task_id, base_dir=str(tmp_path))
    return ToolContext(
        context=rc,
        tool_name="execute_dataset_build",
        tool_call_id="test_call",
        tool_arguments="{}",
    )


def _stage_fixture(run_ctx: RunContext, fixture_rel: str, dest_name: str) -> str:
    dest = run_ctx.work_dir.source_asset_file(dest_name)
    shutil.copy(FIXTURES / fixture_rel, dest)
    return f"source_assets/{dest_name}"


def _call_tool(ctx: ToolContext, spec: str, source_files: str) -> dict[str, object]:
    args = json.dumps({"spec": spec, "source_files": source_files})
    result = asyncio.run(execute_dataset_build.on_invoke_tool(ctx, args))
    return json.loads(result)


def test_execute_dataset_build_succeeds(tmp_path: Path) -> None:
    """A valid spec + staged source file publishes a build and returns BuildResult."""
    ctx = _make_ctx(tmp_path)
    run_ctx: RunContext = ctx.context
    rel = _stage_fixture(run_ctx, "gdc/gdc_expression.tsv", "gdc_expression.tsv")

    data = _call_tool(ctx, _spec_json(), json.dumps({"binding_gdc": rel}))

    assert data["status"] == "ok"
    result = data["result"]
    assert result["status"] == "succeeded"
    assert result["publication_id"]
    assert result["valid_row_count"] == 4
    assert result["successful_sources"] == ["binding_gdc"]

    # V2 dataset cache entry committed with the published build.
    cache_entry = data["cache_entry"]
    assert cache_entry is not None
    assert cache_entry["namespace"] == "build"
    assert cache_entry["dataset_family"] == "gene_expression"
    assert cache_entry["row_count"] == 4

    # Immutable version directory with a publication record.
    output_dir = Path(data["output_dir"])
    publish_dirs = list((output_dir / "publish").glob("build_tool_test_*"))
    assert len(publish_dirs) == 1
    publication = json.loads(
        (publish_dirs[0] / "publication.json").read_text("utf-8")
    )
    assert publication["publication_id"] == result["publication_id"]
    assert publication["supersedes_publication_id"] is None


def test_execute_dataset_build_invalid_spec(tmp_path: Path) -> None:
    """Malformed spec JSON returns invalid_input."""
    ctx = _make_ctx(tmp_path)
    data = _call_tool(ctx, "not json", "{}")
    assert data["status"] == "invalid_input"


def test_execute_dataset_build_missing_binding_file(tmp_path: Path) -> None:
    """A source_files entry that does not resolve returns a retryable error."""
    ctx = _make_ctx(tmp_path)
    run_ctx: RunContext = ctx.context
    _stage_fixture(run_ctx, "gdc/gdc_expression.tsv", "gdc_expression.tsv")

    data = _call_tool(
        ctx, _spec_json(), json.dumps({"binding_gdc": "source_assets/nope.tsv"})
    )
    assert data["status"] == "error"
    assert data["retryable"] is True


def test_execute_dataset_build_rejects_path_like_build_id(tmp_path: Path) -> None:
    """A path-like build_id is rejected before any output directory is created."""
    ctx = _make_ctx(tmp_path)
    run_ctx: RunContext = ctx.context
    rel = _stage_fixture(run_ctx, "gdc/gdc_expression.tsv", "gdc_expression.tsv")

    data = _call_tool(
        ctx, _spec_json(), json.dumps({"binding_gdc": rel})
    )
    assert data["status"] == "ok"  # sanity: the valid baseline still works

    escape_target = tmp_path / "published-by-agent"
    escaped_spec = json.loads(_spec_json())
    escaped_spec["build_id"] = str(escape_target)
    data = _call_tool(ctx, json.dumps(escaped_spec), json.dumps({"binding_gdc": rel}))
    assert data["status"] == "invalid_input"
    assert not escape_target.exists()
    # Nothing escaped the task work directory: the escaped build_id never
    # became a child of the task-local build workspace.
    task_builds = run_ctx.work_dir.root / "datasets_build"
    assert "published-by-agent" not in [p.name for p in task_builds.iterdir()]


def test_execute_dataset_build_rejects_path_like_binding_id(tmp_path: Path) -> None:
    """A path-like binding_id is rejected before filename interpolation."""
    ctx = _make_ctx(tmp_path)

    escaped_spec = json.loads(_spec_json(binding_id="../../escape"))
    data = _call_tool(ctx, json.dumps(escaped_spec), json.dumps({}))
    assert data["status"] == "invalid_input"


def test_build_output_guard_blocks_workspace_escape(tmp_path: Path) -> None:
    """Defense in depth: the path-construction guard rejects any escape."""
    from app.pipeline.dataset_build_tool import _ensure_build_output_inside

    build_root = tmp_path / "builds"
    build_root.mkdir(parents=True)
    with pytest.raises(ValueError, match="inside the build workspace"):
        _ensure_build_output_inside(build_root, "/tmp/outside")
    with pytest.raises(ValueError, match="inside the build workspace"):
        _ensure_build_output_inside(build_root, "../escape")
    contained = _ensure_build_output_inside(build_root, "build_ok_1")
    assert contained == build_root / "build_ok_1"


def test_execute_dataset_build_is_cancellation_aware(tmp_path: Path) -> None:
    """D2: a pre-cancelled Run must not publish; the tool passes the token.

    The executor must observe ``RunContext.cancellation_requested`` so a
    cancelled run returns a cancelled outcome instead of continuing through
    validation/publish.
    """
    ctx = _make_ctx(tmp_path)
    run_ctx: RunContext = ctx.context
    rel = _stage_fixture(run_ctx, "gdc/gdc_expression.tsv", "gdc_expression.tsv")

    # Cancel before the build starts.
    run_ctx.cancellation_requested.set()

    data = _call_tool(ctx, _spec_json(), json.dumps({"binding_gdc": rel}))

    assert data["status"] != "ok"
    build_root = run_ctx.work_dir.root / "datasets_build"
    publish_dirs = list((build_root / "build_tool_test" / "publish").glob("build_tool_test_*"))
    assert publish_dirs == []


def test_execute_dataset_build_header_only_source_is_no_data(tmp_path: Path) -> None:
    """B5: an empty (header-only) source is a structured NO_DATA outcome, not a
    retryable execution error: result.status == no_data, valid_row_count == 0,
    no primary publication.
    """
    ctx = _make_ctx(tmp_path)
    run_ctx: RunContext = ctx.context
    dest = run_ctx.work_dir.source_asset_file("header_only.tsv")
    dest.write_text("gene_id\tS1\tS2\n", encoding="utf-8")
    rel = "source_assets/header_only.tsv"

    data = _call_tool(ctx, _spec_json(), json.dumps({"binding_gdc": rel}))

    assert data["status"] == "ok"
    assert data.get("retryable") is not True
    result = data["result"]
    assert result["status"] == "no_data"
    assert result["valid_row_count"] == 0
    assert result["reason_codes"] == ["no_primary_data"]
    assert result.get("publication_id") is None

    # No primary publication exists.
    build_root = run_ctx.work_dir.root / "datasets_build"
    publish_dirs = list((build_root / "build_tool_test" / "publish").glob("build_tool_test_*"))
    assert publish_dirs == []
    assert not (build_root / "build_tool_test" / "merged" / "primary.csv").exists()


class _RecordingBrokerHooks:
    """Record emits + submitter installs for a live MainInputBroker."""

    def __init__(self) -> None:
        self.emitted: list[object] = []
        self.submitters: list[object] = []

    async def emit(self, payload: object) -> None:
        self.emitted.append(payload)

    def install(self, submitter) -> None:
        self.submitters.append(submitter)

    def clear(self, submitter) -> None:
        self.submitters = [s for s in self.submitters if s is not submitter]


def _pending_broker(run_ctx: RunContext) -> MainInputBroker:
    hooks = _RecordingBrokerHooks()
    broker = MainInputBroker(
        run_id=run_ctx.managed_run_id or "run_d1",
        fixture=False,
        emit=hooks.emit,
        install_user_input_submitter=hooks.install,
        clear_user_input_submitter=hooks.clear,
        cancellation_requested=run_ctx.cancellation_requested,
    )
    run_ctx.bind_main_input_broker(broker)
    return broker


@pytest.mark.asyncio
async def test_execute_dataset_build_refuses_while_main_input_pending(
    tmp_path: Path,
) -> None:
    """D1: execute_dataset_build must refuse while request_human_correction is
    pending (a concurrent HIL pause is an exclusivity boundary), so no
    publication can be produced from inputs under correction.
    """
    ctx = _make_ctx(tmp_path)
    run_ctx: RunContext = ctx.context
    rel = _stage_fixture(run_ctx, "gdc/gdc_expression.tsv", "gdc_expression.tsv")
    broker = _pending_broker(run_ctx)
    pending = asyncio.create_task(
        broker.request_input(summary="请修正数据源", detail={"field": "x"})
    )
    try:
        for _ in range(100):
            if run_ctx.main_input_pending:
                break
            await asyncio.sleep(0.01)
        assert run_ctx.main_input_pending

        args = json.dumps(
            {"spec": _spec_json(), "source_files": json.dumps({"binding_gdc": rel})}
        )
        data = json.loads(await execute_dataset_build.on_invoke_tool(ctx, args))

        assert data["status"] == "error"
        assert data["retryable"] is False
        assert "人工修正" in data["message"]
        # No build output or publication may be produced.
        build_root = run_ctx.work_dir.root / "datasets_build"
        publish_dirs = list(
            (build_root / "build_tool_test" / "publish").glob("build_tool_test_*")
        )
        assert publish_dirs == []
    finally:
        pending.cancel()
        await asyncio.gather(pending, return_exceptions=True)


@pytest.mark.asyncio
async def test_execute_dataset_build_proceeds_without_pending_main_input(
    tmp_path: Path,
) -> None:
    """D1 happy path: with a broker installed but no pending correction, the
    build proceeds and publishes normally.
    """
    ctx = _make_ctx(tmp_path)
    run_ctx: RunContext = ctx.context
    rel = _stage_fixture(run_ctx, "gdc/gdc_expression.tsv", "gdc_expression.tsv")
    _pending_broker(run_ctx)
    assert run_ctx.main_input_pending is False

    args = json.dumps(
        {"spec": _spec_json(), "source_files": json.dumps({"binding_gdc": rel})}
    )
    data = json.loads(await execute_dataset_build.on_invoke_tool(ctx, args))

    assert data["status"] == "ok"
    assert data["result"]["status"] == "succeeded"
    assert data["result"]["publication_id"]


def test_no_data_classification_is_scoped_to_current_attempt(
    tmp_path: Path,
) -> None:
    """H3: NO_DATA is attempt-scoped — a stale zero-row manifest from an
    earlier attempt must not classify a later genuine failure as NO_DATA, and
    a later attempt with data succeeds normally.
    """
    ctx = _make_ctx(tmp_path)
    run_ctx: RunContext = ctx.context

    # Attempt A: a source that parses but yields zero valid rows produces a
    # zero-row manifest and a NO_DATA envelope (the manifest is THIS attempt's).
    all_invalid = run_ctx.work_dir.source_asset_file("all_invalid.tsv")
    all_invalid.write_text(
        "gene_id\tS1\tS2\nTP53\ta\tb\nBRCA1\tc\td\n", encoding="utf-8"
    )
    data_a = _call_tool(
        ctx, _spec_json(), json.dumps({"binding_gdc": "source_assets/all_invalid.tsv"})
    )
    assert data_a["status"] == "ok"
    assert data_a["result"]["status"] == "no_data"
    assert (
        run_ctx.work_dir.root
        / "datasets_build"
        / "build_tool_test"
        / "dataset_manifest.json"
    ).is_file()

    # Attempt B: a genuine parse failure (malformed row) on the same build_id
    # must NOT be misclassified as NO_DATA because of the stale zero-row
    # manifest left by attempt A.
    bad_row = run_ctx.work_dir.source_asset_file("bad_row.tsv")
    bad_row.write_text("gene_id\tS1\tS2\nTP53\t1\t2\nmalformed\n", encoding="utf-8")
    data_b = _call_tool(
        ctx, _spec_json(), json.dumps({"binding_gdc": "source_assets/bad_row.tsv"})
    )
    assert data_b["status"] == "error"
    assert data_b["retryable"] is True

    # Attempt C: real data succeeds and publishes.
    rel = _stage_fixture(run_ctx, "gdc/gdc_expression.tsv", "gdc_expression.tsv")
    data_c = _call_tool(ctx, _spec_json(), json.dumps({"binding_gdc": rel}))
    assert data_c["status"] == "ok"
    assert data_c["result"]["status"] == "succeeded"
    assert data_c["result"]["publication_id"]


def test_execute_dataset_build_mixed_empty_and_usable_sources_is_no_data_not_partial_success(
    tmp_path: Path,
) -> None:
    """B5/K2: a mixed-source build (one empty + one usable) where the plan
    aborts at the first empty source must NOT emit a contract-incoherent
    zero-row/no-publication PARTIAL_SUCCESS (ARCHITECTURE §9.2 defines
    PARTIAL_SUCCESS as remaining valid sources validated and publishable,
    which this build never did). The contract-coherent outcome is a
    structured NO_DATA envelope whose reason codes identify the empty
    binding; it is not retryable.
    """
    ctx = _make_ctx(tmp_path)
    run_ctx: RunContext = ctx.context
    empty = run_ctx.work_dir.source_asset_file("empty.tsv")
    empty.write_text("gene_id\tS1\tS2\n", encoding="utf-8")
    xena_rel = _stage_fixture(run_ctx, "ncbi/gse178352/xena_matrix.tsv", "xena.tsv")

    data = _call_tool(
        ctx,
        _mixed_spec_json(),
        json.dumps(
            {
                "binding_gdc": "source_assets/empty.tsv",
                "binding_xena": xena_rel,
            }
        ),
    )

    assert data["status"] == "ok"
    result = data["result"]
    # NOT the previous zero-row/no-publication PARTIAL_SUCCESS envelope.
    assert result["status"] != "partial_success"
    assert result["status"] == "no_data"
    assert result["valid_row_count"] == 0
    assert result["successful_sources"] == []
    assert result["rejected_sources"] == ["binding_gdc"]
    # The reason codes identify the empty binding(s), not just the generic
    # code — the usable source was never parsed/validated/published.
    assert result["reason_codes"] == ["no_primary_data:binding_gdc"]
    assert result.get("publication_id") is None
    assert data.get("retryable") is not True

    build_root = run_ctx.work_dir.root / "datasets_build"
    publish_dirs = list((build_root / "build_tool_test" / "publish").glob("build_tool_test_*"))
    assert publish_dirs == []


def test_execute_dataset_build_all_empty_mixed_sources_is_no_data(tmp_path: Path) -> None:
    """B5/K2 regression: when every source is empty the mixed build keeps the
    established all-empty NO_DATA envelope (generic reason code, all sources
    rejected) — the per-binding codes are only for the mixed abort case.
    """
    ctx = _make_ctx(tmp_path)
    run_ctx: RunContext = ctx.context
    empty_gdc = run_ctx.work_dir.source_asset_file("empty_gdc.tsv")
    empty_gdc.write_text("gene_id\tS1\tS2\n", encoding="utf-8")
    empty_xena = run_ctx.work_dir.source_asset_file("empty_xena.tsv")
    empty_xena.write_text("gene_id\tS1\tS2\n", encoding="utf-8")

    data = _call_tool(
        ctx,
        _mixed_spec_json(),
        json.dumps(
            {
                "binding_gdc": "source_assets/empty_gdc.tsv",
                "binding_xena": "source_assets/empty_xena.tsv",
            }
        ),
    )

    assert data["status"] == "ok"
    result = data["result"]
    assert result["status"] == "no_data"
    assert result["valid_row_count"] == 0
    assert result["successful_sources"] == []
    assert result["rejected_sources"] == ["binding_gdc", "binding_xena"]
    assert result["reason_codes"] == ["no_primary_data"]
    assert result.get("publication_id") is None


@pytest.mark.asyncio
async def test_execute_dataset_build_refuses_publication_when_correction_pending_mid_build(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """D1/H2: the entry gate is a point-in-time check; a correction that
    becomes pending between validation and publication must still refuse the
    immutable promotion — no version dir / publication.json is created and
    the tool returns the agent-facing refusal envelope.
    """
    from app.datasets.build.expression_runner import ExpressionBuildRunner

    ctx = _make_ctx(tmp_path)
    run_ctx: RunContext = ctx.context
    rel = _stage_fixture(run_ctx, "gdc/gdc_expression.tsv", "gdc_expression.tsv")
    broker = _pending_broker(run_ctx)

    release = asyncio.Event()
    reached_hold = asyncio.Event()
    real_validate = ExpressionBuildRunner._validate_profile

    async def held_validate(self, op, upstream):
        result = await real_validate(self, op, upstream)
        reached_hold.set()
        await release.wait()
        return result

    monkeypatch.setattr(ExpressionBuildRunner, "_validate_profile", held_validate)

    args = json.dumps(
        {"spec": _spec_json(), "source_files": json.dumps({"binding_gdc": rel})}
    )
    build_task = asyncio.create_task(execute_dataset_build.on_invoke_tool(ctx, args))
    pending_task: asyncio.Task | None = None
    try:
        await asyncio.wait_for(reached_hold.wait(), timeout=5)
        # A correction becomes pending now — between validation and publish.
        pending_task = asyncio.create_task(
            broker.request_input(summary="请修正数据源", detail={"field": "x"})
        )
        for _ in range(100):
            if run_ctx.main_input_pending:
                break
            await asyncio.sleep(0.01)
        assert run_ctx.main_input_pending
        release.set()
        data = json.loads(await asyncio.wait_for(build_task, timeout=10))

        assert data["status"] == "error"
        assert data["retryable"] is False
        assert "人工修正" in data["message"]
        build_root = run_ctx.work_dir.root / "datasets_build"
        publish_dir = build_root / "build_tool_test" / "publish"
        assert list(publish_dir.glob("build_tool_test_*")) == []
        assert not (publish_dir / "publication.json").exists()
    finally:
        release.set()
        if pending_task is not None:
            pending_task.cancel()
            await asyncio.gather(pending_task, return_exceptions=True)
        if not build_task.done():
            build_task.cancel()
            await asyncio.gather(build_task, return_exceptions=True)


def test_tool_returns_retryable_error_on_unstable_workspace(
    tmp_path: Path, monkeypatch
) -> None:
    """K1 residual (wave 9): the tool maps the executor's unstable-workspace
    conflict to the retryable error envelope — a same-build retry cannot
    reuse a workspace whose previous worker is still running (the marker
    persisted beyond the poll cap). Uses short poll params so the test is
    fast; the marker itself is written directly (no live straggler needed).
    """
    import json

    from app.datasets.runtime import DatasetBuildExecutor

    orig_init = DatasetBuildExecutor.__init__

    def fast_poll_init(self, **kwargs):
        kwargs.setdefault("unstable_poll_interval", 0.01)
        kwargs.setdefault("unstable_poll_cap", 0.3)
        orig_init(self, **kwargs)

    monkeypatch.setattr(DatasetBuildExecutor, "__init__", fast_poll_init)

    ctx = _make_ctx(tmp_path)
    run_ctx: RunContext = ctx.context
    rel = _stage_fixture(run_ctx, "gdc/gdc_expression.tsv", "gdc_expression.tsv")

    marker = (
        run_ctx.work_dir.root
        / "datasets_build"
        / "state"
        / "build_tool_test"
        / ".worker_unfinished"
    )
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(
        json.dumps({"build_id": "build_tool_test"}) + "\n", "utf-8"
    )

    data = _call_tool(ctx, _spec_json(), json.dumps({"binding_gdc": rel}))

    assert data["status"] == "error"
    assert data["retryable"] is True
    assert "unstable" in data["message"]
    # The marker persists so a later retry can re-check the workspace.
    assert marker.is_file()


def test_execute_dataset_build_rejects_path_traversal_build_id(tmp_path: Path) -> None:
    """build_id becomes a directory name; path separators must be rejected."""
    ctx = _make_ctx(tmp_path)
    for evil in ("../escape", "a/b", "..", "a b", ".hidden"):
        data = _call_tool(ctx, _spec_with_build_id(evil), "{}")
        assert data["status"] == "invalid_input", evil
        assert data["retryable"] is False, evil

