export * from "./types.js";
export * from "./registry.js";
export * from "./adapter.js";
export * from "./default-registry.js";

const REGISTERED_ADAPTER_PREFIXES = [
  "literature_evidence.",
  "registered_target_evidence_",
  "registered_variant_",
  "registered_protein_structure",
  "registered_bioactivity_",
  "registered_gut_microbiome_",
  "registered_inherited_disease_",
] as const;

export function isRegisteredTableAdapterId(adapterId: string): boolean {
  return REGISTERED_ADAPTER_PREFIXES.some((prefix) => adapterId.startsWith(prefix));
}
