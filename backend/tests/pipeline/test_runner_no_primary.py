"""Phase 4b T4: pipeline runner no-primary wiring + valid_row_count injection.

T1's no-primary processing output (``parsed_datasets=[]`` +
``no_primary_reason``) must flow through the FULL PipelineRunner without
crashing:

- ARTIFACT_BUILD receives ``parsed_dataset=None`` + ``no_primary_reason``
  (no ``parsed_datasets[0]`` IndexError) and stages the NO_DATA package;
- VALIDATION authorizes the NO_DATA package (T3) and the manifest carries
  no PRIMARY_DATASET role;
- the finalize-time BuildResult is NO_DATA with ``valid_row_count=0`` and
  the pipeline emits TaskCompletedPayload carrying it.

The 4a placeholder ``valid_row_count=0`` on SUCCEEDED is replaced by the
real primary row count: ``_compute_build_result`` takes an optional
``primary_row_count`` argument injected by ``_finalize_completed`` from the
PROCESSING stage output (the primary's ``ParsedDataset.row_count`` — the
``rows_after`` value processing_log records; NO_DATA stays 0).
"""
from __future__ import annotations

import asyncio
import hashlib
from datetime import UTC, datetime, timedelta
from pathlib import Path

from app.domain.contracts import (
    ArtifactManifestEntry,
    RunManifest,
    TaskCompletedPayload,
    TaskRequest,
    TaskSpecification,
    TaskState,
    ValidationSummary,
)
from app.domain.contracts.dataset_state import ArtifactRole, BuildResultStatus
from app.pipeline.processing.geo_tximport import GeoSampleMetadata
from app.pipeline.runner import PipelineRunner, _compute_build_result
from app.pipeline.stages.base import ProcessingOutput, StageResult
from app.pipeline.stages.validation.runner import role_for_filename

FIXTURE_DIR = Path(__file__).parents[1] / "fixtures" / "ncbi" / "gse178352"
_NO_DATA_REASON = "series_matrix_expression_empty_and_no_supplementary"

_SHA = "a" * 64
_NOW = datetime.now(UTC)


def _no_primary_processing(
    ctx: object,
    source_asset: object,
    dataset_id: str,
    geo: object | None = None,
) -> StageResult:
    """T1-shaped processing output: no primary parsed dataset + reason.

    Replaces the real ``run_processing`` in the no-primary E2E tests (fixture
    mode GSE178352 always has expression, so the no-primary input must be
    injected at the stage-wiring level).
    """
    return StageResult(
        output_digest=hashlib.sha256(b"no-primary-processing").hexdigest(),
        output=ProcessingOutput(
            parsed_datasets=[],
            samples=[
                GeoSampleMetadata(
                    sample_id="GSM9999991",
                    source_alias="S1",
                    cell_line_raw="",
                    cell_line_canonical="",
                    normalization_rule="",
                    treatment="control",
                    replicate=1,
                    organism="Homo sapiens",
                ),
            ],
            cleaning_report=None,
            field_alignment=None,
            merged_dataset=None,
            no_primary_reason=_NO_DATA_REASON,
        ),
    )


# ---------------------------------------------------------------------------
# Pipeline-level no-primary E2E (stage-wiring input injection)
# ---------------------------------------------------------------------------


