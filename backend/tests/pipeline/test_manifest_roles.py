"""Artifact role classification for V1 manifest entries (P1 audit_report).

Verifies that:
- ``role_for_filename`` maps known staging artifact names to the intended
  ``ArtifactRole`` and falls back to ``AUDIT_REPORT`` for unknown names.
- ``ArtifactManifestEntry`` without an explicit ``role`` defaults to
  ``AUDIT_REPORT`` (legacy tolerance: pre-T8 manifests/events lack the field),
  while an explicit role is never overridden.
- The role survives the production read path: serializing a ``RunManifest``
  (as ``run_manifest.json``) and reloading it preserves the role.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.datasets.contracts import ArtifactRole
from app.domain.contracts import (
    ArtifactManifestEntry,
    RunManifest,
    TaskRequest,
    TaskSpecification,
    TaskState,
    ValidationSummary,
)

NOW = datetime(2026, 7, 12, tzinfo=UTC)
_SHA_A = "a" * 64


def test_artifact_role_for_filename() -> None:
    from app.pipeline.stages.validation.runner import role_for_filename

    assert role_for_filename("main_data.csv") is ArtifactRole.PRIMARY_DATASET
    assert role_for_filename("schema.json") is ArtifactRole.SCHEMA
    assert role_for_filename("source_list.csv") is ArtifactRole.AUDIT_REPORT
    assert role_for_filename("field_mapping.csv") is ArtifactRole.PROVENANCE
    assert role_for_filename("run_manifest.json") is ArtifactRole.SCHEMA


def test_manifest_entry_without_role_defaults_to_audit_report() -> None:
    """Pre-T8 manifests/events lack ``role``; they must still load.

    Global Constraints: old persisted ``events.jsonl`` and ``run_manifest.json``
    files must replay/load correctly, so an omitted ``role`` defaults to
    ``AUDIT_REPORT`` instead of raising.
    """
    entry = ArtifactManifestEntry(
        artifact_id="a",
        name="legacy.csv",
        relative_path="artifacts/legacy.csv",
        media_type="text/csv",
        size_bytes=1,
        sha256=_SHA_A,
        generated_by_step_id="s",
    )
    assert entry.role is ArtifactRole.AUDIT_REPORT


def test_manifest_entry_explicit_role_is_not_overridden() -> None:
    """An explicit ``role`` always wins over the legacy default."""
    entry = ArtifactManifestEntry(
        artifact_id="a",
        role=ArtifactRole.PRIMARY_DATASET,
        name="main_data.csv",
        relative_path="artifacts/main_data.csv",
        media_type="text/csv",
        size_bytes=1,
        sha256=_SHA_A,
        generated_by_step_id="s",
    )
    assert entry.role is ArtifactRole.PRIMARY_DATASET


def _minimal_manifest(role: ArtifactRole) -> RunManifest:
    return RunManifest(
        task_id="task_1",
        id_generation_version="1.0",
        request=TaskRequest(topic="breast cancer"),
        specification=TaskSpecification(topic="breast cancer"),
        task_state=TaskState.COMPLETED,
        stage_attempt_ids=["stage_attempt_1"],
        source_ids=["src_article"],
        artifacts=[
            ArtifactManifestEntry(
                artifact_id="artifact_a",
                role=role,
                name="main_data.csv",
                relative_path="artifacts/main_data.csv",
                media_type="text/csv",
                size_bytes=1,
                sha256=_SHA_A,
                generated_by_step_id="step_build_1",
            )
        ],
        validation=ValidationSummary(
            status="valid",
            checked_count=10,
            failed_count=0,
            report_path="logs/validation_report.json",
        ),
        pipeline_version="0.1.0",
        started_at=NOW,
        finished_at=NOW + timedelta(seconds=2),
    )


def test_manifest_serialization_carries_role() -> None:
    """Consumers reading ``run_manifest.json`` see the role field.

    ``list_artifacts`` (routes.py) and the pipeline both load manifests via
    ``RunManifest.model_validate_json``; the role must survive the wire
    format for downstream consumers.
    """
    manifest = _minimal_manifest(role=ArtifactRole.PRIMARY_DATASET)
    reloaded = RunManifest.model_validate_json(manifest.model_dump_json())
    assert reloaded.artifacts[0].role is ArtifactRole.PRIMARY_DATASET
