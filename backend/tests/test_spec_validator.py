"""Spec Validator tests covering every rejection reason code."""

from __future__ import annotations

from app.datasets.contracts import (
    AcquisitionMode,
    DatasetBuildSpec,
    SourceBinding,
    SourceBindingAcquisition,
)
from app.datasets.schema_registry import (
    SchemaRegistry,
    build_gene_expression_schema,
    build_probe_expression_schema,
)
from app.datasets.spec_validator import SpecValidator


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


def _registry() -> SchemaRegistry:
    return SchemaRegistry([build_gene_expression_schema()])


def _dual_registry() -> SchemaRegistry:
    return SchemaRegistry(
        [build_gene_expression_schema(), build_probe_expression_schema()]
    )


def test_valid_spec_passes() -> None:
    result = SpecValidator(
        _registry(),
        allowed_validation_profiles=frozenset({"gene_expression.release.v1"}),
    ).validate(_spec())
    assert result.valid is True
    assert result.reason_codes == ()


def test_empty_allowlist_rejects_every_profile() -> None:
    """Fail-closed guard: an unconfigured allowlist must deny all profiles.

    Regression for the review finding: an empty allowlist used to skip the
    check entirely, so a runtime that forgot to inject the allowlist would let
    the Agent select an arbitrary (possibly threshold-relaxing) profile.
    """
    result = SpecValidator(_registry()).validate(_spec())
    assert result.valid is False
    assert "profile_not_allowed" in result.reason_codes


def test_unknown_schema_rejected() -> None:
    result = SpecValidator(_registry()).validate(_spec(schema_ref="missing.v1"))
    assert result.valid is False
    assert "unknown_schema" in result.reason_codes


def test_family_mismatch_rejected() -> None:
    result = SpecValidator(_registry()).validate(
        _spec(dataset_family="pathway_member")
    )
    assert result.valid is False
    assert "family_mismatch" in result.reason_codes


def test_unknown_required_field_rejected() -> None:
    result = SpecValidator(_registry()).validate(
        _spec(required_fields=["no_such_field"])
    )
    assert result.valid is False
    assert "unknown_required_field" in result.reason_codes


def test_profile_not_on_allowlist_rejected() -> None:
    validator = SpecValidator(
        _registry(),
        allowed_validation_profiles=frozenset({"gene_expression.release.v1"}),
    )
    result = validator.validate(_spec(validation_profile_ref="other.profile.v1"))
    assert result.valid is False
    assert "profile_not_allowed" in result.reason_codes


def test_multiple_failures_are_aggregated() -> None:
    result = SpecValidator(_registry()).validate(
        _spec(
            dataset_family="pathway_member",
            required_fields=["no_such_field"],
        )
    )
    assert result.valid is False
    assert {"family_mismatch", "unknown_required_field"} <= set(
        result.reason_codes
    )


# ---------------------------------------------------------------------------
# Phase 5 T1: target_entity_level consistency with the selected schema
# ---------------------------------------------------------------------------


def test_probe_schema_selectable_with_matching_entity_level() -> None:
    """The probe-level contract is a valid Spec Validator target (Phase 5 D2)."""
    result = SpecValidator(
        _dual_registry(),
        allowed_validation_profiles=frozenset(
            {"gene_expression.release.v1", "gene_expression.probe_release.v1"}
        ),
    ).validate(
        _spec(
            schema_ref="gene_expression.probe_long.v1",
            row_granularity="probe_sample_measurement",
            validation_profile_ref="gene_expression.probe_release.v1",
            target_entity_level="probe",
        )
    )
    assert result.valid is True
    assert result.reason_codes == ()


def test_entity_level_mismatch_with_schema_rejected() -> None:
    """target_entity_level must agree with the selected schema's granularity."""
    validator = SpecValidator(
        _dual_registry(),
        allowed_validation_profiles=frozenset({"gene_expression.release.v1"}),
    )
    # probe build on the gene schema
    result = validator.validate(
        _spec(schema_ref="gene_expression.long.v1", target_entity_level="probe")
    )
    assert result.valid is False
    assert "entity_level_schema_mismatch" in result.reason_codes
    # gene build on the probe schema
    result = validator.validate(
        _spec(
            schema_ref="gene_expression.probe_long.v1",
            row_granularity="probe_sample_measurement",
            target_entity_level="gene",
        )
    )
    assert result.valid is False
    assert "entity_level_schema_mismatch" in result.reason_codes


def test_unset_target_entity_level_derives_from_profile() -> None:
    """An unset target_entity_level derives from the profile's required level.

    Phase 5 D4: the effective entity level is the selected validation
    profile's ``required_entity_level`` and must be consistent with the
    selected schema's granularity.
    """
    validator = SpecValidator(
        _dual_registry(),
        allowed_validation_profiles=frozenset(
            {"gene_expression.release.v1", "gene_expression.probe_release.v1"}
        ),
    )
    # gene profile + gene schema: consistent
    assert validator.validate(_spec()).valid is True
    # probe profile + probe schema: consistent
    assert validator.validate(
        _spec(
            schema_ref="gene_expression.probe_long.v1",
            row_granularity="probe_sample_measurement",
            validation_profile_ref="gene_expression.probe_release.v1",
        )
    ).valid is True
    # gene profile + probe schema: profile decides "gene" -> inconsistent
    result = validator.validate(
        _spec(
            schema_ref="gene_expression.probe_long.v1",
            row_granularity="probe_sample_measurement",
        )
    )
    assert result.valid is False
    assert "entity_level_schema_mismatch" in result.reason_codes
    # probe profile + gene schema: profile decides "probe" -> inconsistent
    result = validator.validate(
        _spec(validation_profile_ref="gene_expression.probe_release.v1")
    )
    assert result.valid is False
    assert "entity_level_schema_mismatch" in result.reason_codes


