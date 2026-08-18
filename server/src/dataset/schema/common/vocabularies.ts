export const ID_NAMESPACES = [
  "bao",
  "chembl_assay",
  "chembl_compound",
  "chembl_document",
  "chembl_target",
  "clinicaltrials_gov",
  "clinvar_variant",
  "dbsnp",
  "doi",
  "ensembl_gene",
  "ensembl_protein",
  "ensembl_transcript",
  "hgnc",
  "hgnc_symbol",
  "inchi_key",
  "ncbi_gene",
  "pdb",
  "pmc",
  "pubchem_cid",
  "pubmed",
  "refseq",
  "uniprot",
] as const;

export type IdNamespace = typeof ID_NAMESPACES[number];

export const RELATION_CARDINALITIES = [
  "one_to_one",
  "one_to_many",
  "many_to_one",
  "many_to_many",
] as const;

export type BiomedicalRelationCardinality = typeof RELATION_CARDINALITIES[number];

export const RELATION_TYPES = [
  "assay_measures_target",
  "compound_has_activity",
  "compound_identity_link",
  "entity_identity_link",
  "paper_describes_assay",
  "paper_reports_structure",
  "structure_represents_entity",
  "trial_investigates_compound",
  "trial_investigates_entity",
] as const;

export type BiomedicalRelationType = typeof RELATION_TYPES[number];

export const MEASUREMENT_RELATIONS = [
  "=",
  "<",
  ">",
  "<=",
  ">=",
  "~",
] as const;

export type MeasurementRelation = typeof MEASUREMENT_RELATIONS[number];

export const UNIT_VOCABULARY = [
  "1/s",
  "angstrom",
  "C",
  "g/mol",
  "h",
  "K",
  "M",
  "mg/L",
  "min",
  "mM",
  "nM",
  "pM",
  "s",
  "uM",
  "um",
] as const;

export type BiomedicalUnit = typeof UNIT_VOCABULARY[number];

export const CROSSWALK_MATCH_METHODS = [
  "authority_assertion",
  "exact_identifier",
  "exact_inchi_key",
  "exact_name",
  "manual_review",
] as const;

export type CrosswalkMatchMethod = typeof CROSSWALK_MATCH_METHODS[number];

export const CROSSWALK_CONFLICT_STATUSES = [
  "matched",
  "conflict",
  "unresolved",
] as const;

export type CrosswalkConflictStatus = typeof CROSSWALK_CONFLICT_STATUSES[number];

export const CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;

export type ConfidenceLevel = typeof CONFIDENCE_LEVELS[number];

function member<T extends string>(
  value: string,
  vocabulary: readonly T[],
  label: string,
): T {
  if (!vocabulary.includes(value as T)) {
    throw new TypeError(`${label} '${value}' is not in the controlled vocabulary`);
  }
  return value as T;
}

export function parseIdNamespace(value: string): IdNamespace {
  return member(value, ID_NAMESPACES, "ID namespace");
}

export function parseRelationType(value: string): BiomedicalRelationType {
  return member(value, RELATION_TYPES, "relation type");
}

export function parseMeasurementRelation(value: string): MeasurementRelation {
  return member(value, MEASUREMENT_RELATIONS, "measurement relation");
}

export function parseBiomedicalUnit(value: string): BiomedicalUnit {
  return member(value, UNIT_VOCABULARY, "unit");
}

export function parseCrosswalkMatchMethod(value: string): CrosswalkMatchMethod {
  return member(value, CROSSWALK_MATCH_METHODS, "crosswalk match method");
}

export function parseCrosswalkConflictStatus(value: string): CrosswalkConflictStatus {
  return member(value, CROSSWALK_CONFLICT_STATUSES, "crosswalk conflict status");
}

export function parseConfidenceLevel(value: string): ConfidenceLevel {
  return member(value, CONFIDENCE_LEVELS, "confidence level");
}
