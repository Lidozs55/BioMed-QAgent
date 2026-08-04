"""Live end-to-end pipeline test: real NCBI discovery + FTP download.

This test runs the full deterministic pipeline in live mode, verifying
that it produces a completed manifest with ``mode="live"`` and
``live_accepted=True`` within the total timeout.

Run with: ``RUN_NCBI_LIVE=1 uv run pytest -m live tests/live/test_pipeline_live.py``
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from app.domain.contracts import (
    Database,
    DatasetSelection,
    QuerySpecification,
    TaskSpecification,
)
from app.pipeline.runner import PipelineRunner

_FIXTURE_DIR = (
    Path(__file__).parents[2] / "tests" / "fixtures" / "ncbi" / "gse178352"
)


def _pinned_specification() -> TaskSpecification:
    return TaskSpecification(
        topic="GSE178352 Hsp70 inhibition",
        queries=[
            QuerySpecification(
                query_id="query_pubmed_1",
                database=Database.PUBMED,
                query="34180400[PMID]",
                generated_by="agent",
                purpose="pinned live acceptance article",
                order=1,
            ),
            QuerySpecification(
                query_id="query_geo_1",
                database=Database.GEO,
                query="GSE178352[Accession]",
                generated_by="agent",
                purpose="pinned live acceptance dataset",
                order=2,
            ),
        ],
        datasets=[
            DatasetSelection(
                dataset_id="ds_geo_gse178352",
                database=Database.GEO,
                accession="GSE178352",
                reason="pinned live acceptance dataset",
            )
        ],
    )


@pytest.mark.live
@pytest.mark.skipif(
    os.getenv("RUN_NCBI_LIVE") != "1",
    reason="set RUN_NCBI_LIVE=1 to permit live NCBI network acceptance",
)
@pytest.mark.asyncio
async def test_live_pipeline_produces_completed_terminal_state(
    tmp_path: Path,
) -> None:
    """Live pipeline should reach completed/failed terminal state within timeout."""
    runner = PipelineRunner(
        task_id="live_pipeline_test",
        base_dir=tmp_path / "tasks",
        fixture_dir=_FIXTURE_DIR,
        topic="breast cancer gene expression under Hsp70 inhibition",
        mode="live",
        databases=["pubmed", "geo"],
        specification=_pinned_specification(),
        total_timeout=300.0,
    )
    manifest = await runner.run()

    assert manifest.task_state.value == "completed"
    assert manifest.mode == "live"
    assert manifest.live_accepted is True
    assert manifest.validation.status == "valid"
    assert manifest.specification.datasets[0].accession == "GSE178352"
    assert manifest.artifacts
    for artifact in manifest.artifacts:
        assert (runner.workdir.root / artifact.relative_path).is_file()


@pytest.mark.asyncio
async def test_live_pipeline_fixture_mode_unchanged(tmp_path: Path) -> None:
    """Fixture mode should still work identically after live mode changes."""
    runner = PipelineRunner(
        task_id="fixture_still_works",
        base_dir=tmp_path / "tasks",
        fixture_dir=_FIXTURE_DIR,
        topic="breast cancer gene expression under Hsp70 inhibition",
        mode="fixture",
        databases=["pubmed", "geo"],
        specification=_pinned_specification(),
    )
    manifest = await runner.run()

    assert manifest.task_state.value == "completed"
    assert manifest.mode == "fixture"
    assert manifest.live_accepted is False
    assert manifest.validation.status == "valid"
    assert manifest.specification.datasets[0].accession == "GSE178352"
    assert manifest.artifacts
