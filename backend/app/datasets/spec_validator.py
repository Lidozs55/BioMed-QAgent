"""Spec Validator for DatasetBuildSpec (ARCHITECTURE §3.1; Design §9.2).

Pure function module; Phase 1 does not wire it into the runtime yet. A rejected
spec yields structured reason codes consumed later by ``BuildResult.SPEC_REJECTED``.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.datasets.contracts import DatasetBuildSpec
from app.datasets.schema_registry import SchemaRegistry


@dataclass(frozen=True)
class SpecValidationResult:
    valid: bool
    reason_codes: tuple[str, ...] = ()
    reasons: tuple[str, ...] = ()


# Phase 5 D2: map a registered schema's row granularity to the entity level
# it publishes.  ``target_entity_level`` in the spec must agree with this;
# a mismatch is a spec error (invalid_input), not a later pipeline failure.
_ENTITY_LEVEL_BY_GRANULARITY: dict[str, str] = {
    "gene_sample_measurement": "gene",
    "probe_sample_measurement": "probe",
}


class SpecValidator:
    """Checks a spec against the registry before any download starts.

    The validation-profile allowlist is **fail-closed**: an empty allowlist
    rejects every ``validation_profile_ref`` (there is no way to tell "not yet
    configured" from "deliberately deny all", so the safe default is deny),
    preventing an Agent from silently selecting an arbitrary profile when the
    runtime forgets to inject the allowlist.
    """

    def __init__(
        self,
        registry: SchemaRegistry,
        allowed_validation_profiles: frozenset[str] = frozenset(),
    ) -> None:
        self._registry = registry
        self._allowed_profiles = allowed_validation_profiles

    def validate(self, spec: DatasetBuildSpec) -> SpecValidationResult:
        codes: list[str] = []
        reasons: list[str] = []

        if not self._registry.contains(spec.schema_ref):
            codes.append("unknown_schema")
            reasons.append(f"schema {spec.schema_ref!r} is not registered")
        else:
            schema = self._registry.get(spec.schema_ref)
            if schema.dataset_family != spec.dataset_family:
                codes.append("family_mismatch")
                reasons.append("spec dataset_family does not match the target schema")
            known = {field.name for field in schema.fields}
            missing = [name for name in spec.required_fields if name not in known]
            if missing:
                codes.append("unknown_required_field")
                reasons.append(f"required fields not in schema: {sorted(missing)}")
            if spec.target_entity_level is not None:
                granularity_level = _ENTITY_LEVEL_BY_GRANULARITY.get(
                    schema.row_granularity
                )
                if granularity_level != spec.target_entity_level:
                    codes.append("entity_level_schema_mismatch")
                    reasons.append(
                        f"target_entity_level {spec.target_entity_level!r} is not "
                        f"consistent with schema {spec.schema_ref!r} "
                        f"(row_granularity {schema.row_granularity!r})"
                    )

        if spec.validation_profile_ref not in self._allowed_profiles:
            codes.append("profile_not_allowed")
            reasons.append(
                f"validation profile {spec.validation_profile_ref!r} is not on "
                "the server allowlist"
            )

        if codes:
            return SpecValidationResult(
                valid=False,
                reason_codes=tuple(codes),
                reasons=tuple(reasons),
            )
        return SpecValidationResult(valid=True)
