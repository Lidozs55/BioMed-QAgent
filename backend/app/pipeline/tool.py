"""Single Agent-facing Function Tool for deterministic pipeline execution."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from pathlib import Path
from typing import Literal

from agents import RunContextWrapper, function_tool

from app.agent_loop.context import RunContext
from app.pipeline.runner import PipelineRunner
from app.pipeline.stages import STANDALONE_RUN_ID


async def _run_sync_cleanup(operation: Callable[[], None]) -> None:
    worker = asyncio.create_task(asyncio.to_thread(operation))
    try:
        await asyncio.shield(worker)
    except asyncio.CancelledError:
        while not worker.done():
            try:
                await asyncio.shield(worker)
            except asyncio.CancelledError:
                continue
            except BaseException:
                break
        if not worker.cancelled():
            worker.exception()
        raise


@function_tool(
    name_override="run_research_pipeline",
    description_override=(
        "Run the deterministic validated research-data pipeline. Supports "
        "fixture mode (offline, pinned GSE178352/PMID 34180400) and live "
        "mode (real NCBI E-utilities + FTP download)."
    ),
)
async def run_research_pipeline(
    ctx: RunContextWrapper[RunContext],
    topic: str,
    databases: list[str],
    mode: Literal["fixture", "live"] = "fixture",
) -> str:
    normalized_databases = [value.lower() for value in databases]
    if set(normalized_databases) != {"pubmed", "geo"} or len(databases) != 2:
        raise ValueError("pipeline supports exactly pubmed and geo")

    run_context = ctx.context
    managed_run_id = run_context.reserve_pipeline_publication()
    fixture_dir = (
        Path(__file__).parents[2] / "tests" / "fixtures" / "ncbi" / "gse178352"
    )
    runner: PipelineRunner | None = None
    transferred = False
    reservation_released = False
    cleanup_attempted = False

    async def abort_reserved_runner() -> None:
        nonlocal cleanup_attempted, reservation_released
        if managed_run_id is None or cleanup_attempted:
            return
        cleanup_attempted = True
        try:
            if runner is not None:
                await _run_sync_cleanup(runner.abort)
        finally:
            run_context.release_pipeline_publication_reservation()
            reservation_released = True

    try:
        runner = PipelineRunner(
            task_id=run_context.task_id,
            base_dir=run_context.work_dir.root.parent,
            fixture_dir=fixture_dir,
            topic=topic,
            mode=mode,
            cancellation_requested=run_context.cancellation_requested,
            defer_publication=managed_run_id is not None,
            run_id=managed_run_id or STANDALONE_RUN_ID,
        )
        manifest = await runner.run()
        if managed_run_id is not None:
            if manifest.task_state.value == "completed":
                run_context.set_pending_publication(runner.pending_publication())
                transferred = True
            else:
                await abort_reserved_runner()
    except BaseException:
        if (
            managed_run_id is not None
            and not transferred
            and not reservation_released
        ):
            await abort_reserved_runner()
        raise
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
