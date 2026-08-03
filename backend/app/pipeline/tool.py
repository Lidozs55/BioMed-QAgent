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
    DATABASE_IDENTIFIER_ALIASES,
    SOURCE_CAPABILITIES,
    Database,
    DatasetSelection,
    QuerySpecification,
    RequestedOutput,
    SourceCapability,
    TaskSpecification,
)
from app.pipeline.runner import PendingPublicationCleanup, PipelineRunner
from app.pipeline.stages import STANDALONE_RUN_ID


def _build_tool_specification(
    topic: str,
    databases: list[str],
    pmid: str | None,
    gse: str | None,
    xena_dataset_id: str | None = None,
    gdc_project_id: str | None = None,
    gdc_data_type: str | None = None,
    reactome_pathway_id: str | None = None,
) -> TaskSpecification | None:
    """Build a TaskSpecification when the Agent supplied explicit accessions.

    Returns ``None`` when neither ``pmid`` nor ``gse`` is provided, so the
    pipeline falls back to its default topic-driven discovery. When at least
    one accession is supplied, the specification pins those accessions so the
    discovery stage uses direct NCBI lookups instead of topic search (which
    fails for non-English topics).
    """
    normalized_reactome_pathway_id = (
        reactome_pathway_id.strip() if reactome_pathway_id else None
    )
    has_reactome_pathway_id = bool(normalized_reactome_pathway_id)
    if (
        not pmid
        and not gse
        and not xena_dataset_id
        and not gdc_project_id
        and not has_reactome_pathway_id
    ):
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
    if gdc_project_id and "gdc" in selected:
        if not gdc_data_type:
            raise ValueError("gdc_data_type is required with gdc_project_id")
        queries.append(
            QuerySpecification(
                query_id="query_gdc_1",
                database=Database.GDC,
                query=gdc_project_id,
                generated_by="agent",
                purpose="explicit GDC project",
                order=_next_order(),
            )
        )
        datasets.append(
            DatasetSelection(
                dataset_id=f"ds_gdc_{gdc_project_id.lower()}",
                database=Database.GDC,
                accession=gdc_project_id,
                reason="agent-identified GDC project",
                data_type=gdc_data_type,
            )
        )
    if xena_dataset_id and ({"xena", "ucsc_xena"} & selected):
        queries.append(
            QuerySpecification(
                query_id="query_xena_1",
                database=Database.UCSC_XENA,
                query=xena_dataset_id,
                generated_by="agent",
                purpose="explicit Xena dataset from agent discovery",
                order=_next_order(),
            )
        )
        datasets.append(
            DatasetSelection(
                dataset_id=f"ds_ucsc_xena_{xena_dataset_id.lower().replace('/', '_')}",
                database=Database.UCSC_XENA,
                accession=xena_dataset_id,
                source_id="",
                reason="agent-identified Xena dataset",
            )
        )
    if has_reactome_pathway_id and "reactome" in selected:
        datasets.append(
            DatasetSelection(
                dataset_id=f"ds_reactome_{normalized_reactome_pathway_id.lower()}",
                database=Database.REACTOME,
                accession=normalized_reactome_pathway_id,
                reason="agent-identified Reactome pathway",
                data_type="pathway-participants",
            )
        )
    reactome_datasets = [
        dataset for dataset in datasets if dataset.database == Database.REACTOME
    ]
    if len(reactome_datasets) > 1:
        raise ValueError("Reactome supports exactly one explicit DatasetSelection")
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
    if not queries and not datasets:
        return None
    return TaskSpecification.declare_sources(
        topic=topic,
        identifiers=databases,
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
        "Call this tool at most 5 times per research task.  Pass ``pmid``/``gse`` "
        "when you have already discovered explicit accessions via "
        "search_pubmed/search_geo/describe_geo — the pipeline does NOT auto-search "
        "GEO by topic, so ``gse`` is required when GEO is in databases.  "
        "Defaults to live mode (real external APIs) for production agent runs; "
        "fixture mode is reserved for offline regression tests and must be set "
        "explicitly."
    ),
)
async def run_research_pipeline(
    ctx: RunContextWrapper[RunContext],
    topic: str,
    databases: list[str] | str | None = None,
    pmid: str | None = None,
    gse: str | None = None,
    xena_dataset_id: str | None = None,
    gdc_project_id: str | None = None,
    gdc_data_type: str | None = None,
    reactome_pathway_id: str | None = None,
    mode: Literal["fixture", "live"] = "live",
) -> str:
    run_context = ctx.context
    # Qwen serializes list params as JSON strings (e.g. '["geo","pubmed"]')
    # instead of native lists, which fails SDK strict_schema list_type
    # validation. Accept both forms so the agent doesn't get stuck retrying.
    if isinstance(databases, str):
        try:
            databases = json.loads(databases)
        except json.JSONDecodeError:
            return json.dumps(
                {
                    "status": "invalid_input",
                    "message": (
                        f"databases must be a list or JSON list string, "
                        f"got: {databases!r}"
                    ),
                    "retryable": False,
                },
                ensure_ascii=False,
            )
    # databases defaults to the user's UI-selected preferred_sources (issue #1).
    # Handle None, empty list, and the LLM "unset optional param as empty
    # string" edge case uniformly.  When falling back, silently filter out
    # RESEARCH_ONLY sources (PDB/PubChem) — they are agent-investigation
    # sources and must not cause the whole pipeline call to be rejected just
    # because the agent omitted databases.  The agent may still explicitly
    # request them and get a clear capability rejection below.
    if not isinstance(databases, list) or not databases:
        databases = [
            src
            for src in run_context.preferred_sources
            if (db := DATABASE_IDENTIFIER_ALIASES.get(src.strip().lower())) is not None
            and SOURCE_CAPABILITIES[db] is SourceCapability.PIPELINE_SUPPORTED
        ]
    normalized_databases = [value.strip().lower() for value in databases]
    if not normalized_databases:
        return json.dumps(
            {
                "status": "invalid_input",
                "message": (
                    "databases is empty and no pipeline-supported "
                    "preferred_sources were set. Select at least one "
                    "pipeline-supported database (pubmed/geo/gdc/xena/reactome) "
                    "in the UI or pass a non-empty databases list."
                ),
                "retryable": False,
            },
            ensure_ascii=False,
        )
    # Resolve each selected identifier against the single source-of-truth
    # capability table (TODO §1.4). Only pipeline-supported sources may run;
    # research_only / pending / unknown sources are reported with their
    # declared capability instead of being silently accepted.
    rejected: list[dict[str, str]] = []
    seen_database: set[str] = set()
    for identifier in normalized_databases:
        database = DATABASE_IDENTIFIER_ALIASES.get(identifier)
        if database is None:
            rejected.append({
                "database": identifier,
                "capability": "pending",
                "reason": "unknown source; awaiting integration",
            })
            continue
        if database.value in seen_database:
            continue
        seen_database.add(database.value)
        capability = SOURCE_CAPABILITIES[database]
        if capability is not SourceCapability.PIPELINE_SUPPORTED:
            rejected.append({
                "database": identifier,
                "capability": capability.value,
                "reason": (
                    "Agent-only investigation source; not accepted by the Pipeline"
                ),
            })
    if rejected:
        return json.dumps(
            {
                "status": "unsupported_databases",
                "unsupported_databases": [item["database"] for item in rejected],
                "capabilities": rejected,
                "retryable": False,
            },
            ensure_ascii=False,
        )
    if "reactome" in normalized_databases and len(set(normalized_databases)) > 1:
        return json.dumps(
            {
                "status": "unsupported_databases",
                "unsupported_databases": ["reactome_mixed_sources"],
                "retryable": False,
            },
            ensure_ascii=False,
        )
    if normalized_databases == ["reactome"] and not (reactome_pathway_id or "").strip():
        return json.dumps(
            {
                "status": "invalid_input",
                "message": "reactome_pathway_id is required when databases is ['reactome']",
                "retryable": False,
            },
            ensure_ascii=False,
        )

    # Issue #3: limit pipeline retries to prevent agent stuck loops.
    if run_context.pipeline_attempt_count >= 5:
        return json.dumps(
            {
                "status": "max_attempts_exceeded",
                "message": (
                    "The research pipeline has been attempted 5 times and failed. "
                    "Do not call run_research_pipeline again. Report the failure "
                    "to the user with the error details from the last attempt."
                ),
                "retryable": False,
            },
            ensure_ascii=False,
        )
    try:
        managed_run_id = run_context.reserve_pipeline_publication()
    except RuntimeError:
        # Pipeline was already called in this Run.  Return a clear message
        # so the Agent does not retry and instead reports the final results
        # to the user based on the pipeline output it already received.
        return json.dumps(
            {
                "status": "already_run",
                "message": (
                    "The research pipeline has already been executed for this "
                    "task.  Do not call run_research_pipeline again.  Instead, "
                    "summarize the final results to the user based on the "
                    "pipeline output you already received."
                ),
            },
            ensure_ascii=False,
        )
    fixture_root = Path(__file__).parents[2] / "tests" / "fixtures"
    fixture_dir = (
        fixture_root / "reactome"
        if "reactome" in normalized_databases
        else fixture_root / "ncbi" / "gse178352"
    )
    specification = _build_tool_specification(
        topic,
        normalized_databases,
        pmid,
        gse,
        xena_dataset_id,
        gdc_project_id,
        gdc_data_type,
        reactome_pathway_id,
    )
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
            model_name=run_context.model_settings.model_name,
            lock_timeout=run_context.model_settings.runtime_limits.lock_timeout_seconds,
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
        if managed_run_id is not None and not transferred and not reservation_released:
            await abort_reserved_runner()
        raise
    finally:
        if bridge is not None and submitter_installed and submitter is not None:
            bridge.clear_user_input_submitter(submitter)

    # Extract error details from failed stage attempts so the Agent can
    # understand the specific reason and avoid repeating the same mistake.
    failed_attempts = [
        attempt
        for attempt in runner.state.stage_attempts
        if attempt.status.value == "failed" and attempt.error is not None
    ]
    last_error = failed_attempts[-1] if failed_attempts else None

    # Determine where artifacts currently reside (issue #4).  When
    # defer_publication is active (managed run), artifacts are staged in
    # staging/run_<id>/ and published to artifacts/ only at run completion.
    artifact_dir = f"staging/{managed_run_id}" if managed_run_id is not None else "artifacts"

    result = {
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
        "artifact_dir": artifact_dir,
        "mode": mode,
        "topic": topic,
        "note": (
            f"Artifacts are in the '{artifact_dir}' directory"
            + (
                " (will be published to artifacts/ at run completion)."
                if managed_run_id is not None
                else "."
            )
            + " Reference these filenames verbatim; do not invent filenames."
        ),
    }
    if last_error is not None:
        result["failed_stage"] = last_error.stage.value
        result["error_message"] = last_error.error.message
        result["error_code"] = last_error.error.code.value
        result["retryable"] = last_error.error.retryable
    return json.dumps(result, ensure_ascii=False)
