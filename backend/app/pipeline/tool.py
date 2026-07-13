"""Single Agent-facing Function Tool for deterministic pipeline execution."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Literal

from agents import RunContextWrapper, function_tool

from app.agent_loop.context import RunContext
from app.pipeline.pinned_case import run_pinned_fixture


@function_tool(
    name_override="run_research_pipeline",
    description_override=(
        "Run the deterministic validated research-data pipeline. The current "
        "accepted mode is the official PMID 34180400 / GSE178352 fixture."
    ),
)
async def run_research_pipeline(
    ctx: RunContextWrapper[RunContext],
    topic: str,
    databases: list[str],
    mode: Literal["fixture"] = "fixture",
) -> str:
    normalized_databases = [value.lower() for value in databases]
    if set(normalized_databases) != {"pubmed", "geo"} or len(databases) != 2:
        raise ValueError("fixture pipeline supports exactly pubmed and geo")
    run_context = ctx.context
    fixture_dir = (
        Path(__file__).parents[2] / "tests" / "fixtures" / "ncbi" / "gse178352"
    )
    manifest = await asyncio.to_thread(
        run_pinned_fixture,
        task_id=run_context.task_id,
        base_dir=run_context.work_dir.root.parent,
        fixture_dir=fixture_dir,
        topic=topic,
        cancellation_requested=run_context.cancellation_requested,
    )
    return json.dumps(
        {
            "task_id": manifest.task_id,
            "status": manifest.task_state.value,
            "validation_status": manifest.validation.status,
            "artifact_count": len(manifest.artifacts) + 1,
            "mode": mode,
            "topic": topic,
        },
        ensure_ascii=False,
    )
