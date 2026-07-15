from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from app.domain.contracts import (
    ArtifactManifestEntry,
    AttemptStatus,
    Database,
    ErrorCode,
    ErrorDetail,
    FileAsset,
    ParsedDataset,
    RequestedOutput,
    RunManifest,
    StageAttempt,
    StageName,
    TaskRequest,
    TaskSpecification,
    TaskState,
    ValidationSummary,
    WarningRecord,
    WarningSeverity,
)
from pydantic import ValidationError

NOW = datetime(2026, 7, 12, tzinfo=UTC)
SHA_A = "aa" * 32
SHA_B = "bb" * 32


def parsed_file() -> FileAsset:
    return FileAsset(
        asset_id=f"asset_{SHA_A}",
        kind="parsed",
        relative_path="parsed/GSE178352_counts.tsv",
        sha256=SHA_A,
        size_bytes=1024,
        media_type="text/tab-separated-values",
        generated_by_step_id="step_parse_geo_1",
    )


def test_parsed_dataset_references_on_disk_file_without_rows() -> None:
    dataset = ParsedDataset(
        dataset_id="ds_geo_gse178352",
        source_id="src_geo",
        source_asset_id=f"asset_{SHA_B}",
        file_asset=parsed_file(),
        columns=["gene_id", "GSM1"],
        row_count=100,
        parser_name="geo_tximport_counts",
        parser_version="1.0.0",
    )

    assert dataset.file_asset.kind == "parsed"
    assert "rows" not in dataset.model_dump()
    with pytest.raises(ValidationError, match="extra_forbidden"):
        ParsedDataset(**dataset.model_dump(), rows=[{"gene_id": "TP53"}])


def test_stage_attempt_requires_output_digest_for_success() -> None:
    attempt = StageAttempt(
        stage_attempt_id="stage_attempt_1",
        task_id="task_1",
        stage=StageName.PROCESSING,
        attempt=1,
        input_digest=SHA_A,
        parameter_digest=SHA_B,
        output_digest=SHA_A,
        status=AttemptStatus.SUCCEEDED,
        started_at=NOW,
        finished_at=NOW + timedelta(seconds=1),
    )
    assert attempt.output_digest == SHA_A

    with pytest.raises(ValidationError, match="output_digest"):
        StageAttempt(**{
            **attempt.model_dump(),
            "output_digest": None,
        })


def test_failed_stage_attempt_requires_structured_error() -> None:
    with pytest.raises(ValidationError, match="error"):
        StageAttempt(
            stage_attempt_id="stage_attempt_2",
            task_id="task_1",
            stage=StageName.ACQUISITION,
            attempt=1,
            input_digest=SHA_A,
            parameter_digest=SHA_B,
            status=AttemptStatus.FAILED,
            started_at=NOW,
            finished_at=NOW,
        )

    error = ErrorDetail(
        code=ErrorCode.NETWORK_ERROR,
        message="download failed",
        retryable=True,
        stage=StageName.ACQUISITION,
        details={"http_status": 503, "urls": ["https://example.test"]},
    )
    failed = StageAttempt(
        stage_attempt_id="stage_attempt_2",
        task_id="task_1",
        stage=StageName.ACQUISITION,
        attempt=1,
        input_digest=SHA_A,
        parameter_digest=SHA_B,
        status=AttemptStatus.FAILED,
        started_at=NOW,
        finished_at=NOW,
        error=error,
    )
    assert failed.error.retryable is True


def test_warning_record_carries_precise_optional_scope() -> None:
    warning = WarningRecord(
        warning_id="warning_1",
        severity=WarningSeverity.WARNING,
        stage=StageName.PROCESSING,
        code="CELL_LINE_CANONICALIZED",
        message="Preserved raw value and added canonical value",
        source_id="src_geo",
        asset_id=f"asset_{SHA_A}",
        record_id="rec_1",
        created_at=NOW,
    )

    assert warning.source_id == "src_geo"


def test_artifact_manifest_entry_must_stay_in_artifacts_directory() -> None:
    with pytest.raises(ValidationError, match="artifacts"):
        ArtifactManifestEntry(
            artifact_id="artifact_main",
            name="main_data.csv",
            relative_path="staging/main_data.csv",
            media_type="text/csv",
            size_bytes=10,
            sha256=SHA_A,
            generated_by_step_id="step_build_1",
        )


def test_validation_summary_status_matches_failure_count() -> None:
    assert ValidationSummary(
        status="valid",
        checked_count=10,
        failed_count=0,
        report_path="logs/validation_report.json",
    ).status == "valid"

    with pytest.raises(ValidationError, match="failed_count"):
        ValidationSummary(
            status="valid",
            checked_count=10,
            failed_count=1,
            report_path="logs/validation_report.json",
        )


def test_run_manifest_requires_sorted_unique_id_lists_and_time_order() -> None:
    artifact = ArtifactManifestEntry(
        artifact_id="artifact_main",
        name="main_data.csv",
        relative_path="artifacts/main_data.csv",
        media_type="text/csv",
        size_bytes=10,
        sha256=SHA_A,
        generated_by_step_id="step_build_1",
    )
    payload = {
        "task_id": "task_1",
        "id_generation_version": "1.0",
        "request": TaskRequest(topic="breast cancer"),
        "specification": TaskSpecification(
            topic="breast cancer",
            requested_outputs=[RequestedOutput.MAIN_DATA],
        ),
        "task_state": TaskState.COMPLETED,
        "stage_attempt_ids": ["stage_attempt_1", "stage_attempt_2"],
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
        "started_at": NOW,
        "finished_at": NOW + timedelta(seconds=2),
    }
    manifest = RunManifest(**payload)
    assert manifest.request.databases == [Database.PUBMED, Database.GEO]

    with pytest.raises(ValidationError, match="sorted and unique"):
        RunManifest(**{**payload, "source_ids": ["src_geo", "src_article"]})
    with pytest.raises(ValidationError, match="sorted and unique"):
        RunManifest(**{**payload, "stage_attempt_ids": ["stage_attempt_1"] * 2})
    with pytest.raises(ValidationError, match="finished_at"):
        RunManifest(**{**payload, "finished_at": NOW - timedelta(seconds=1)})
