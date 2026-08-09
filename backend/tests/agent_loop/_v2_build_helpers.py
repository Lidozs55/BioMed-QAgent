"""共享 V2 fixture-build helpers（V1 退役后执行框架测试的 V2 载体）。

三个执行框架测试族（max_turns / no_progress / qwen args retry / agent e2e）
需要"Agent 调用正式产物工具产生 durable pending"的确定性模拟。V1 退役后
统一改为：复制官方 GDC fixture 资产进任务工作目录 → 构造固定 DatasetBuildSpec
→ 直接调用 ``execute_dataset_build.on_invoke_tool`` → 产生 PendingDatasetBuild
（由 Agent 执行器的 ``_transfer_pending_publication`` 桥接到 durable Run）。
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from agents.tool_context import ToolContext
from app.agent_loop.context import RunContext
from app.pipeline.dataset_build_tool import execute_dataset_build

GDC_FIXTURE = Path(__file__).parents[1] / "fixtures" / "gdc" / "gdc_expression.tsv"

_FIXTURE_SPEC = {
    "build_id": "fixture_build",
    "objective": "fixture gene expression build",
    "dataset_family": "gene_expression",
    "row_granularity": "gene_sample_measurement",
    "schema_ref": "gene_expression.long.v1",
    "source_bindings": [
        {
            "binding_id": "binding_gdc",
            "source": "gdc",
            "acquisition": {"mode": "builtin", "provider_id": "gdc.v1"},
            "adapter_id": "gdc.expression.v1",
            "accession": "TCGA-FIXTURE",
        }
    ],
    "merge_strategy": "append_by_canonical_row",
    "validation_profile_ref": "gene_expression.release.v1",
    "normalization_profile_ref": "gene_expression.normalization.v1",
}


def stage_fixture_asset(run_ctx: RunContext, *, header_only: bool = False) -> str:
    """Copy the GDC expression fixture into the task workdir.

    Returns the workdir-relative path for ``source_files``.
    ``header_only`` writes a header-only file (structured NO_DATA outcome).
    """
    dest = run_ctx.work_dir.source_asset_file("fixture_gdc_expression.tsv")
    if header_only:
        dest.write_text("gene_id\tS1\tS2\n", encoding="utf-8")
    else:
        shutil.copyfile(GDC_FIXTURE, dest)
    return "source_assets/fixture_gdc_expression.tsv"


async def run_fixture_build(
    run_ctx: RunContext,
    *,
    header_only: bool = False,
) -> dict[str, object]:
    """Run the fixed V2 fixture build over the GDC fixture asset.

    Installs a ``PendingDatasetBuild`` on the managed RunContext (no-op for
    unmanaged contexts). Returns the tool envelope JSON as a dict.
    """
    rel = stage_fixture_asset(run_ctx, header_only=header_only)
    tool = ToolContext(
        context=run_ctx,
        tool_name="execute_dataset_build",
        tool_call_id="call_fixture_build",
        tool_arguments="{}",
    )
    raw = await execute_dataset_build.on_invoke_tool(
        tool,
        json.dumps(
            {
                "spec": json.dumps(_FIXTURE_SPEC),
                "source_files": json.dumps({"binding_gdc": rel}),
            }
        ),
    )
    return json.loads(raw)
