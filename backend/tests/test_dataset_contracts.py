"""Contract-level tests for the V2 dataset construction contracts."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from app.datasets.contracts import (
    AcquisitionMode,
    ArtifactRole,
    BuildResult,
    BuildResultStatus,
    ConfidenceComponents,
    ConfidenceLevel,
    ConfidenceRecord,
    DataBatch,
    DatasetBuildSpec,
    DatasetManifest,
    DatasetPublication,
    DatasetSchema,
    FieldMapping,
    ManifestArtifactEntry,
    MappingMethod,
    MappingReviewStatus,
    SchemaField,
    SourceBinding,
    SourceBindingAcquisition,
    ValidationResult,
    ValidationResultStatus,
)
from pydantic import ValidationError


def _spec(**overrides: object) -> DatasetBuildSpec:
    base: dict[str, object] = {
        "build_id": "build_test",
        "objective": "compare TP53 expression",
        "dataset_family": "gene_expression",
        "row_granularity": "gene_sample_measurement",
        "schema_ref": "gene_expression.long.v1",
        "source_bindings": [
            SourceBinding(
                binding_id="binding_gdc",
                source="gdc",
                acquisition=SourceBindingAcquisition(
                    mode=AcquisitionMode.BUILTIN, provider_id="gdc.files.v1"
                ),
                adapter_id="gdc.expression.star_counts.v1",
                accession="TCGA-COAD",
            )
        ],
        "validation_profile_ref": "gene_expression.release.v1",
    }
    base.update(overrides)
    return DatasetBuildSpec(**base)


def test_spec_rejects_acceptance_threshold_fields() -> None:
    with pytest.raises(ValidationError, match="minimum_valid_rows"):
        _spec(minimum_valid_rows=100)


def test_spec_requires_at_least_one_source_binding() -> None:
    with pytest.raises(ValidationError, match="source_bindings"):
        _spec(source_bindings=[])


def test_builtin_acquisition_requires_provider() -> None:
    with pytest.raises(ValidationError, match="provider_id"):
        SourceBindingAcquisition(mode=AcquisitionMode.BUILTIN)


def test_recipe_acquisition_requires_recipe_id_and_version() -> None:
    with pytest.raises(ValidationError, match="recipe_id"):
        SourceBindingAcquisition(
            mode=AcquisitionMode.WORKFLOW_RECIPE, recipe_version=1
        )
    with pytest.raises(ValidationError, match="recipe_version"):
        SourceBindingAcquisition(
            mode=AcquisitionMode.WORKFLOW_RECIPE, recipe_id="recipe_x"
        )


def test_string_similarity_mapping_must_remain_proposed() -> None:
    with pytest.raises(ValidationError, match="proposed"):
        FieldMapping(
            mapping_id="map_1",
            source_schema_ref="xena.source.v1",
            target_schema_ref="gene_expression.long.v1",
            source_field="sample",
            target_field="sample_id",
            mapping_method=MappingMethod.STRING_SIMILARITY,
            evidence="column name similarity",
            review_status=MappingReviewStatus.ACCEPTED,
        )


def test_schema_primary_key_must_exist_in_fields() -> None:
    with pytest.raises(ValidationError, match="primary_key"):
        DatasetSchema(
            schema_id="broken.v1",
            dataset_family="gene_expression",
            row_granularity="gene_sample_measurement",
            primary_key=["missing_key"],
            fields=[
                SchemaField(
                    name="gene_id", data_type="string",
                    semantic_role="entity_identifier",
                )
            ],
        )


def test_build_result_state_constraints() -> None:
    # Succeeded requires a publication id.
    with pytest.raises(ValidationError, match="publication_id"):
        BuildResult(
            status=BuildResultStatus.SUCCEEDED,
            valid_row_count=10,
            successful_sources=["gdc"],
        )
    # NO_DATA must not carry rows.
    with pytest.raises(ValidationError, match="zero valid rows"):
        BuildResult(
            status=BuildResultStatus.NO_DATA,
            valid_row_count=3,
            reason_codes=["no_compatible_source"],
        )
    # SPEC_REJECTED requires reason codes.
    with pytest.raises(ValidationError, match="reason_codes"):
        BuildResult(status=BuildResultStatus.SPEC_REJECTED, valid_row_count=0)
    # Publication id is only valid on succeeded / partial success.
    with pytest.raises(ValidationError, match="publication_id"):
        BuildResult(
            status=BuildResultStatus.NO_DATA,
            valid_row_count=0,
            publication_id="pub_1",
            reason_codes=["no_compatible_source"],
        )


def test_build_result_valid_state() -> None:
    result = BuildResult(
        status=BuildResultStatus.SUCCEEDED,
        valid_row_count=42,
        successful_sources=["gdc"],
        available_artifact_roles=[ArtifactRole.PRIMARY_DATASET],
        publication_id="pub_1",
        user_summary="42 rows published",
    )
    assert result.publication_id == "pub_1"


def test_validation_result_count_invariants() -> None:
    with pytest.raises(ValidationError, match="failed_count"):
        ValidationResult(
            manifest_digest="a" * 64,
            profile_ref="gene_expression.release.v1",
            status=ValidationResultStatus.PASSED,
            checked_count=5,
            failed_count=1,
        )


def test_manifest_at_most_one_primary() -> None:
    entry = ManifestArtifactEntry(
        artifact_id="art_1",
        role=ArtifactRole.PRIMARY_DATASET,
        relative_path="data/main.csv",
        media_type="text/csv",
        size_bytes=10,
        sha256="b" * 64,
    )
    with pytest.raises(ValidationError, match="at most one primary"):
        DatasetManifest(
            manifest_id="manifest_1",
            task_id="task_1",
            build_id="build_1",
            dataset_family="gene_expression",
            row_granularity="gene_sample_measurement",
            schema_ref="gene_expression.long.v1",
            row_count=5,
            sha256="c" * 64,
            artifacts=[entry, entry],
        )


def test_publication_cannot_supersede_itself() -> None:
    with pytest.raises(ValidationError, match="supersede"):
        DatasetPublication(
            publication_id="pub_1",
            manifest_ref="manifest_1",
            validation_result_ref="vr_1",
            published_at=datetime.now(UTC),
            supersedes_publication_id="pub_1",
        )


def test_confidence_record_round_trip() -> None:
    record = ConfidenceRecord(
        confidence_id="conf_1",
        record_id="rec_1",
        level=ConfidenceLevel.MEDIUM,
        channel="vlm_chart_extraction",
        components=ConfidenceComponents(
            source_reliability=ConfidenceLevel.HIGH,
            extraction_reliability=ConfidenceLevel.MEDIUM,
        ),
        reasons=["vlm_l1"],
        requires_human_review=True,
    )
    assert record.components.extraction_reliability is ConfidenceLevel.MEDIUM


def test_data_batch_contract() -> None:
    batch = DataBatch(
        batch_id="batch_1",
        binding_id="binding_gdc",
        dataset_family="gene_expression",
        row_granularity="gene_sample_measurement",
        schema_ref="gdc.star_counts.source.v1",
        row_count=100,
        column_count=18,
        parser_id="gdc.star_counts.parser",
        parser_version="1.2.0",
    )
    assert batch.row_count == 100
