"""Single Agent-facing Function Tool for deterministic pipeline execution."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from pathlib import Path
from typing import Literal

from agents import RunContextWrapper, function_tool

from app.agent_loop.context import RunContext
from app.domain.contracts import (
    Database,
    DatasetSelection,
    QuerySpecification,
    RequestedOutput,
    TaskSpecification,
)
from app.pipeline.runner import PendingPublicationCleanup, PipelineRunner
from app.pipeline.stages import STANDALONE_RUN_ID


def _build_tool_specification(
    topic: str,
    databases: list[str],
    pmid: str | None,
    gse: str | None,
) -> TaskSpecification | None:
    """Build a TaskSpecification when the Agent supplied explicit accessions.

    Returns ``None`` when neither ``pmid`` nor ``gse`` is provided, so the
    pipeline falls back to its default topic-driven discovery. When at least
    one accession is supplied, the specification pins those accessions so the
    discovery stage uses direct NCBI lookups instead of topic search (which
    fails for non-English topics).
    """
    if not pmid and not gse:
        return None
    selected = {value.lower() for value in databases}
    queries: list[QuerySpecification] = []
    datasets: list[DatasetSelection] = []
    order = 0

    def _next_order() -> int:
        nonlocal order
        order += 1
        return order

    if gse and "geo" in selected:
        queries.append(
            QuerySpecification(
                query_id="query_geo_1",
                database=Database.GEO,
                query=f"{gse}[Accession]",
                generated_by="agent",
                purpose="explicit GEO accession from agent discovery",
                order=_next_order(),
            )
        )
        datasets.append(
            DatasetSelection(
                dataset_id=f"ds_geo_{gse.lower()}",
                database=Database.GEO,
                accession=gse,
                source_id="",
                reason="agent-identified GEO series",
            )
        )
    if pmid and "pubmed" in selected:
        queries.append(
            QuerySpecification(
                query_id="query_pubmed_1",
                database=Database.PUBMED,
                query=f"{pmid}[PMID]",
                generated_by="agent",
                purpose="explicit PMID from agent discovery",
                order=_next_order(),
            )
        )
    if not queries:
        return None
    return TaskSpecification(
        topic=topic,
        queries=queries,
        datasets=datasets,
        requested_outputs=[
            RequestedOutput.MAIN_DATA,
            RequestedOutput.LITERATURE,
            RequestedOutput.DATASET_CATALOG,
            RequestedOutput.SAMPLE_METADATA,
        ],
    )


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
        "Run the deterministic validated research-data pipeline. "
        "Pass ``pmid``/``gse`` when you have already discovered explicit "
        "accessions via search_pubmed/search_geo/describe_geo — this avoids "
        "re-searching NCBI by topic (which fails for non-English topics). "
        "Defaults to live mode (real external APIs) for production agent runs; "
        "fixture mode is reserved for offline regression tests and must be set "
        "explicitly."
    ),
)
async def run_research_pipeline(
    ctx: RunContextWrapper[RunContext],
    topic: str,
    databases: list[str],
    pmid: str | None = None,
    gse: str | None = None,
    mode: Literal["fixture", "live"] = "live",
) -> str:
    normalized_databases = [value.lower() for value in databases]
    if not normalized_databases:
        raise ValueError("databases must be a non-empty list of database identifiers")

    run_context = ctx.context
    managed_run_id = run_context.reserve_pipeline_publication()
    fixture_dir = (
        Path(__file__).parents[2] / "tests" / "fixtures" / "ncbi" / "gse178352"
    )
    specification = _build_tool_specification(topic, normalized_databases, pmid, gse)
    runner: PipelineRunner | None = None
    transferred = False
    reservation_released = False
    cleanup_attempted = False
    bridge = run_context.managed_pipeline_bridge
    submitter = None
    submitter_installed = False

    async def abort_reserved_runner() -> None:
        nonlocal cleanup_attempted, reservation_released, transferred
        if managed_run_id is None or cleanup_attempted:
            return
        cleanup_attempted = True
        if runner is not None:
            try:
                await _run_sync_cleanup(runner.abort)
            except BaseException as error:
                run_context.set_pending_publication_cleanup(
                    PendingPublicationCleanup(
                        run_id=managed_run_id,
                        abort=runner.abort,
                        error=error,
                    )
                )
                transferred = True
                raise
        run_context.release_pipeline_publication_reservation()
        reservation_released = True

    try:
        runner = PipelineRunner(
            task_id=run_context.task_id,
            base_dir=run_context.work_dir.root.parent,
            fixture_dir=fixture_dir,
            topic=topic,
            mode=mode,
            databases=normalized_databases,
            specification=specification,
            cancellation_requested=run_context.cancellation_requested,
            defer_publication=managed_run_id is not None,
            event_sink=bridge.event_sink if bridge is not None else None,
            run_id=managed_run_id or STANDALONE_RUN_ID,
        )
        if bridge is not None:
            submitter = runner.submit_user_input
            bridge.install_user_input_submitter(submitter)
            submitter_installed = True
        manifest = await runner.run()
        if managed_run_id is not None:
            if manifest.task_state.value == "completed":
                run_context.set_pending_publication(runner.pending_publication())
                transferred = True
            else:
                await abort_reserved_runner()
                terminal_error = runner.take_managed_terminal_error()
                if terminal_error is not None:
                    run_context.set_managed_terminal_error(terminal_error)
    except BaseException:
        if (
            managed_run_id is not None
            and not transferred
            and not reservation_released
        ):
            await abort_reserved_runner()
        raise
    finally:
        if bridge is not None and submitter_installed and submitter is not None:
            bridge.clear_user_input_submitter(submitter)
    return json.dumps(
        {
            "task_id": manifest.task_id,
            "status": manifest.task_state.value,
            "validation_status": manifest.validation.status,
            "artifact_count": len(manifest.artifacts) + 1,
            "artifacts": [
                {
                    "name": entry.name,
                    "size_bytes": entry.size_bytes,
                    "media_type": entry.media_type,
                }
                for entry in manifest.artifacts
            ],
            "mode": mode,
            "topic": topic,
            "note": (
                "Artifacts are published to the task's artifacts/ directory "
                "with the exact names listed above. Reference these filenames "
                "verbatim in any user-facing report; do not invent filenames."
            ),
        },
        ensure_ascii=False,
    )
