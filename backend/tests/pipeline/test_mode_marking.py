"""Tests for explicit mode marking and live acceptance gate (§9 lines 291-292).

Verifies that:
- Fixture runs produce manifests with ``mode="fixture"`` and
  ``live_accepted=False``.
- The RunManifest contract rejects ``mode="fixture"`` combined with
  ``live_accepted=True`` (mock cannot pass live acceptance).
- The contract accepts forward-compatible live-mode manifests.
- The task status API exposes ``mode`` and ``live_accepted`` fields.
"""
from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from app.domain.contracts import (
    ArtifactManifestEntry,
    RunManifest,
    TaskRequest,
    TaskSpecification,
    TaskState,
    ValidationSummary,
)
from app.pipeline.runner import PipelineRunner
from pydantic import ValidationError

FIXTURE_DIR = Path(__file__).parents[1] / "fixtures" / "ncbi" / "gse178352"

_NOW = datetime.now(UTC)
_SHA_A = "a" * 64


def _valid_manifest_payload(
    mode: str = "fixture",
    live_accepted: bool = False,
) -> dict:
    """Build a minimal valid RunManifest payload for contract tests."""
    artifact = ArtifactManifestEntry(
        artifact_id="artifact_" + _SHA_A[:32],
        name="main_data.csv",
        relative_path="artifacts/main_data.csv",
        media_type="text/csv",
        size_bytes=10,
        sha256=_SHA_A,
        generated_by_step_id="step_build_1",
    )
    return {
        "task_id": "task_mode_1",
        "id_generation_version": "1.0",
        "request": TaskRequest(topic="breast cancer", mode=mode),
        "specification": TaskSpecification(topic="breast cancer"),
        "task_state": TaskState.COMPLETED,
        "stage_attempt_ids": ["stage_attempt_1"],
        "source_ids": ["src_article", "src_geo"],
        "artifacts": [artifact],
        "validation": ValidationSummary(
            status="valid",
            checked_count=10,
            failed_count=0,
            report_path="logs/validation_report.json",
        ),
        "pipeline_version": "0.1.0",
        "model_name": None,
        "mode": mode,
        "live_accepted": live_accepted,
        "started_at": _NOW,
        "finished_at": _NOW + timedelta(seconds=2),
    }


def test_fixture_run_produces_fixture_mode_and_not_live_accepted(
    tmp_path: Path,
) -> None:
    """A default (fixture) pipeline run stamps mode='fixture' and live_accepted=False."""
    runner = PipelineRunner(
        task_id="task_fixture_mode",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
    )
    manifest = asyncio.run(runner.run())

    assert manifest.mode == "fixture"
    assert manifest.live_accepted is False
    assert manifest.request.mode == "fixture"


def test_contract_rejects_fixture_mode_with_live_accepted_true() -> None:
    """§9 line 292: fixture mode must never be live_accepted."""
    payload = _valid_manifest_payload(mode="fixture", live_accepted=True)
    with pytest.raises(ValidationError, match="fixture mode cannot be live_accepted"):
        RunManifest(**payload)


def test_contract_accepts_fixture_mode_with_live_accepted_false() -> None:
    """Fixture mode with live_accepted=False is the only valid fixture state."""
    payload = _valid_manifest_payload(mode="fixture", live_accepted=False)
    manifest = RunManifest(**payload)
    assert manifest.mode == "fixture"
    assert manifest.live_accepted is False


def test_contract_accepts_live_mode_with_live_accepted_true() -> None:
    """Forward-compat: live mode with valid validation can be live_accepted."""
    payload = _valid_manifest_payload(mode="live", live_accepted=True)
    manifest = RunManifest(**payload)
    assert manifest.mode == "live"
    assert manifest.live_accepted is True


def test_contract_accepts_live_mode_with_live_accepted_false() -> None:
    """Live mode that failed validation is not live_accepted (but mode is live)."""
    payload = _valid_manifest_payload(mode="live", live_accepted=False)
    manifest = RunManifest(**payload)
    assert manifest.mode == "live"
    assert manifest.live_accepted is False


def test_failed_manifest_carries_mode_and_not_live_accepted(
    tmp_path: Path,
) -> None:
    """A failed fixture run stamps mode='fixture' and live_accepted=False."""
    from app.domain.contracts import ErrorCode, ErrorDetail
    from app.pipeline.runner import _build_failed_manifest

    error = ErrorDetail(
        code=ErrorCode.INTERNAL_ERROR,
        message="simulated failure",
        retryable=False,
    )
    manifest = _build_failed_manifest(
        "task_failed_mode", _NOW, error, "breast cancer", mode="fixture",
    )
    assert manifest.mode == "fixture"
    assert manifest.live_accepted is False


def test_cancelled_manifest_carries_mode_and_not_live_accepted() -> None:
    """A cancelled fixture run stamps mode='fixture' and live_accepted=False."""
    from app.pipeline.runner import _build_cancelled_manifest

    manifest = _build_cancelled_manifest(
        "task_cancelled_mode", _NOW, "breast cancer", mode="fixture",
    )
    assert manifest.mode == "fixture"
    assert manifest.live_accepted is False


@pytest.mark.asyncio
async def test_task_status_api_exposes_mode_and_live_accepted(
    tmp_path: Path,
) -> None:
    """The durable task snapshot exposes task.mode via the new REST API.

    Superseded-by: tests/api/test_rest_control.py covers the full
    TaskSnapshot shape (including mode) against the lifespan-owned
    TaskManager. This test is kept as a contract-level smoke check.
    """
    from app.config import Settings
    from app.main import create_app

    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    async with application.router.lifespan_context(application):
        import httpx

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application),
            base_url="http://localhost",
        ) as client:
            created = await client.post(
                "/api/v1/tasks",
                json={
                    "request_id": "req-mode-smoke",
                    "input": "breast cancer gene expression",
                    "databases": ["pubmed", "geo"],
                    "mode": "fixture",
                },
            )
            assert created.status_code == 202
            task_id = created.json()["task_id"]

            status = await client.get(f"/api/v1/tasks/{task_id}")
            body = status.json()
            assert body["task"]["mode"] == "fixture"
