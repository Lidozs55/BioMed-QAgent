"""A2d: WORKFLOW_RECIPE acquisition dispatch tests (P2 plan Task 7).

A ``workflow_recipe`` SourceBinding must be acquired by replaying a pinned
PROMOTED recipe through :class:`WorkflowRecipeSourceFetcher` instead of
requiring an agent-pre-downloaded file in ``source_files``. The fetched
SourceAsset and its real DownloadAttempt join the build exactly like a
pre-acquired file; acquisition failures reject the binding through the
existing ``per_binding_outcomes`` mechanism so the BuildResult reports it
under ``rejected_sources``.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import shutil
from datetime import UTC, datetime
from pathlib import Path

import app.pipeline.dataset_build_tool as build_tool_module
import pytest
from agents.tool_context import ToolContext
from app.agent_loop.context import RunContext
from app.domain.contracts import (
    DataLevel,
    DownloadAttempt,
    DownloadStatus,
    SourceAsset,
    asset_id_from_sha256,
    generate_prefixed_uuid,
)
from app.recipes.executor import RecipeExecutionResult
from app.subagents.staging import SubagentStagingWorkspace
from app.tools.workdir import create_task_workdir

FIXTURES = Path(__file__).parent / "fixtures"


def _make_ctx(tmp_path: Path, task_id: str = "test_build_tool") -> ToolContext:
    rc = RunContext(task_id=task_id)
    rc._work_dir = create_task_workdir(task_id, base_dir=str(tmp_path))
    return ToolContext(
        context=rc,
        tool_name="execute_dataset_build",
        tool_call_id="test_call",
        tool_arguments="{}",
    )


def _recipe_spec_json(
    binding_id: str = "binding_recipe",
    *,
    builtin_binding: bool = False,
) -> str:
    """A spec with one WORKFLOW_RECIPE binding (optionally plus one builtin)."""

    bindings = [
        {
            "binding_id": binding_id,
            "source": "gdc",
            "acquisition": {
                "mode": "workflow_recipe",
                "recipe_id": "gdc_expression_release",
                "recipe_version": 3,
            },
            "adapter_id": "gdc.expression.v1",
        }
    ]
    if builtin_binding:
        bindings.append(
            {
                "binding_id": "binding_gdc",
                "source": "gdc",
                "acquisition": {"mode": "builtin", "provider_id": "gdc.v1"},
                "adapter_id": "gdc.expression.v1",
            }
        )
    return json.dumps({
        "build_id": "build_recipe_test",
        "objective": "compare TP53 expression",
        "dataset_family": "gene_expression",
        "row_granularity": "gene_sample_measurement",
        "schema_ref": "gene_expression.long.v1",
        "source_bindings": bindings,
        "merge_strategy": "append_by_canonical_row",
        "validation_profile_ref": "gene_expression.release.v1",
        "normalization_profile_ref": "gene_expression.normalization.v1",
    })


class FakeWorkflowRecipeSourceFetcher:
    """Deterministic fetcher stand-in returning a real staged SourceAsset."""

    def __init__(
        self,
        run_ctx: RunContext,
        *,
        error: Exception | None = None,
    ) -> None:
        self._run_ctx = run_ctx
        self._error = error
        self.calls: list[tuple[object, object]] = []

    async def fetch(
        self,
        *,
        binding: object,
        workspace: SubagentStagingWorkspace,
    ) -> RecipeExecutionResult:
        self.calls.append((binding, workspace))
        if self._error is not None:
            raise self._error
        # Stage a real GDC fixture at the content-addressed commit path.
        source_path = FIXTURES / "gdc" / "gdc_expression.tsv"
        checksum = hashlib.sha256(source_path.read_bytes()).hexdigest()
        asset_id = asset_id_from_sha256(checksum)
        relative = f"source_assets/{asset_id}/gdc_expression.tsv"
        dest = self._run_ctx.work_dir.root / relative
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(source_path, dest)
        attempt = DownloadAttempt(
            attempt_id=generate_prefixed_uuid("download_attempt"),
            source_id="gdc",
            url="recipe://gdc_expression_release@3",
            status=DownloadStatus.SUCCEEDED,
            bytes_received=source_path.stat().st_size,
            started_at=datetime.now(UTC),
            finished_at=datetime.now(UTC),
        )
        asset = SourceAsset(
            asset_id=asset_id,
            relative_path=relative,
            sha256=checksum,
            size_bytes=source_path.stat().st_size,
            media_type="text/tab-separated-values",
            source_id="gdc",
            successful_attempt_id=attempt.attempt_id,
            data_level=DataLevel.REPOSITORY_PROCESSED,
        )
        return RecipeExecutionResult(
            source_asset=asset,
            download_attempt=attempt,
            attempts=(),
        )


def _call_tool_with_recipe(
    ctx: ToolContext,
    spec: str,
    source_files: str,
    monkeypatch: pytest.MonkeyPatch,
    fake: FakeWorkflowRecipeSourceFetcher | None,
) -> dict[str, object]:
    monkeypatch.setattr(
        build_tool_module,
        "_workflow_recipe_fetcher",
        lambda run_ctx: fake,
    )
    args = json.dumps({"spec": spec, "source_files": source_files})
    result = asyncio.run(build_tool_module.execute_dataset_build.on_invoke_tool(ctx, args))
    return json.loads(result)


def test_workflow_recipe_binding_acquired_via_fetcher_and_records_attempt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A WORKFLOW_RECIPE binding is fetched, registered and lineage-closed."""
    ctx = _make_ctx(tmp_path)
    run_ctx: RunContext = ctx.context
    fake = FakeWorkflowRecipeSourceFetcher(run_ctx)

    data = _call_tool_with_recipe(ctx, _recipe_spec_json(), "{}", monkeypatch, fake)

    assert data["status"] == "ok"
    result = data["result"]
    assert result["status"] == "succeeded"
    assert result["successful_sources"] == ["binding_recipe"]
    assert len(fake.calls) == 1
    assert fake.calls[0][0].binding_id == "binding_recipe"
    # The fetcher's real DownloadAttempt joins the run provenance chain.
    recorded = [a for a in run_ctx.download_attempts if "recipe://" in a.url]
    assert len(recorded) == 1
    assert recorded[0].status is DownloadStatus.SUCCEEDED
    assert recorded[0].source_id == "gdc"