def test_runner_no_primary_processing_completes_end_to_end(
    tmp_path: Path, monkeypatch
) -> None:
    """A no-primary processing output must complete the FULL pipeline without
    crashing: artifact build stages the NO_DATA package (no main_data.csv),
    validation authorizes it (T3), the manifest has no PRIMARY_DATASET role,
    and the finalize-time BuildResult is NO_DATA with valid_row_count 0."""
    monkeypatch.setattr(
        "app.pipeline.runner.run_processing", _no_primary_processing
    )

    runner = PipelineRunner(
        task_id="task_no_data_e2e",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
    )
    manifest = asyncio.run(runner.run())

    assert manifest.task_state is TaskState.COMPLETED
    assert manifest.validation.status == "valid"

    # BuildResult is NO_DATA with zero valid rows.
    assert manifest.build_result is not None
    assert manifest.build_result.status is BuildResultStatus.NO_DATA
    assert manifest.build_result.valid_row_count == 0
    assert "no_primary_data" in manifest.build_result.reason_codes

    # The manifest has no PRIMARY_DATASET role (ADR-011: no fake main table).
    roles = [entry.role for entry in manifest.artifacts]
    assert ArtifactRole.PRIMARY_DATASET not in roles
    assert roles, "NO_DATA package must still list supporting/audit artifacts"

    # No main_data.csv anywhere in the published artifacts.
    artifacts_dir = tmp_path / "tasks" / "task_no_data_e2e" / "artifacts"
    assert artifacts_dir.exists()
    assert not (artifacts_dir / "main_data.csv").exists()
    assert not (artifacts_dir / "pathway_members.csv").exists()

    # The TaskCompletedPayload carries the NO_DATA build result.
    completed = next(
        event
        for event in runner.events
        if isinstance(event.payload, TaskCompletedPayload)
    )
    assert completed.payload.build_result is not None
    assert completed.payload.build_result.status is BuildResultStatus.NO_DATA
    assert completed.payload.build_result.valid_row_count == 0


# ---------------------------------------------------------------------------
# valid_row_count injection
# ---------------------------------------------------------------------------


def test_runner_succeeded_build_result_carries_real_row_count(
    tmp_path: Path, monkeypatch
) -> None:
    """A normal-expression run's SUCCEEDED BuildResult carries the primary's
    real valid row count (the processing output's primary row_count — the
    ``rows_after`` value), not the 4a placeholder 0."""
    import app.pipeline.runner as runner_module

    original = runner_module.run_processing
    captured: dict[str, object] = {}

    def capturing(ctx, source_asset, dataset_id, geo=None):
        result = original(ctx, source_asset, dataset_id, geo=geo)
        captured["output"] = result.output
        return result

    monkeypatch.setattr(runner_module, "run_processing", capturing)

    runner = PipelineRunner(
        task_id="task_row_count",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
    )
    manifest = asyncio.run(runner.run())

    assert manifest.task_state is TaskState.COMPLETED
    assert manifest.build_result is not None
    assert manifest.build_result.status is BuildResultStatus.SUCCEEDED

    processing = captured["output"]
    assert isinstance(processing, ProcessingOutput)
    expected = (
        processing.merged_dataset.row_count
        if processing.merged_dataset is not None
        else processing.parsed_datasets[0].row_count
    )
    assert expected > 0
    assert manifest.build_result.valid_row_count == expected


def _manifest_with_artifacts(names: list[str]) -> RunManifest:
    """Build a completed RunManifest with the given artifact names (mirrors
    ``tests/pipeline/test_build_result.py``)."""
    artifacts = [
        ArtifactManifestEntry(
            artifact_id=f"artifact_{name.replace('.', '_')}",
            role=role_for_filename(name),
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
        task_id="task_build_result_t4",
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


def test_compute_build_result_injects_primary_row_count() -> None:
    """SUCCEEDED carries the injected primary row count."""
    manifest = _manifest_with_artifacts(["main_data.csv", "source_list.csv"])
    result = _compute_build_result(manifest, primary_row_count=42)
    assert result.status is BuildResultStatus.SUCCEEDED
    assert result.valid_row_count == 42


def test_compute_build_result_no_data_forces_zero_rows() -> None:
    """NO_DATA must carry 0 valid rows even when a count is supplied."""
    manifest = _manifest_with_artifacts(["source_list.csv"])
    result = _compute_build_result(manifest, primary_row_count=42)
    assert result.status is BuildResultStatus.NO_DATA
    assert result.valid_row_count == 0


def test_compute_build_result_default_row_count_is_zero() -> None:
    """Callers without a row count keep the 4a placeholder 0 (backward
    compatible with the existing test_build_result.py calls)."""
    manifest = _manifest_with_artifacts(["main_data.csv"])
    result = _compute_build_result(manifest)
    assert result.status is BuildResultStatus.SUCCEEDED
    assert result.valid_row_count == 0
