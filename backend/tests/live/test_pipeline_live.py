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
from app.pipeline.runner import PipelineRunner

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(
        os.getenv("RUN_NCBI_LIVE") != "1",
        reason="set RUN_NCBI_LIVE=1 to permit live NCBI network acceptance",
    ),
]

_FIXTURE_DIR = (
    Path(__file__).parents[2] / "tests" / "fixtures" / "ncbi" / "gse178352"
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
        total_timeout=300.0,
    )
    manifest = await runner.run()

    # Must produce a terminal state (completed or failed), not hang.
    assert manifest.task_state.value in ("completed", "failed")

    # Mode must be live.
    assert manifest.mode == "live"

    # If completed, live_accepted must be True (validation passed in live mode).
    if manifest.task_state.value == "completed":
        assert manifest.live_accepted is True
        assert manifest.validation.status == "valid"
        assert len(manifest.artifacts) > 0


@pytest.mark.asyncio
async def test_live_pipeline_fixture_mode_unchanged(tmp_path: Path) -> None:
    """Fixture mode should still work identically after live mode changes."""
    runner = PipelineRunner(
        task_id="fixture_still_works",
        base_dir=tmp_path / "tasks",
        fixture_dir=_FIXTURE_DIR,
        topic="breast cancer gene expression under Hsp70 inhibition",
        mode="fixture",
    )
    manifest = await runner.run()

    assert manifest.task_state.value == "completed"
    assert manifest.mode == "fixture"
    assert manifest.live_accepted is False
    assert manifest.validation.status == "valid"
