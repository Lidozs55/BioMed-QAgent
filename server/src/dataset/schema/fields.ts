/**
 * Canonical schema field data for the built-in expression schemas, ported
 * from Python ``backend/app/pipeline/stages/artifact_build/columns.py``
 * (``_FIELD_DESCRIPTIONS``) and ``backend/app/datasets/schema_registry.py``.
 * Only the fields the two built-in expression schemas reference are ported;
 * descriptions and required flags are transcribed verbatim from Python.
 */

export interface FieldDescription {
  dataType: string;
  description: string;
  /** Required in the schema (Python ``nullable == "false"``). */
  required: boolean;
}

const _FOREIGN_KEY_FIELDS: ReadonlySet<string> = new Set([
  "dataset_id",
  "source_id",
  "asset_id",
  "sample_id",
]);

/** Fields of the 22-column gene-level expression long table, in order. */
export const EXPRESSION_FAMILY_FIELDS: readonly string[] = [
  "record_id",
  "dataset_id",
  "source_id",
  "asset_id",
  "gene_id_raw",
  "gene_id",
  "gene_id_namespace",
  "gene_id_version",
  "sample_id",
  "source_sample_alias",
  "measurement_type",
  "value_semantics",
  "value_scale",
  "is_normalized",
  "is_integer_expected",
  "expression_value",
  "expression_unit",
  "source_logical_file",
  "source_line_number",
  "source_column_index",
  "source_column_name",
  "source_raw_value",
];

export const EXPRESSION_PRIMARY_KEY: readonly string[] = [
  "dataset_id",
  "sample_id",
  "gene_id",
  "measurement_type",
];

/** Fields of the probe-level expression long table (Phase 5 D2), in order. */
export const PROBE_EXPRESSION_FIELDS: readonly string[] = [
  "record_id",
  "dataset_id",
  "source_id",
  "asset_id",
  "probe_id",
  "platform_id",
  "sample_id",
  "value",
  "gene_id_namespace",
  "value_semantics",
  "value_scale",
  "expression_unit",
  "is_normalized",
  "is_integer_expected",
  "source_sample_alias",
  "measurement_type",
  "source_logical_file",
  "source_line_number",
  "source_column_index",
  "source_column_name",
  "source_raw_value",
];

export const PROBE_PRIMARY_KEY: readonly string[] = [
  "probe_id",
  "platform_id",
  "sample_id",
];

export interface ProbeFieldMeta {
  dataType: string;
  description: string;
  semanticRole: string;
}

/** Metadata for probe fields absent from (or differing from) the V1 table. */
export const PROBE_FIELD_META: Readonly<Record<string, ProbeFieldMeta>> = {
  probe_id: {
    dataType: "string",
    description:
      "Probe identifier as it appears in the source file (e.g., GEO ID_REF)",
    semanticRole: "entity_identifier",
  },
  platform_id: {
    dataType: "string",
    description: "GEO platform accession (GPL...) the probe belongs to",
    semanticRole: "attribute",
  },
  value: {
    dataType: "float",
    description:
      "Numeric expression measurement value parsed from the source file " +
      "(probe-level)",
    semanticRole: "measurement",
  },
  gene_id_namespace: {
    dataType: "string",
    description:
      "Namespace of the row identifier: geo_probe for unmapped probes, " +
      "or the target gene namespace for successfully mapped rows",
    semanticRole: "entity_identifier",
  },
};

/**
 * Field descriptions for the expression family (Python
 * ``_FIELD_DESCRIPTIONS`` entries referenced by the two built-in schemas).
 */
export const FIELD_DESCRIPTIONS: Readonly<Record<string, FieldDescription>> = {
  record_id: {
    dataType: "string",
    description:
      "Stable unique row identifier derived from dataset_id, pathway_id and participant_id",
    required: true,
  },
  dataset_id: {
    dataType: "string",
    description:
      "Foreign key to dataset_catalog.csv identifying the dataset this row belongs to",
    required: true,
  },
  source_id: {
    dataType: "string",
    description:
      "Foreign key to source_list.csv identifying the originating database",
    required: true,
  },
  asset_id: {
    dataType: "string",
    description:
      "Foreign key to source_assets.csv identifying the downloaded source file",
    required: true,
  },
  gene_id_raw: {
    dataType: "string",
    description:
      "Raw gene identifier as it appears in the source file before normalization",
    required: true,
  },
  gene_id: {
    dataType: "string",
    description: "Canonical gene identifier after namespace normalization",
    required: true,
  },
  gene_id_namespace: {
    dataType: "string",
    description:
      "Namespace/authority for the gene identifier (e.g., ensembl_gene, hgnc_symbol)",
    required: true,
  },
  gene_id_version: {
    dataType: "string",
    description:
      "Version suffix of the gene identifier when available (e.g., ENSG00000139618.14)",
    required: false,
  },
  sample_id: {
    dataType: "string",
    description:
      "Foreign key to sample_metadata.csv identifying the sample (GEO GSM accession)",
    required: true,
  },
  source_sample_alias: {
    dataType: "string",
    description: "Original sample alias used in the source file's column header",
    required: true,
  },
  measurement_type: {
    dataType: "string",
    description:
      "Type of measurement (e.g., tximport_estimated_count, sample_metadata)",
    required: true,
  },
  value_semantics: {
    dataType: "string",
    description:
      "Semantic interpretation of the value (e.g., estimated_count, metadata_only)",
    required: true,
  },
  value_scale: {
    dataType: "string",
    description:
      "Scale of the value (e.g., linear, log2, na for not-applicable)",
    required: true,
  },
  is_normalized: {
    dataType: "string",
    description: "Whether the value has been normalized (true/false)",
    required: true,
  },
  is_integer_expected: {
    dataType: "string",
    description: "Whether the value is expected to be an integer (true/false)",
    required: true,
  },
  expression_value: {
    dataType: "float",
    description:
      "Numeric expression measurement value parsed from the source file",
    required: true,
  },
  expression_unit: {
    dataType: "string",
    description:
      "Unit of the expression value (e.g., estimated_count, tpm, fpkm)",
    required: true,
  },
  source_logical_file: {
    dataType: "string",
    description:
      "Logical name of the source file within the asset (e.g., GSE178352_tximportCounts.txt)",
    required: true,
  },
  source_line_number: {
    dataType: "integer",
    description: "1-based line number in the source file where this value appears",
    required: true,
  },
  source_column_index: {
    dataType: "integer",
    description: "0-based column index in the source file where this value appears",
    required: true,
  },
  source_column_name: {
    dataType: "string",
    description: "Column header name in the source file",
    required: true,
  },
  source_raw_value: {
    dataType: "string",
    description:
      "Original string value as it appears in the source file before parsing",
    required: true,
  },
};

/** Map a V1 column to a Schema semantic role (Python ``_infer_semantic_role``). */
export function inferSemanticRole(name: string): string {
  if (name === "record_id") return "row_identifier";
  if (_FOREIGN_KEY_FIELDS.has(name)) return "foreign_key";
  if (name.startsWith("gene_id")) return "entity_identifier";
  if (name === "expression_value") return "measurement";
  if (name === "expression_unit") return "unit";
  if (name.startsWith("source_")) return "provenance";
  return "attribute";
}

/** Map a V1 column to an ontology hint (Python ``_infer_ontology``). */
export function inferOntology(name: string): string | null {
  if (name === "gene_id") return "Ensembl/HGNC";
  return null;
}