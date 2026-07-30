from __future__ import annotations

import asyncio
import csv
import gzip
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from app.domain.contracts import (
    DataLevel,
    SubagentRequest,
    SubagentResult,
    SubagentStatus,
    SubagentType,
    TaskState,
)
from app.pipeline.runner import PipelineRunner
from app.subagents.staging import SubagentStagingWorkspace
from app.subagents.supervisor import SubagentSupervisor

FIXTURE_DIR = Path(__file__).parents[1] / "fixtures" / "ncbi" / "gse178352"


def _read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


@pytest.mark.asyncio
async def test_parallel_children_expose_validated_assets_to_pipeline_gate(
    tmp_path: Path,
) -> None:
    task_id = "task_subagent_pipeline"
    task_root = tmp_path / "tasks" / task_id
    fixture_bytes = gzip.compress(
        (FIXTURE_DIR / "tximport_counts_slice.tsv").read_bytes(),
        mtime=0,
    )
    both_children_started = asyncio.Event()
    active_children = 0
    active_lock = asyncio.Lock()

    async def run_child(
        request: SubagentRequest,
        *,
        subagent_id: str,
        task_id: str,
        run_id: str,
    ) -> SubagentResult:
        del task_id, run_id
        nonlocal active_children
        async with active_lock:
            active_children += 1
            if active_children == 2:
                both_children_started.set()
        await both_children_started.wait()

        workspace = SubagentStagingWorkspace(task_root, subagent_id)
        asset = workspace.stage_bytes(
            content=fixture_bytes,
            filename=f"{request.target_source}.fixture.txt.gz",
            source_id=f"source_{request.target_source}",
            successful_attempt_id=f"attempt_{subagent_id}",
            data_level=DataLevel.REPOSITORY_PROCESSED,
            media_type="application/gzip",
        )
        workspace.validate_source_asset(asset)
        committed = workspace.commit_source_asset(asset)
        return SubagentResult(
            subagent_id=subagent_id,
            status=SubagentStatus.COMPLETED,
            summary=f"Validated {request.target_source}",
            source_asset_ids=[committed.asset_id],
        )

    supervisor = SubagentSupervisor()
    try:
        records = await supervisor.start_batch(
            task_id=task_id,
            run_id="run_subagent_pipeline",
            parent_tool_call_id="tool_delegate",
            requests=[
                SubagentRequest(
                    agent_type=SubagentType.SOURCE_RESEARCH,
                    objective="Acquire PubMed-linked data",
                    target_source="pubmed",
                    domain="pubmed.ncbi.nlm.nih.gov",
                    capability="source_research",
                ),
                SubagentRequest(
                    agent_type=SubagentType.SOURCE_RESEARCH,
                    objective="Acquire ArrayExpress-linked data",
                    target_source="arrayexpress",
                    domain="ebi.ac.uk",
                    capability="source_research",
                ),
            ],
            runner=SimpleNamespace(run=run_child),
            sink=SimpleNamespace(emit=AsyncMock()),
        )
        results = await asyncio.gather(*(supervisor.wait(record.subagent_id) for record in records))
    finally:
        await supervisor.shutdown()

    assert len(results) == 2
    assert all(result.status is SubagentStatus.COMPLETED for result in results)
    child_asset_ids = {asset_id for result in results for asset_id in result.source_asset_ids}
    assert child_asset_ids

    runner = PipelineRunner(
        task_id=task_id,
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
    )
    manifest = await runner.run()

    assert manifest.task_state is TaskState.COMPLETED
    assert manifest.validation.status == "valid"
    assert manifest.artifacts
    artifacts = runner.workdir.artifacts
    pipeline_asset_ids = {row["asset_id"] for row in _read_csv(artifacts / "source_assets.csv")}
    validated_asset_ids = {row["asset_id"] for row in _read_csv(artifacts / "main_data.csv")}
    integrity_check = next(
        row
        for row in _read_csv(artifacts / "quality_report.csv")
        if row["check_id"] == "source_asset_integrity"
    )

    assert child_asset_ids == pipeline_asset_ids == validated_asset_ids
    assert integrity_check["status"] == "passed"
