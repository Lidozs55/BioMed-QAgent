import type {
  DatasetSchemaV2,
  RelationDefinition,
  SchemaFieldV2,
  TableDefinition,
} from "@biomed/contracts";

import type { RegisteredTableAdapterRegistration } from "../../adapters/registered/index.js";
import {
  parseDatasetSchemaV2,
  parseTableDefinition,
} from "../../contracts/index.js";
import {
  buildBiomedicalRelation,
  buildPaperTable,
  buildSourceTable,
} from "../../schema/common/index.js";

export const LITERATURE_EVIDENCE_FAMILY_ID = "literature_evidence";
export const LITERATURE_EVIDENCE_ROW_GRANULARITY =
  "one experiment-level evidence assertion reported by one scholarly paper";

export const LITERATURE_EVIDENCE_TABLE_ID = "literature_evidence";
export const LITERATURE_PAPERS_TABLE_ID = "papers";
export const LITERATURE_SOURCES_TABLE_ID = "sources";

function field(
  name: string,
  options: {
    dataType?: string;
    semanticRole: string;
    required?: boolean;
    nullable?: boolean;
    ontology?: string | null;
    description: string;
  },
): SchemaFieldV2 {
  return {
    schema_version: "2.0",
    name,
    data_type: options.dataType ?? "string",
    semantic_role: options.semanticRole,
    required: options.required ?? true,
    nullable: options.nullable ?? false,
    unit_policy: null,
    ontology: options.ontology ?? null,
    description: options.description,
    derivation_policy: null,
  };
}

export const literatureEvidenceSchema: DatasetSchemaV2 = parseDatasetSchemaV2({
  schema_version: "2.0",
  schema_id: "literature_evidence.experiment_evidence.v1",
  dataset_family: LITERATURE_EVIDENCE_FAMILY_ID,
  row_granularity: LITERATURE_EVIDENCE_ROW_GRANULARITY,
  primary_key: ["evidence_id"],
  fields: [
    field("evidence_id", {
      semanticRole: "row_identifier",
      description: "Stable identifier for one experiment-level evidence assertion.",
    }),
    field("paper_id", {
      semanticRole: "foreign_key",
      description: "Identifier of the paper reporting the evidence.",
    }),
    field("paper_id_namespace", {
      semanticRole: "identifier_namespace",
      ontology: "biomed:id_namespace.v1",
      description: "Controlled namespace for paper_id.",
    }),
    field("experiment_id", {
      semanticRole: "experiment_identifier",
      description: "Stable experiment, cohort, table, or result identifier within the paper.",
    }),
    field("evidence_type", {
      semanticRole: "evidence_type",
      description: "Type of evidence, such as intervention_result or observational_association.",
    }),
    field("claim_text", {
      semanticRole: "evidence_claim",
      description: "Bounded claim supported by the located experiment result.",
    }),
    field("result_summary", {
      semanticRole: "evidence_result",
      description: "Structured-data-friendly summary of the reported result.",
    }),
    field("study_context", {
      dataType: "json",
      semanticRole: "experiment_context",
      required: false,
      nullable: true,
      description: "Optional structured population, intervention, comparator, and endpoint context.",
    }),
    field("source_id", {
      semanticRole: "foreign_key",
      description: "Identifier of the source carrier and precise SourceLocator for this evidence.",
    }),
  ],
});

export const literatureEvidenceDefinition: TableDefinition = parseTableDefinition({
  table_id: LITERATURE_EVIDENCE_TABLE_ID,
  schema_ref: literatureEvidenceSchema.schema_id,
  role: "primary",
  required: true,
  allow_empty: false,
  primary_key: [...literatureEvidenceSchema.primary_key],
  field_names: literatureEvidenceSchema.fields.map((item) => item.name),
});

const paperTable = buildPaperTable({
  datasetFamily: LITERATURE_EVIDENCE_FAMILY_ID,
  tableId: LITERATURE_PAPERS_TABLE_ID,
  role: "supporting",
});
const sourceTable = buildSourceTable({
  datasetFamily: LITERATURE_EVIDENCE_FAMILY_ID,
  tableId: LITERATURE_SOURCES_TABLE_ID,
  role: "supporting",
});

export const literaturePaperSchema = paperTable.schema;
export const literaturePaperDefinition = paperTable.definition;
export const literatureSourceSchema = sourceTable.schema;
export const literatureSourceDefinition = sourceTable.definition;

export const literatureEvidenceTables = [
  { schema: literatureEvidenceSchema, definition: literatureEvidenceDefinition },
  { schema: literaturePaperSchema, definition: literaturePaperDefinition },
  { schema: literatureSourceSchema, definition: literatureSourceDefinition },
] as const;

export const literatureEvidenceRelations: readonly RelationDefinition[] = [
  buildBiomedicalRelation({
    relationType: "paper_describes_assay",
    relationId: "evidence_paper",
    fromTableId: LITERATURE_EVIDENCE_TABLE_ID,
    fromFields: ["paper_id", "paper_id_namespace"],
    toTableId: LITERATURE_PAPERS_TABLE_ID,
    toFields: ["paper_id", "paper_id_namespace"],
    cardinality: "many_to_one",
  }),
  buildBiomedicalRelation({
    relationType: "paper_describes_assay",
    relationId: "evidence_source",
    fromTableId: LITERATURE_EVIDENCE_TABLE_ID,
    fromFields: ["source_id"],
    toTableId: LITERATURE_SOURCES_TABLE_ID,
    toFields: ["source_id"],
    cardinality: "many_to_one",
  }),
  buildBiomedicalRelation({
    relationType: "paper_describes_assay",
    relationId: "paper_source",
    fromTableId: LITERATURE_PAPERS_TABLE_ID,
    fromFields: ["source_id"],
    toTableId: LITERATURE_SOURCES_TABLE_ID,
    toFields: ["source_id"],
    cardinality: "many_to_one",
  }),
];

const limits = {
  max_bytes: 8 * 1024 * 1024,
  max_rows: 50_000,
  max_columns: 32,
  max_line_characters: 1024 * 1024,
};

export const literatureEvidenceAdapterRegistrations: readonly RegisteredTableAdapterRegistration[] = [
  {
    schema: literatureEvidenceSchema,
    parser: {
      adapter_id: "literature_evidence.structured_json",
      parser_version: "1.0.0",
      schema_ref: literatureEvidenceSchema.schema_id,
      format: "json",
      rows_pointer: "/evidence",
      fields: literatureEvidenceSchema.fields.map((item) => ({
        source_pointer: `/${item.name}`,
        target_field: item.name,
      })),
      media_types: ["application/json"],
      limits,
    },
  },
  {
    schema: literaturePaperSchema,
    parser: {
      adapter_id: "literature_evidence.papers_json",
      parser_version: "1.0.0",
      schema_ref: literaturePaperSchema.schema_id,
      format: "json",
      rows_pointer: "/papers",
      fields: literaturePaperSchema.fields.map((item) => ({
        source_pointer: `/${item.name}`,
        target_field: item.name,
      })),
      media_types: ["application/json"],
      limits,
    },
  },
  {
    schema: literatureSourceSchema,
    parser: {
      adapter_id: "literature_evidence.sources_json",
      parser_version: "1.0.0",
      schema_ref: literatureSourceSchema.schema_id,
      format: "json",
      rows_pointer: "/sources",
      fields: literatureSourceSchema.fields.map((item) => ({
        source_pointer: `/${item.name}`,
        target_field: item.name,
      })),
      media_types: ["application/json"],
      limits,
    },
  },
];