def test_workflow_recipe_binding_rejection_lands_in_rejected_sources(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A mixed build rejects a failing recipe binding but keeps the builtin."""
    ctx = _make_ctx(tmp_path)
    run_ctx: RunContext = ctx.context
    # Stage the builtin binding's file.
    dest = run_ctx.work_dir.source_asset_file("gdc_expression.tsv")
    shutil.copy(FIXTURES / "gdc" / "gdc_expression.tsv", dest)
    fake = FakeWorkflowRecipeSourceFetcher(
        run_ctx, error=ValueError("recipe gdc_expression_release@3 is not PROMOTED")
    )

    data = _call_tool_with_recipe(
        ctx,
        _recipe_spec_json(builtin_binding=True),
        json.dumps({"binding_gdc": "source_assets/gdc_expression.tsv"}),
        monkeypatch,
        fake,
    )

    assert data["status"] == "ok"
    result = data["result"]
    assert result["status"] == "partial_success"
    assert result["successful_sources"] == ["binding_gdc"]
    assert result["rejected_sources"] == ["binding_recipe"]


def test_workflow_recipe_without_bound_fetcher_rejects_binding(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No run-time fetcher (no create_skill runtime) degrades to rejection."""
    ctx = _make_ctx(tmp_path)

    data = _call_tool_with_recipe(ctx, _recipe_spec_json(), "{}", monkeypatch, None)

    assert data["status"] == "ok"
    assert data["result"]["status"] == "no_data"
    # 单 binding 全拒：NO_DATA 信封携带 binding-scoped 拒绝码（既有 D5 语义）。
    assert data["result"]["reason_codes"] == ["build_error:binding_recipe"]
