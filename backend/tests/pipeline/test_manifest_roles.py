"""Artifact role classification for V1 manifest entries (P1 audit_report).

Verifies that:
- ``role_for_filename`` maps known staging artifact names to the intended
  ``ArtifactRole`` and falls back to ``AUDIT_REPORT`` for unknown names.
- ``ArtifactManifestEntry`` requires the ``role`` field (no silent default).
"""
from __future__ import annotations

import pytest
from app.datasets.contracts import ArtifactRole
from app.domain.contracts.pipeline import ArtifactManifestEntry


def test_artifact_role_for_filename() -> None:
    from app.pipeline.stages.validation.runner import role_for_filename

    assert role_for_filename("main_data.csv") is ArtifactRole.PRIMARY_DATASET
    assert role_for_filename("schema.json") is ArtifactRole.SCHEMA
    assert role_for_filename("source_list.csv") is ArtifactRole.AUDIT_REPORT
    assert role_for_filename("field_mapping.csv") is ArtifactRole.PROVENANCE
    assert role_for_filename("run_manifest.json") is ArtifactRole.SCHEMA


def test_manifest_entry_requires_role() -> None:
    with pytest.raises(ValueError):
        ArtifactManifestEntry(
            artifact_id="a",
            name="main_data.csv",
            relative_path="artifacts/main_data.csv",
            media_type="text/csv",
            size_bytes=1,
            sha256="a" * 64,
            generated_by_step_id="s",
        )  # 缺 role 必须报错


def test_manifest_serialization_carries_role() -> None:
    """Consumers reading a serialized manifest entry see the role field.

    ``list_artifacts`` (routes.py) and the pipeline both load ``run_manifest.json``
    via ``RunManifest.model_validate_json``; the role must survive the wire
    format for downstream consumers.
    """
    entry = ArtifactManifestEntry(
        artifact_id="a",
        role=ArtifactRole.PRIMARY_DATASET,
        name="main_data.csv",
        relative_path="artifacts/main_data.csv",
        media_type="text/csv",
        size_bytes=1,
        sha256="a" * 64,
        generated_by_step_id="s",
    )
    serialized = ArtifactManifestEntry.model_validate_json(entry.model_dump_json())
    assert serialized.role is ArtifactRole.PRIMARY_DATASET