# ---------------------------------------------------------------------------
# Phase 5 T4: target_entity_level vs profile.required_entity_level (spec D4)
# ---------------------------------------------------------------------------


def test_gene_build_with_probe_profile_rejected() -> None:
    """gene build + probe profile is invalid input (D4)."""
    result = SpecValidator(
        _dual_registry(),
        allowed_validation_profiles=frozenset(
            {"gene_expression.release.v1", "gene_expression.probe_release.v1"}
        ),
    ).validate(
        _spec(
            validation_profile_ref="gene_expression.probe_release.v1",
            target_entity_level="gene",
        )
    )
    assert result.valid is False
    assert "entity_level_profile_mismatch" in result.reason_codes


def test_probe_build_with_gene_profile_rejected() -> None:
    """probe build + gene profile is invalid input (D4)."""
    result = SpecValidator(
        _dual_registry(),
        allowed_validation_profiles=frozenset(
            {"gene_expression.release.v1", "gene_expression.probe_release.v1"}
        ),
    ).validate(
        _spec(
            schema_ref="gene_expression.probe_long.v1",
            row_granularity="probe_sample_measurement",
            validation_profile_ref="gene_expression.release.v1",
            target_entity_level="probe",
        )
    )
    assert result.valid is False
    assert "entity_level_profile_mismatch" in result.reason_codes


# ---------------------------------------------------------------------------
# Phase 5 T2: per-binding AdapterParams validation (spec D1)
# ---------------------------------------------------------------------------


def _geo_binding(**overrides: object) -> SourceBinding:
    base: dict[str, object] = {
        "binding_id": "binding_geo",
        "source": "geo",
        "acquisition": SourceBindingAcquisition(
            mode=AcquisitionMode.BUILTIN, provider_id="geo.series.v1"
        ),
        "adapter_id": "geo.expression.v1",
        "accession": "GSE178352",
        "parameters": {
            "format": "series_matrix",
            "value_semantics": "normalized_expression_value",
            "value_scale": "log2",
            "expression_unit": "normalized_expression_value",
            "platform_ids": ["GPL570"],
        },
    }
    base.update(overrides)
    return SourceBinding(**base)


def _geo_spec(binding: SourceBinding) -> DatasetBuildSpec:
    return _spec(source_bindings=[binding])


def test_geo_binding_valid_parameters_pass() -> None:
    """A geo.expression.v1 binding with valid AdapterParams validates."""
    result = SpecValidator(
        _dual_registry(),
        allowed_validation_profiles=frozenset({"gene_expression.release.v1"}),
    ).validate(_geo_spec(_geo_binding()))
    assert result.valid is True
    assert result.reason_codes == ()


def test_geo_binding_missing_parameters_rejected() -> None:
    """geo.expression.v1 requires adapter parameters (format is mandatory)."""
    result = SpecValidator(
        _dual_registry(),
        allowed_validation_profiles=frozenset({"gene_expression.release.v1"}),
    ).validate(_geo_spec(_geo_binding(parameters={})))
    assert result.valid is False
    assert "invalid_adapter_parameters" in result.reason_codes


def test_geo_binding_unknown_format_rejected() -> None:
    """An unknown format literal is invalid input, not a later parse error."""
    params = {
        "format": "bogus_format",
        "value_semantics": "expression",
        "value_scale": "log2",
        "expression_unit": "expression",
    }
    result = SpecValidator(
        _dual_registry(),
        allowed_validation_profiles=frozenset({"gene_expression.release.v1"}),
    ).validate(_geo_spec(_geo_binding(parameters=params)))
    assert result.valid is False
    assert "invalid_adapter_parameters" in result.reason_codes


def test_geo_binding_inapplicable_delimiter_rejected() -> None:
    """delimiter outside supplementary_matrix is invalid (spec D1)."""
    params = {
        "format": "series_matrix",
        "value_semantics": "expression",
        "value_scale": "log2",
        "expression_unit": "expression",
        "delimiter": ";",
    }
    result = SpecValidator(
        _dual_registry(),
        allowed_validation_profiles=frozenset({"gene_expression.release.v1"}),
    ).validate(_geo_spec(_geo_binding(parameters=params)))
    assert result.valid is False
    assert "invalid_adapter_parameters" in result.reason_codes


def test_geo_binding_unknown_field_rejected() -> None:
    """Unknown/extra parameters are rejected (AdapterParams is extra=forbid)."""
    params = {
        "format": "series_matrix",
        "value_semantics": "expression",
        "value_scale": "log2",
        "expression_unit": "expression",
        "smuggled_threshold": 0.5,
    }
    result = SpecValidator(
        _dual_registry(),
        allowed_validation_profiles=frozenset({"gene_expression.release.v1"}),
    ).validate(_geo_spec(_geo_binding(parameters=params)))
    assert result.valid is False
    assert "invalid_adapter_parameters" in result.reason_codes


def test_non_geo_binding_parameters_rejected() -> None:
    """Adapter parameters are only applicable to geo.expression.v1 (spec D1)."""
    binding = SourceBinding(
        binding_id="binding_gdc",
        source="gdc",
        acquisition=SourceBindingAcquisition(
            mode=AcquisitionMode.BUILTIN, provider_id="gdc.files.v1"
        ),
        adapter_id="gdc.expression.star_counts.v1",
        accession="TCGA-COAD",
        parameters={"format": "series_matrix"},
    )
    result = SpecValidator(
        _dual_registry(),
        allowed_validation_profiles=frozenset({"gene_expression.release.v1"}),
    ).validate(_spec(source_bindings=[binding]))
    assert result.valid is False
    assert "invalid_adapter_parameters" in result.reason_codes
