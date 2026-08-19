/**
 * Spec Validator for DatasetBuildSpec (ARCHITECTURE §3.1; Design §9.2; Python
 * ``backend/app/datasets/spec_validator.py``).
 *
 * Pure function module. A rejected spec yields structured reason codes
 * consumed later by ``BuildResult.SPEC_REJECTED``.
 */

import { parseAdapterParams } from "../contracts/index.js";
import type { DatasetBuildSpec } from "../contracts/index.js";
import { getNormalizationProfile } from "../canonicalizer/index.js";
import type { DatasetFamilyRegistry } from "../families/index.js";
import { getValidationProfile } from "./profile.js";
import { providerCarrierBinding } from "../runtime/provider-bindings.js";

/** Outcome of a spec pre-check (Python frozen dataclass). */
export interface SpecValidationResult {
  valid: boolean;
  reason_codes: string[];
  reasons: string[];
}

export function specValid(): SpecValidationResult {
  return { valid: true, reason_codes: [], reasons: [] };
}

// Phase 5 D2: map a registered schema's row granularity to the entity level
// it publishes. ``target_entity_level`` in the spec must agree with this; a
// mismatch is a spec error (invalid_input), not a later pipeline failure.
const ENTITY_LEVEL_BY_GRANULARITY: Record<string, string> = {
  gene_sample_measurement: "gene",
  probe_sample_measurement: "probe",
};

export const GEO_EXPRESSION_ADAPTER_ID = "geo.expression.v1";

/** Source capabilities (Python ``SOURCE_CAPABILITIES``, TODO §1.4). */
const SOURCE_CAPABILITIES: Record<string, string> = {
  pubmed: "pipeline_supported",
  geo: "pipeline_supported",
  gdc: "pipeline_supported",
  ucsc_xena: "pipeline_supported",
  reactome: "pipeline_supported",
  pdb: "research_only",
  pubchem: "research_only",
  browser: "research_only",
  uniprot: "research_only",
  chembl: "research_only",
};

/** Stable identifier aliases (Python ``DATABASE_IDENTIFIER_ALIASES``). */
const DATABASE_IDENTIFIER_ALIASES: Record<string, string> = {
  pubmed: "pubmed",
  geo: "geo",
  gdc: "gdc",
  xena: "ucsc_xena",
  ucsc_xena: "ucsc_xena",
  pdb: "pdb",
  reactome: "reactome",
  pubchem: "pubchem",
  browser: "browser",
  uniprot: "uniprot",
  chembl: "chembl",
};

/**
 * Resolve a validation profile's ``required_entity_level`` (Phase 5 D4).
 * Returns ``null`` when the profile cannot be resolved — an allowed-but-
 * unregistered profile is a server misconfiguration; the allowlist already
 * gates admission, so entity-level resolution degrades to unconstrained
 * instead of crashing the validator.
 */
function profileEntityLevel(profileRef: string): string | null {
  try {
    return getValidationProfile(profileRef).required_entity_level;
  } catch {
    return null;
  }
}

/**
 * Resolve the normalization profile (default when omitted).  Returns ``null``
 * when an explicit ref is unregistered: the build would fail later in the
 * runner anyway, so the pre-check degrades to skipping the unit/semantics/
 * scale cross-check instead of crashing the validator.
 */
function resolveNormalizationProfile(profileRef: string | null | undefined) {
  try {
    return getNormalizationProfile(profileRef);
  } catch {
    return null;
  }
}

function familyDefinitionFor(
  registry: DatasetFamilyRegistry | null,
  familyId: string,
): ReturnType<DatasetFamilyRegistry["get"]> | null {
  if (registry === null) return null;
  try {
    return registry.get(familyId);
  } catch {
    return null;
  }
}

