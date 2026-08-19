/**
 * Versioned normalization profiles (Python ``profiles.py`` — normalization
 * registry only; the validation profile belongs to the Phase 4 validation
 * step).  Entity/unit normalization policy consumed by the Canonicalizer:
 * namespaces, allowed units/semantics/scales, conversions.
 */

import type { NormalizationProfile } from "../contracts/index.js";
import { parseNormalizationProfile } from "../contracts/index.js";

const EXPRESSION_NORMALIZATION_V1_ID = "gene_expression.normalization.v1";

export function expressionNormalizationV1(): NormalizationProfile {
  return parseNormalizationProfile({
    profile_id: EXPRESSION_NORMALIZATION_V1_ID,
    dataset_family: "gene_expression",
    allowed_namespaces: ["ensembl_gene", "gene_symbol", "geo_probe"],
    allowed_units: [
      "expression_value",
      "tpm_unstranded",
      "unstranded",
      "tpm",
      "fpkm",
      "log2_expression",
      "estimated_count",
    ],
    allowed_semantics: ["expression_value", "normalized_expression", "raw_count"],
    // Phase 5 D3/T4: every scale the expression chain may honestly declare.
    // ``unknown`` is explicit: a scale that cannot be proven is declared,
    // never guessed.
    allowed_value_scales: ["linear", "log2", "log10", "unknown"],
    unit_conversions: [], // no conversion is silently allowed without a rule
    aggregation_policy: "keep_all",
    description:
      "Expression entity/unit normalization: authorize ensembl_gene, gene_symbol and geo_probe namespaces, accept the declared unit/semantics/scale sets, and require an explicit conversion rule before any unit change.  geo_probe is an honest adapter-declared namespace for probe rows; the entity-level publish policy (residual geo_probe rows fail the gene release gate) lives in the validation profile (Phase 5 T7).",
  });
}

function registeredTableNormalization(familyId: string): NormalizationProfile {
  return parseNormalizationProfile({
    profile_id: `${familyId}.registered.v1`,
    dataset_family: familyId,
    allowed_namespaces: ["source_declared"],
    allowed_units: ["source_declared", "not_applicable"],
    allowed_semantics: ["schema_preserving_registered_table"],
    allowed_value_scales: ["unknown"],
    unit_conversions: [],
    aggregation_policy: "keep_all",
    description: "Schema-preserving registered-table ingestion; no expression canonicalization or silent unit conversion.",
  });
}

export const NORMALIZATION_PROFILES: Readonly<Record<string, NormalizationProfile>> = {
  [EXPRESSION_NORMALIZATION_V1_ID]: expressionNormalizationV1(),
  "literature_evidence.registered.v1": registeredTableNormalization("literature_evidence"),
  "target_evidence.registered.v1": registeredTableNormalization("target_evidence"),
  "variant_evidence.registered.v1": registeredTableNormalization("variant_evidence"),
  "protein_structure.registered.v1": registeredTableNormalization("protein_structure"),
  "bioactivity_measurement.registered.v1": registeredTableNormalization("bioactivity_measurement"),
};

/** Resolve ``profileRef``; the default expression profile when omitted. */
export function getNormalizationProfile(
  profileRef?: string | null,
): NormalizationProfile {
  if (profileRef === undefined || profileRef === null || profileRef === "") {
    return NORMALIZATION_PROFILES[EXPRESSION_NORMALIZATION_V1_ID];
  }
  const profile = NORMALIZATION_PROFILES[profileRef];
  if (profile === undefined) {
    throw new Error(`normalization profile '${profileRef}' is not registered`);
  }
  return profile;
}