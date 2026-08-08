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
        allowed_validation_profiles=frozenset({"gene_expression.release.v1"}),
    ).validate(
        _spec(
            schema_ref="gene_expression.probe_long.v1",
            row_granularity="probe_sample_measurement",
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


def test_unset_target_entity_level_is_always_consistent() -> None:
    result = SpecValidator(
        _dual_registry(),
        allowed_validation_profiles=frozenset({"gene_expression.release.v1"}),
    ).validate(
        _spec(
            schema_ref="gene_expression.probe_long.v1",
            row_granularity="probe_sample_measurement",
        )
    )
    assert result.valid is True