function validateLegacyAdapterParameters(
  binding: DatasetBuildSpec["source_bindings"][number],
  normalizationProfile: ReturnType<typeof resolveNormalizationProfile>,
  codes: string[],
  reasons: string[],
): void {
  if (binding.adapter_id === GEO_EXPRESSION_ADAPTER_ID) {
    const parameters = binding.parameters;
    if (parameters === null || parameters === undefined || Object.keys(parameters).length === 0) {
      codes.push("invalid_adapter_parameters");
      reasons.push(
        `binding ${pyRepr(binding.binding_id)} (geo.expression.v1) requires adapter parameters ` +
          "(format/value_semantics/value_scale/expression_unit)",
      );
      return;
    }
    let params: ReturnType<typeof parseAdapterParams> | null = null;
    try {
      params = parseAdapterParams(parameters);
    } catch (error) {
      codes.push("invalid_adapter_parameters");
      reasons.push(
        `binding ${pyRepr(binding.binding_id)} has invalid adapter parameters: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (params === null || normalizationProfile === null) return;
    if (!normalizationProfile.allowed_units.includes(params.expression_unit)) {
      codes.push("unknown_unit");
      reasons.push(`binding ${pyRepr(binding.binding_id)} has unknown expression unit`);
    }
    if (!normalizationProfile.allowed_semantics.includes(params.value_semantics)) {
      codes.push("unknown_semantics");
      reasons.push(`binding ${pyRepr(binding.binding_id)} has unknown value semantics`);
    }
    if (!normalizationProfile.allowed_value_scales.includes(params.value_scale)) {
      codes.push("unknown_scale");
      reasons.push(`binding ${pyRepr(binding.binding_id)} has unknown value scale`);
    }
    return;
  }
  if (binding.parameters !== null && binding.parameters !== undefined && Object.keys(binding.parameters).length > 0) {
    codes.push("invalid_adapter_parameters");
    reasons.push(
      `binding ${pyRepr(binding.binding_id)} (adapter ${pyRepr(binding.adapter_id)}) ` +
        "declares adapter parameters that are not applicable",
    );
  }
}

/** Python ``!r`` of a string (single-quoted, escaped). */
function pyRepr(value: unknown): string {
  if (value === undefined || value === null) return "None";
  if (typeof value !== "string") return pyRepr(String(value));
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** Python ``repr`` of a sorted list of strings (``['a', 'b']``). */
function pyReprList(values: readonly string[]): string {
  return `[${values.map((value) => pyRepr(value)).join(", ")}]`;
}

/**
 * Checks a spec against the registry before any download starts.  The
 * validation-profile allowlist is **fail-closed**: an empty allowlist
 * rejects every ``validation_profile_ref``.
 */
export class SpecValidator {
  private readonly registry: {
    contains(schemaId: string): boolean;
    get(schemaId: string): { dataset_family: string; row_granularity: string; fields: Array<{ name: string }> };
    list(): string[];
  };
  private readonly allowedProfiles: ReadonlySet<string>;
  private readonly familyRegistry: DatasetFamilyRegistry | null;

  constructor(
    registry: SpecValidator["registry"],
    allowedValidationProfiles: readonly string[] = [],
    familyRegistry: DatasetFamilyRegistry | null = null,
  ) {
    this.registry = registry;
    this.allowedProfiles = new Set(allowedValidationProfiles);
    this.familyRegistry = familyRegistry;
  }

  validate(spec: DatasetBuildSpec): SpecValidationResult {
    const codes: string[] = [];
    const reasons: string[] = [];
    const familyDefinition = familyDefinitionFor(
      this.familyRegistry,
      spec.dataset_family,
    );
    const validationProfile = (() => {
      if (familyDefinition === null) return null;
      try {
        return getValidationProfile(spec.validation_profile_ref);
      } catch {
        codes.push("validation_profile_unavailable");
        reasons.push(
          `validation profile ${pyRepr(spec.validation_profile_ref)} is registered ` +
            "for the family but has no runtime implementation",
        );
        return null;
      }
    })();

    if (!this.registry.contains(spec.schema_ref)) {
      codes.push("unknown_schema");
      reasons.push(
        `schema ${pyRepr(spec.schema_ref)} is not registered; ` +
          `registered schemas: ${pyReprList(this.registry.list())}`,
      );
    } else {
      const schema = this.registry.get(spec.schema_ref);
      if (schema.dataset_family !== spec.dataset_family) {
        codes.push("family_mismatch");
        reasons.push("spec dataset_family does not match the target schema");
      }
      if (schema.row_granularity !== spec.row_granularity) {
        codes.push("granularity_schema_mismatch");
        reasons.push("spec row_granularity does not match the target schema");
      }
      const known = new Set(schema.fields.map((field) => field.name));
      const missing = (spec.required_fields ?? []).filter((name) => !known.has(name));
      if (missing.length > 0) {
        codes.push("unknown_required_field");
        reasons.push(`required fields not in schema: ${pyReprList([...missing].sort())}`);
      }
      // Phase 5 D2/D4: entity-level compatibility.  An explicit
      // ``target_entity_level`` must agree with both the selected schema's
      // granularity and the selected validation profile's
      // ``required_entity_level``; an unset target derives from the profile,
      // and the effective level must match the schema.
      const registeredGranularity = familyDefinition?.granularities.find(
        (item) => item.id === schema.row_granularity,
      );
      const granularityLevel = registeredGranularity?.target_entity_level ??
        ENTITY_LEVEL_BY_GRANULARITY[schema.row_granularity];
      const profileLevel = validationProfile?.required_entity_level ??
        (this.familyRegistry === null
          ? profileEntityLevel(spec.validation_profile_ref)
          : null);
      if (spec.target_entity_level !== null && spec.target_entity_level !== undefined) {
        if (granularityLevel !== spec.target_entity_level) {
          codes.push("entity_level_schema_mismatch");
          reasons.push(
            `target_entity_level ${pyRepr(spec.target_entity_level)} is not ` +
              `consistent with schema ${pyRepr(spec.schema_ref)} ` +
              `(row_granularity ${pyRepr(schema.row_granularity)})`,
          );
        }
        if (
          profileLevel !== null &&
          profileLevel !== "any" &&
          spec.target_entity_level !== profileLevel
        ) {
          codes.push("entity_level_profile_mismatch");
          reasons.push(
            `target_entity_level ${pyRepr(spec.target_entity_level)} is ` +
              `incompatible with validation profile ${pyRepr(spec.validation_profile_ref)} ` +
              `(requires ${pyRepr(profileLevel)})`,
          );
        }
      } else if (profileLevel !== null && profileLevel !== "any") {
        if (granularityLevel !== profileLevel) {
          codes.push("entity_level_schema_mismatch");
          reasons.push(
            `validation profile ${pyRepr(spec.validation_profile_ref)} ` +
              `requires entity level ${pyRepr(profileLevel)}, which is ` +
              `inconsistent with schema ${pyRepr(spec.schema_ref)} ` +
              `(row_granularity ${pyRepr(schema.row_granularity)})`,
          );
        }
      }
    }

    if (this.familyRegistry !== null) {
      if (familyDefinition === null) {
        codes.push("unknown_family");
        reasons.push(
          `dataset family ${pyRepr(spec.dataset_family)} is not registered; ` +
            `registered families: ${pyReprList(this.familyRegistry.list())}`,
        );
      } else {
        if (!familyDefinition.validation_profile_refs.includes(spec.validation_profile_ref)) {
          codes.push("profile_family_mismatch");
          reasons.push("validation profile does not belong to the selected dataset family");
        } else if (
          !familyDefinition.validation_profiles_by_schema[spec.schema_ref]?.includes(
            spec.validation_profile_ref,
          )
        ) {
          codes.push("profile_schema_mismatch");
          reasons.push("validation profile does not support the selected schema");
        }
        if (
          spec.normalization_profile_ref !== null &&
          spec.normalization_profile_ref !== undefined &&
          !familyDefinition.normalization_profile_refs.includes(spec.normalization_profile_ref)
        ) {
          codes.push("normalization_profile_family_mismatch");
          reasons.push("normalization profile does not belong to the selected dataset family");
        }
        if (!familyDefinition.merge_strategies.includes(spec.merge_strategy)) {
          codes.push("merge_strategy_not_supported");
          reasons.push(
            `merge strategy ${pyRepr(spec.merge_strategy)} is not supported by family ` +
              `${pyRepr(familyDefinition.id)}`,
          );
        }
        if (!familyDefinition.output_formats.includes(spec.output_format)) {
          codes.push("output_format_not_supported");
          reasons.push(
            `output format ${pyRepr(spec.output_format)} is not supported by family ` +
              `${pyRepr(familyDefinition.id)}`,
          );
        }
      }
    }

    if (!this.allowedProfiles.has(spec.validation_profile_ref)) {
      codes.push("profile_not_allowed");
      reasons.push(
        `validation profile ${pyRepr(spec.validation_profile_ref)} is not on ` +
          "the server allowlist; allowed validation profiles: " +
          `${pyReprList([...this.allowedProfiles].sort())}`,
      );
    }

    const normalizationProfile = (() => {
      if (familyDefinition === null) {
        return resolveNormalizationProfile(spec.normalization_profile_ref);
      }
      const profileRef = spec.normalization_profile_ref ??
        familyDefinition.default_normalization_profile_ref;
      try {
        return getNormalizationProfile(profileRef);
      } catch {
        codes.push("normalization_profile_unavailable");
        reasons.push(
          `normalization profile ${pyRepr(spec.normalization_profile_ref)} is registered ` +
            "for the family but has no runtime implementation",
        );
        return null;
      }
    })();
    for (const binding of spec.source_bindings ?? []) {
      const resolved = DATABASE_IDENTIFIER_ALIASES[binding.source.trim().toLowerCase()];
      const canonicalSource = resolved ?? binding.source;
      const sourceDefinition = familyDefinition?.sources.find(
        (source) => source.source === canonicalSource,
      );
      if (familyDefinition !== null) {
        if (sourceDefinition === undefined) {
          codes.push("source_family_mismatch");
          reasons.push(
            `binding ${pyRepr(binding.binding_id)} source ${pyRepr(binding.source)} ` +
              `is not registered for family ${pyRepr(familyDefinition.id)}`,
          );
        } else if (
          familyDefinition.runtime_id !== "registered_multitable.runtime.v1" &&
          !sourceDefinition.schema_refs.includes(spec.schema_ref)
        ) {
          codes.push("source_schema_mismatch");
          reasons.push(
            `binding ${pyRepr(binding.binding_id)} source ${pyRepr(binding.source)} ` +
              `does not support schema ${pyRepr(spec.schema_ref)}`,
          );
        } else if (sourceDefinition.adapter_id !== binding.adapter_id) {
          codes.push("adapter_source_mismatch");
          reasons.push(
            `binding ${pyRepr(binding.binding_id)} adapter ${pyRepr(binding.adapter_id)} ` +
              `does not match source ${pyRepr(binding.source)} ` +
              `(expected ${pyRepr(sourceDefinition.adapter_id)})`,
          );
        } else if (normalizationProfile !== null) {
          for (const issue of sourceDefinition.validateParameters(
            binding.parameters ?? {},
            normalizationProfile,
          )) {
            codes.push(issue.code);
            reasons.push(
              `binding ${pyRepr(binding.binding_id)} has invalid adapter parameters: ` +
                issue.message,
            );
          }
        }
      }
      // B4 Agent-only guarantee: a binding whose ``source`` resolves to a
      // RESEARCH_ONLY database must never be admitted as a verified build
      // source. Unknown identifiers remain fail-open only for legacy validators
      // constructed without a DatasetFamilyRegistry.
      if (
        resolved !== undefined &&
        SOURCE_CAPABILITIES[resolved] !== "pipeline_supported" &&
        providerCarrierBinding(familyDefinition?.id ?? "", canonicalSource, binding.adapter_id) === null
      ) {
        codes.push("source_not_pipeline_supported");
        reasons.push(
          `binding ${pyRepr(binding.binding_id)} source ${pyRepr(binding.source)} ` +
            `is ${SOURCE_CAPABILITIES[resolved]} \u2014 Agent-only ` +
            "research sources are never accepted as build sources",
        );
      }
      if (familyDefinition === null) {
        validateLegacyAdapterParameters(binding, normalizationProfile, codes, reasons);
      }
    }

    if (codes.length > 0) {
      return { valid: false, reason_codes: codes, reasons };
    }
    return specValid();
  }
}