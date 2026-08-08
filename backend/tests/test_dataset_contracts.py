"""Contract-level tests for the V2 dataset construction contracts."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from app.datasets.contracts import (
    AcquisitionMode,
    AdapterParams,
    AnnotationStatus,
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
    NormalizationProfile,
    PlatformRecord,
    ProbeMappingStatus,
    ProbeMappingSummary,
    SchemaField,
    SourceBinding,
    SourceBindingAcquisition,
    ValidationProfile,
    ValidationResult,
    ValidationResultStatus,
    ValueScale,
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


# ---------------------------------------------------------------------------
# Phase 4 review B1: build_id / binding_id must be safe single-component IDs
# ---------------------------------------------------------------------------


def test_spec_rejects_path_like_build_id() -> None:
    """Absolute or traversal build_ids must be rejected at model construction."""
    for bad in ("/tmp/outside", "../escape", "a/b", "a\\b", "dir/sub", ".."):
        with pytest.raises(ValidationError, match="build_id"):
            _spec(build_id=bad)


def test_spec_accepts_safe_build_id() -> None:
    spec = _spec(build_id="build_test_42")
    assert spec.build_id == "build_test_42"


def test_source_binding_rejects_path_like_binding_id() -> None:
    """Path-like binding_ids must be rejected before filename interpolation."""
    for bad in ("../../escape", "/tmp/out", "a/b", "a\\b", ".."):
        with pytest.raises(ValidationError, match="binding_id"):
            _spec(
                source_bindings=[
                    SourceBinding(
                        binding_id=bad,
                        source="gdc",
                        acquisition=SourceBindingAcquisition(
                            mode=AcquisitionMode.BUILTIN,
                            provider_id="gdc.files.v1",
                        ),
                        adapter_id="gdc.expression.v1",
                    )
                ]
            )


def test_source_binding_accepts_safe_binding_id() -> None:
    spec = _spec()
    assert spec.source_bindings[0].binding_id == "binding_gdc"


# ---------------------------------------------------------------------------
# Phase 5 T1: ValueScale / AdapterParams / PlatformRecord / ProbeMappingSummary
# ---------------------------------------------------------------------------


def _adapter_params(**overrides: object) -> AdapterParams:
    base: dict[str, object] = {
        "format": "series_matrix",
        "value_semantics": "expression",
        "value_scale": ValueScale.LOG2,
        "expression_unit": "rpkm",
    }
    base.update(overrides)
    return AdapterParams(**base)


def _platform_record(**overrides: object) -> PlatformRecord:
    base: dict[str, object] = {
        "platform_id": "GPL570",
        "source_id": "src_geo_gpl570",
        "annotation_status": AnnotationStatus.MAPPED,
        "probe_id_field": "ID_REF",
        "gene_id_field": "Gene Symbol",
        "target_namespace": "gene_symbol",
        "annotation_asset_id": "asset_gpl570",
        "mapping_source_url": "https://ftp.ncbi.nlm.nih.gov/geo/platforms/GPLnnn/GPL570/",
        "annotation_sha256": "a" * 64,
    }
    base.update(overrides)
    return PlatformRecord(**base)


def _mapping_summary(**overrides: object) -> ProbeMappingSummary:
    base: dict[str, object] = {
        "binding_id": "binding_geo",
        "platform_id": "GPL570",
        "target_namespace": "gene_symbol",
        "mapping_status": ProbeMappingStatus.MAPPED,
        "total_probe_count": 100,
        "mapped_probe_count": 100,
        "unmapped_probe_count": 0,
        "ambiguous_probe_count": 0,
        "coverage_ratio": 1.0,
        "mapping_asset_id": "asset_gpl570",
        "mapping_rule_id": "geo.probe-map.v1",
    }
    base.update(overrides)
    return ProbeMappingSummary(**base)


# -- ValueScale --------------------------------------------------------------


def test_value_scale_members() -> None:
    assert [s.value for s in ValueScale] == ["linear", "log2", "log10", "unknown"]
    assert ValueScale.UNKNOWN == "unknown"


# -- AdapterParams -----------------------------------------------------------


def test_adapter_params_minimal_valid() -> None:
    params = _adapter_params()
    assert params.format == "series_matrix"
    assert params.value_scale is ValueScale.LOG2
    assert params.is_normalized is False
    assert params.platform_ids == []
    assert params.delimiter == "auto"


def test_adapter_params_accepts_unknown_scale() -> None:
    params = _adapter_params(value_scale="unknown")
    assert params.value_scale is ValueScale.UNKNOWN


def test_adapter_params_requires_valid_format() -> None:
    with pytest.raises(ValidationError, match="tximport_counts"):
        _adapter_params(format="bogus_format")


def test_adapter_params_rejects_non_gpl_platform_id() -> None:
    with pytest.raises(ValidationError, match="GPL"):
        _adapter_params(platform_ids=["GPL570", "not-a-gpl"])


def test_adapter_params_accepts_gpl_platform_ids() -> None:
    params = _adapter_params(platform_ids=["GPL570", "GPL96"])
    assert params.platform_ids == ["GPL570", "GPL96"]


def test_adapter_params_rejects_empty_semantics_and_unit() -> None:
    with pytest.raises(ValidationError, match="value_semantics"):
        _adapter_params(value_semantics="")
    with pytest.raises(ValidationError, match="expression_unit"):
        _adapter_params(expression_unit="")


def test_adapter_params_rejects_multi_char_delimiter() -> None:
    with pytest.raises(ValidationError, match="single character"):
        _adapter_params(delimiter=",,")


def test_adapter_params_rejects_delimiter_outside_supplementary() -> None:
    for fmt in ("tximport_counts", "series_matrix"):
        with pytest.raises(ValidationError, match="supplementary_matrix"):
            _adapter_params(format=fmt, delimiter=",")


def test_adapter_params_accepts_delimiter_for_supplementary() -> None:
    params = _adapter_params(format="supplementary_matrix", delimiter="\t")
    assert params.delimiter == "\t"
    params = _adapter_params(format="supplementary_matrix", delimiter="auto")
    assert params.delimiter == "auto"


def test_adapter_params_rejects_unknown_fields() -> None:
    with pytest.raises(ValidationError, match="Extra inputs"):
        _adapter_params(guess_scale_from_filename=True)


# -- PlatformRecord ----------------------------------------------------------


def test_platform_record_valid_mapped() -> None:
    record = _platform_record()
    assert record.annotation_status is AnnotationStatus.MAPPED
    assert record.target_namespace == "gene_symbol"
    assert record.annotation_sha256 == "a" * 64


def test_platform_record_rejects_bad_gpl() -> None:
    for bad in ("GPL", "GPL12x", "gpl570", "GSE570"):
        with pytest.raises(ValidationError, match="GPL"):
            _platform_record(platform_id=bad)


def test_platform_record_not_attempted_forbids_asset_url_sha() -> None:
    with pytest.raises(ValidationError, match="not_attempted"):
        _platform_record(
            annotation_status=AnnotationStatus.NOT_ATTEMPTED,
            annotation_asset_id="asset_x",
        )
    with pytest.raises(ValidationError, match="not_attempted"):
        _platform_record(
            annotation_status=AnnotationStatus.NOT_ATTEMPTED,
            mapping_source_url="https://example.invalid/x",
        )
    with pytest.raises(ValidationError, match="not_attempted"):
        _platform_record(
            annotation_status=AnnotationStatus.NOT_ATTEMPTED,
            annotation_sha256="b" * 64,
        )


def test_platform_record_not_attempted_clean_is_valid() -> None:
    record = _platform_record(
        annotation_status=AnnotationStatus.NOT_ATTEMPTED,
        annotation_asset_id=None,
        mapping_source_url=None,
        annotation_sha256=None,
    )
    assert record.annotation_status is AnnotationStatus.NOT_ATTEMPTED


def test_platform_record_asset_requires_sha() -> None:
    with pytest.raises(ValidationError, match="annotation_sha256"):
        _platform_record(annotation_sha256=None)


def test_platform_record_asset_requires_64_hex_sha() -> None:
    with pytest.raises(ValidationError, match="64 hex"):
        _platform_record(annotation_sha256="zz" * 32)


def test_platform_record_asset_requires_mappable_status() -> None:
    with pytest.raises(ValidationError, match="annotation_status"):
        _platform_record(
            annotation_status=AnnotationStatus.ANNOTATION_UNAVAILABLE,
            annotation_asset_id="asset_x",
        )
    with pytest.raises(ValidationError, match="not_attempted"):
        _platform_record(
            annotation_status=AnnotationStatus.NOT_ATTEMPTED,
            annotation_asset_id="asset_x",
        )


def test_platform_record_mapped_requires_target_and_gene_field() -> None:
    with pytest.raises(ValidationError, match="target_namespace"):
        _platform_record(target_namespace=None)
    with pytest.raises(ValidationError, match="gene_id_field"):
        _platform_record(gene_id_field=None)


def test_platform_record_rejects_unknown_target_namespace() -> None:
    with pytest.raises(ValidationError, match="gene_symbol"):
        _platform_record(target_namespace="geo_probe")


def test_platform_record_unmapped_without_asset_is_valid() -> None:
    record = _platform_record(
        annotation_status=AnnotationStatus.UNMAPPED,
        annotation_asset_id=None,
        annotation_sha256=None,
        target_namespace=None,
        gene_id_field=None,
    )
    assert record.annotation_status is AnnotationStatus.UNMAPPED


# -- ProbeMappingSummary -----------------------------------------------------


def test_mapping_summary_valid_mapped() -> None:
    summary = _mapping_summary()
    assert summary.source_namespace == "geo_probe"
    assert summary.mapping_status is ProbeMappingStatus.MAPPED


def test_mapping_summary_requires_geo_probe_source_namespace() -> None:
    with pytest.raises(ValidationError, match="geo_probe"):
        _mapping_summary(source_namespace="ensembl_gene")


def test_mapping_summary_platform_must_be_gpl_or_none() -> None:
    with pytest.raises(ValidationError, match="GPL"):
        _mapping_summary(platform_id="GSM1")
    assert _mapping_summary(platform_id=None).platform_id is None


def test_mapping_summary_counts_must_balance() -> None:
    with pytest.raises(ValidationError, match="total_probe_count"):
        _mapping_summary(mapped_probe_count=90, unmapped_probe_count=15)


def test_mapping_summary_mapped_cannot_exceed_total() -> None:
    with pytest.raises(ValidationError, match="total_probe_count"):
        _mapping_summary(total_probe_count=10, mapped_probe_count=11)


def test_mapping_summary_ambiguous_subset_of_unmapped() -> None:
    with pytest.raises(ValidationError, match="ambiguous_probe_count"):
        _mapping_summary(
            mapped_probe_count=80,
            unmapped_probe_count=20,
            ambiguous_probe_count=21,
            coverage_ratio=0.8,
        )


def test_mapping_summary_coverage_must_match_ratio() -> None:
    with pytest.raises(ValidationError, match="coverage_ratio"):
        _mapping_summary(
            mapped_probe_count=80,
            unmapped_probe_count=20,
            coverage_ratio=0.5,
        )


def test_mapping_summary_mapped_status_requires_full_coverage() -> None:
    with pytest.raises(ValidationError, match="mapping_status"):
        _mapping_summary(
            mapped_probe_count=80,
            unmapped_probe_count=20,
            coverage_ratio=0.8,
        )


def test_mapping_summary_unmapped_status_requires_zero_coverage() -> None:
    with pytest.raises(ValidationError, match="mapping_status"):
        _mapping_summary(
            mapping_status=ProbeMappingStatus.UNMAPPED,
            mapped_probe_count=1,
            unmapped_probe_count=99,
            coverage_ratio=0.01,
            mapping_asset_id=None,
            mapping_rule_id=None,
        )


def test_mapping_summary_partial_status_requires_strict_between() -> None:
    with pytest.raises(ValidationError, match="mapping_status"):
        _mapping_summary(
            mapping_status=ProbeMappingStatus.PARTIAL,
            mapped_probe_count=0,
            unmapped_probe_count=100,
            coverage_ratio=0.0,
        )
    with pytest.raises(ValidationError, match="mapping_status"):
        _mapping_summary(
            mapping_status=ProbeMappingStatus.PARTIAL,
            mapped_probe_count=100,
            unmapped_probe_count=0,
            coverage_ratio=1.0,
        )


def test_mapping_summary_not_attempted_requires_zero_counts_and_no_assets() -> None:
    with pytest.raises(ValidationError, match="not_attempted"):
        _mapping_summary(
            mapping_status=ProbeMappingStatus.NOT_ATTEMPTED,
            total_probe_count=5,
            mapped_probe_count=5,
            unmapped_probe_count=0,
            coverage_ratio=1.0,
        )
    with pytest.raises(ValidationError, match="not_attempted"):
        _mapping_summary(
            mapping_status=ProbeMappingStatus.NOT_ATTEMPTED,
            total_probe_count=0,
            mapped_probe_count=0,
            unmapped_probe_count=0,
            coverage_ratio=0.0,
            mapping_asset_id="asset_x",
        )


def test_mapping_summary_not_attempted_all_zero_is_valid() -> None:
    summary = _mapping_summary(
        mapping_status=ProbeMappingStatus.NOT_ATTEMPTED,
        platform_id=None,
        target_namespace=None,
        total_probe_count=0,
        mapped_probe_count=0,
        unmapped_probe_count=0,
        ambiguous_probe_count=0,
        coverage_ratio=0.0,
        mapping_asset_id=None,
        mapping_rule_id=None,
    )
    assert summary.coverage_ratio == 0.0


def test_mapping_summary_mapped_or_partial_requires_asset() -> None:
    with pytest.raises(ValidationError, match="mapping_asset_id"):
        _mapping_summary(mapping_asset_id=None)
    with pytest.raises(ValidationError, match="mapping_asset_id"):
        _mapping_summary(
            mapping_status=ProbeMappingStatus.PARTIAL,
            mapped_probe_count=80,
            unmapped_probe_count=20,
            coverage_ratio=0.8,
            mapping_asset_id=None,
        )


def test_mapping_summary_partial_valid() -> None:
    summary = _mapping_summary(
        mapping_status=ProbeMappingStatus.PARTIAL,
        mapped_probe_count=80,
        unmapped_probe_count=20,
        ambiguous_probe_count=5,
        coverage_ratio=0.8,
    )
    assert summary.coverage_ratio == 0.8


# -- Serialization invariants ------------------------------------------------


def test_geo_contracts_round_trip_fidelity() -> None:
    params = _adapter_params(format="supplementary_matrix", delimiter="\t")
    record = _platform_record()
    summary = _mapping_summary()
    for model in (params, record, summary):
        dumped = model.model_dump()
        restored = type(model).model_validate(dumped)
        assert restored.model_dump() == dumped
    # JSON round trip keeps coverage precision within tolerance.
    assert ProbeMappingSummary.model_validate_json(
        _mapping_summary(
            mapping_status=ProbeMappingStatus.PARTIAL,
            total_probe_count=3,
            mapped_probe_count=1,
            unmapped_probe_count=2,
            coverage_ratio=1 / 3,
        ).model_dump_json()
    ).coverage_ratio == pytest.approx(1 / 3, abs=1e-9)


def test_geo_contracts_empty_all_zero_serialize() -> None:
    params = _adapter_params(platform_ids=[], delimiter="auto")
    assert params.model_dump_json() is not None
    record = _platform_record(
        annotation_status=AnnotationStatus.NOT_ATTEMPTED,
        annotation_asset_id=None,
        mapping_source_url=None,
        annotation_sha256=None,
    )
    assert record.model_dump_json() is not None
    summary = _mapping_summary(
        mapping_status=ProbeMappingStatus.NOT_ATTEMPTED,
        platform_id=None,
        target_namespace=None,
        total_probe_count=0,
        mapped_probe_count=0,
        unmapped_probe_count=0,
        ambiguous_probe_count=0,
        coverage_ratio=0.0,
        mapping_asset_id=None,
        mapping_rule_id=None,
    )
    assert summary.model_dump_json() is not None


# -- DatasetBuildSpec.target_entity_level ------------------------------------


def test_spec_accepts_target_entity_level() -> None:
    assert _spec(target_entity_level="gene").target_entity_level == "gene"
    assert _spec(target_entity_level="probe").target_entity_level == "probe"
    assert _spec().target_entity_level is None


def test_spec_rejects_unknown_target_entity_level() -> None:
    with pytest.raises(ValidationError, match="target_entity_level"):
        _spec(target_entity_level="transcript")


# -- NormalizationProfile.allowed_value_scales (Phase 5 T4, spec D3) ---------


def _normalization_profile(**overrides: object) -> NormalizationProfile:
    base: dict[str, object] = {
        "profile_id": "gene_expression.normalization.test.v1",
        "dataset_family": "gene_expression",
        "allowed_namespaces": ["ensembl_gene", "gene_symbol"],
        "allowed_units": ["expression_value", "tpm"],
        "allowed_semantics": ["expression_value", "raw_count"],
        "allowed_value_scales": [ValueScale.LINEAR, ValueScale.LOG2],
        "aggregation_policy": "keep_all",
    }
    base.update(overrides)
    return NormalizationProfile(**base)


def test_normalization_profile_requires_allowed_value_scales() -> None:
    """A profile without a value-scale allowlist is rejected (T4 D3)."""
    with pytest.raises(ValidationError, match="allowed_value_scales"):
        NormalizationProfile(
            profile_id="gene_expression.normalization.test.v1",
            dataset_family="gene_expression",
            allowed_namespaces=["ensembl_gene"],
            allowed_units=["expression_value"],
            allowed_semantics=["expression_value"],
        )


def test_normalization_profile_rejects_empty_scale_allowlist() -> None:
    with pytest.raises(ValidationError, match="allowed_value_scales"):
        _normalization_profile(allowed_value_scales=[])


def test_normalization_profile_accepts_value_scale_members() -> None:
    profile = _normalization_profile()
    assert profile.allowed_value_scales == [ValueScale.LINEAR, ValueScale.LOG2]


def test_normalization_profile_coerces_scale_strings() -> None:
    profile = _normalization_profile(
        allowed_value_scales=["linear", "unknown", "log10"]
    )
    assert profile.allowed_value_scales == [
        ValueScale.LINEAR,
        ValueScale.UNKNOWN,
        ValueScale.LOG10,
    ]


def test_normalization_profile_rejects_unknown_scale_literal() -> None:
    """A non-ValueScale literal is invalid input, not silently accepted."""
    with pytest.raises(ValidationError):
        _normalization_profile(allowed_value_scales=["raw_count"])


# -- ValidationProfile.required_entity_level (Phase 5 T4, spec D4) -----------


def _validation_profile(**overrides: object) -> ValidationProfile:
    base: dict[str, object] = {
        "profile_id": "gene_expression.release.test.v1",
        "dataset_family": "gene_expression",
        "required_entity_level": "gene",
    }
    base.update(overrides)
    return ValidationProfile(**base)


def test_validation_profile_requires_entity_level() -> None:
    """The server-side profile must declare its required entity level (D4)."""
    with pytest.raises(ValidationError, match="required_entity_level"):
        ValidationProfile(
            profile_id="gene_expression.release.test.v1",
            dataset_family="gene_expression",
        )


def test_validation_profile_entity_level_values() -> None:
    assert _validation_profile().required_entity_level == "gene"
    assert (
        _validation_profile(required_entity_level="probe").required_entity_level
        == "probe"
    )
    assert _validation_profile(required_entity_level="any").required_entity_level == "any"


def test_validation_profile_rejects_unknown_entity_level() -> None:
    with pytest.raises(ValidationError, match="required_entity_level"):
        _validation_profile(required_entity_level="transcript")
