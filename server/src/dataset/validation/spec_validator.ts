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
import { getValidationProfile } from "./profile.js";

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

  constructor(
    registry: SpecValidator["registry"],
    allowedValidationProfiles: readonly string[] = [],
  ) {
    this.registry = registry;
    this.allowedProfiles = new Set(allowedValidationProfiles);
  }

  validate(spec: DatasetBuildSpec): SpecValidationResult {
    const codes: string[] = [];
    const reasons: string[] = [];

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
      const granularityLevel = ENTITY_LEVEL_BY_GRANULARITY[schema.row_granularity];
      const profileLevel = profileEntityLevel(spec.validation_profile_ref);
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

    if (!this.allowedProfiles.has(spec.validation_profile_ref)) {
      codes.push("profile_not_allowed");
      reasons.push(
        `validation profile ${pyRepr(spec.validation_profile_ref)} is not on ` +
          "the server allowlist; allowed validation profiles: " +
          `${pyReprList([...this.allowedProfiles].sort())}`,
      );
    }

    // Phase 5 D1: per-binding AdapterParams.  geo.expression.v1 bindings must
    // declare valid typed parameters (format is mandatory); any other adapter
    // declaring parameters is invalid input.
    const normalizationProfile = resolveNormalizationProfile(
      spec.normalization_profile_ref,
    );
    for (const binding of spec.source_bindings ?? []) {
      // B4 Agent-only guarantee: a binding whose ``source`` resolves to a
      // RESEARCH_ONLY database must never be admitted as a verified build
      // source.  Unknown identifiers are left to the runtime adapter
      // resolution so the pre-check stays fail-open for identifiers this
      // table cannot know.
      const resolved = DATABASE_IDENTIFIER_ALIASES[binding.source.trim().toLowerCase()];
      if (resolved !== undefined && SOURCE_CAPABILITIES[resolved] !== "pipeline_supported") {
        codes.push("source_not_pipeline_supported");
        reasons.push(
          `binding ${pyRepr(binding.binding_id)} source ${pyRepr(binding.source)} ` +
            `is ${SOURCE_CAPABILITIES[resolved]} \u2014 Agent-only ` +
            "research sources are never accepted as build sources",
        );
      }
      if (binding.adapter_id === GEO_EXPRESSION_ADAPTER_ID) {
        const parameters = binding.parameters;
        if (parameters === null || parameters === undefined || Object.keys(parameters).length === 0) {
          codes.push("invalid_adapter_parameters");
          reasons.push(
            `binding ${pyRepr(binding.binding_id)} (geo.expression.v1) ` +
              "requires adapter parameters " +
              "(format/value_semantics/value_scale/expression_unit)",
          );
        } else {
          let params: ReturnType<typeof parseAdapterParams> | null = null;
          try {
            params = parseAdapterParams(parameters);
          } catch (error) {
            codes.push("invalid_adapter_parameters");
            reasons.push(
              `binding ${pyRepr(binding.binding_id)} has invalid ` +
                `adapter parameters: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          if (params !== null && normalizationProfile !== null) {
            if (!normalizationProfile.allowed_units.includes(params.expression_unit)) {
              codes.push("unknown_unit");
              reasons.push(
                `binding ${pyRepr(binding.binding_id)} ` +
                  `expression_unit ${pyRepr(params.expression_unit)} ` +
                  "is not in the normalization profile's " +
                  `allowed units: ${pyReprList([...normalizationProfile.allowed_units].sort())}`,
              );
            }
            if (!normalizationProfile.allowed_semantics.includes(params.value_semantics)) {
              codes.push("unknown_semantics");
              reasons.push(
                `binding ${pyRepr(binding.binding_id)} ` +
                  `value_semantics ${pyRepr(params.value_semantics)} ` +
                  "is not in the normalization profile's " +
                  `allowed semantics: ${pyReprList([...normalizationProfile.allowed_semantics].sort())}`,
              );
            }
            if (!normalizationProfile.allowed_value_scales.includes(params.value_scale)) {
              codes.push("unknown_scale");
              reasons.push(
                `binding ${pyRepr(binding.binding_id)} ` +
                  `value_scale ${pyRepr(params.value_scale)} ` +
                  "is not in the normalization profile's " +
                  `allowed scales: ${[...normalizationProfile.allowed_value_scales].sort().join(", ")}`,
              );
            }
          }
        }
      } else if (binding.parameters !== null && binding.parameters !== undefined && Object.keys(binding.parameters).length > 0) {
        codes.push("invalid_adapter_parameters");
        reasons.push(
          `binding ${pyRepr(binding.binding_id)} (adapter ` +
            `${pyRepr(binding.adapter_id)}) declares adapter parameters ` +
            "that are not applicable",
        );
      }
    }

    if (codes.length > 0) {
      return { valid: false, reason_codes: codes, reasons };
    }
    return specValid();
  }
}