"""execute_dataset_build V2 tool tests (Phase 2: PipelineRunner -> Legacy)."""

from __future__ import annotations

import asyncio
import json
import shutil
from pathlib import Path

import pytest
from agents.tool_context import ToolContext
from app.agent_loop.context import RunContext
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
