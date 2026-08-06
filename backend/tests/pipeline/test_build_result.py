"""Tests for PipelineRunner's conservative 4a BuildResult computation.

Verifies the two-branch judgment from the 4a spec (docs §4.1): presence of
the primary artifact (``main_data.csv``) in the completed manifest yields
``SUCCEEDED``; absence yields ``NO_DATA`` with ``no_primary_data``.
``PARTIAL_SUCCESS`` is not produced in 4a (no source-level failure statistics
injection point yet — 4b wires in the V2 chain statistics).

Also covers the failed-manifest path threading ``error_code`` so terminal
failure is expressible without error-string guessing.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.domain.contracts import (
    ArtifactManifestEntry,
    ErrorCode,
    ErrorDetail,
    RunManifest,
    TaskRequest,
    TaskSpecification,
    TaskState,
    ValidationSummary,
)
from app.domain.contracts.dataset_state import BuildResultStatus
from app.pipeline.runner import _build_failed_manifest, _compute_build_result

_SHA = "a" * 64
_NOW = datetime.now(UTC)


def _manifest_with_artifacts(names: list[str]) -> RunManifest:
    """Build a completed RunManifest with the given artifact names.

    Mirrors the payload shape produced by ``run_validation`` (sorted unique
    id lists, artifacts sorted by artifact_id, finished_at >= started_at).
    """
    artifacts = [
        ArtifactManifestEntry(
            artifact_id=f"artifact_{name.replace('.', '_')}",
            name=name,
            relative_path=f"artifacts/{name}",
            media_type="text/csv",
            size_bytes=10,
            sha256=_SHA,
            generated_by_step_id="step_artifact_builder_v1",
        )
        for name in names
    ]
    return RunManifest(
        task_id="task_build_result_1",
        id_generation_version="1.0",
        request=TaskRequest(topic="breast cancer", mode="fixture"),
        specification=TaskSpecification(topic="breast cancer"),
        task_state=TaskState.COMPLETED,
        stage_attempt_ids=["stage_attempt_1"],
        source_ids=["src_article", "src_geo"],
        artifacts=artifacts,
        validation=ValidationSummary(
            status="valid",
            checked_count=10,
            failed_count=0,
            report_path="logs/validation_report.json",
        ),
        pipeline_version="0.1.0",
        model_name=None,
        mode="fixture",
        live_accepted=False,
        started_at=_NOW,
        finished_at=_NOW + timedelta(seconds=2),
    )


def test_completed_with_primary_is_succeeded() -> None:
    manifest = _manifest_with_artifacts(["main_data.csv", "source_list.csv"])
    result = _compute_build_result(manifest)
    assert result.status is BuildResultStatus.SUCCEEDED
    assert result.valid_row_count >= 0
    assert result.successful_sources == manifest.source_ids


def test_completed_without_primary_is_no_data() -> None:
    manifest = _manifest_with_artifacts(["source_list.csv"])
    result = _compute_build_result(manifest)
    assert result.status is BuildResultStatus.NO_DATA
    assert "no_primary_data" in result.reason_codes
    assert result.valid_row_count == 0


def test_failed_manifest_carries_error_code() -> None:
    """A failed run's manifest exposes the structured error code (not a string guess)."""
    error = ErrorDetail(
        code=ErrorCode.TIMEOUT,
        message="simulated acquisition timeout",
        retryable=True,
    )
    manifest = _build_failed_manifest(
        "task_fail_1",
        _NOW,
        error,
        "breast cancer",
        mode="fixture",
        model_name=None,
        error_code=error.code,
    )
    assert manifest.task_state is TaskState.FAILED
    assert manifest.error_code is ErrorCode.TIMEOUT
