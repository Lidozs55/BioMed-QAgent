import type {
  DatasetSchemaV2,
  RelationCardinality,
  RelationDefinition,
  RelationMissingPolicy,
  SchemaFieldV2,
  TableDefinition,
  TableRole,
} from "@biomed/contracts";

import {
  parseDatasetSchemaV2,
  parseRelationDefinition,
  parseTableDefinition,
} from "../../contracts/index.js";
import type { BiomedicalRelationType } from "./vocabularies.js";
import {
  parseRelationType,
  RELATION_CARDINALITIES,
} from "./vocabularies.js";

export const COMMON_SCHEMA_KINDS = [
  "entity",
  "paper",
  "compound",
  "assay",
  "structure_dimension",
  "trial",
  "source",
  "entity_crosswalk",
  "compound_crosswalk",
] as const;

export type CommonSchemaKind = typeof COMMON_SCHEMA_KINDS[number];

export interface CommonSchemaOptions {
  datasetFamily: string;
  schemaId?: string;
  rowGranularity?: string;
}

export interface CommonTableOptions extends CommonSchemaOptions {
  tableId: string;
  role: TableRole;
  required?: boolean;
  allowEmpty?: boolean;
  fieldNames?: readonly string[];
}

export interface CommonTableBuilderResult {
  schema: DatasetSchemaV2;
  definition: TableDefinition;
}

export interface BiomedicalRelationOptions {
  relationType: BiomedicalRelationType;
  relationId?: string;
  fromTableId: string;
  fromFields: readonly string[];
  toTableId: string;
  toFields: readonly string[];
  cardinality: RelationCardinality;
  missingPolicy?: RelationMissingPolicy;
}

interface FieldOptions {
  dataType?: string;
  semanticRole?: string;
  required?: boolean;
  nullable?: boolean;
  unitPolicy?: string | null;
  ontology?: string | null;
  description: string;
  derivationPolicy?: string | null;
}

interface CommonSchemaTemplate {
  rowGranularity: string;
  primaryKey: readonly string[];
  fields: readonly SchemaFieldV2[];
}

const NAMESPACE_ONTOLOGY = "biomed:id_namespace.v1";
const RELATION_ONTOLOGY = "biomed:relation_type.v1";
const MATCH_METHOD_ONTOLOGY = "biomed:crosswalk_match_method.v1";
const CONFLICT_STATUS_ONTOLOGY = "biomed:crosswalk_conflict_status.v1";
const CONFIDENCE_ONTOLOGY = "biomed:confidence_level.v1";

function field(name: string, options: FieldOptions): SchemaFieldV2 {
  return {
    schema_version: "2.0",
    name,
    data_type: options.dataType ?? "string",
    semantic_role: options.semanticRole ?? "attribute",
    required: options.required ?? true,
    nullable: options.nullable ?? false,
    unit_policy: options.unitPolicy ?? null,
    ontology: options.ontology ?? null,
    description: options.description,
    derivation_policy: options.derivationPolicy ?? null,
  };
}

function optionalField(name: string, options: FieldOptions): SchemaFieldV2 {
  return field(name, { ...options, required: false, nullable: true });
}

const SOURCE_ID = field("source_id", {
  semanticRole: "foreign_key",
  description: "Identifier of the source record carrying this assertion.",
});

const ENTITY_TEMPLATE: CommonSchemaTemplate = {
  rowGranularity: "one biomedical entity identity",
  primaryKey: ["entity_id", "entity_namespace"],
  fields: [
    field("entity_id", {
      semanticRole: "entity_identifier",
      description: "Identifier assigned by the declared entity namespace.",
    }),
    field("entity_namespace", {
      semanticRole: "identifier_namespace",
      ontology: NAMESPACE_ONTOLOGY,
      description: "Controlled namespace that determines the authority and syntax of entity_id.",
    }),
    field("entity_type", {
      semanticRole: "entity_type",
      description: "Biomedical entity class such as gene, protein, variant, disease, or target.",
    }),
    field("preferred_name", {
      semanticRole: "entity_label",
      description: "Preferred display name supplied by the declared authority.",
    }),
    optionalField("organism", {
      semanticRole: "organism",
      ontology: "NCBI Taxonomy",
      description: "Organism name or taxonomy identifier when the entity is organism-specific.",
    }),
    SOURCE_ID,
  ],
};

const PAPER_TEMPLATE: CommonSchemaTemplate = {
  rowGranularity: "one scholarly paper identity",
  primaryKey: ["paper_id", "paper_id_namespace"],
  fields: [
    field("paper_id", {
      semanticRole: "entity_identifier",
      description: "Publication identifier assigned by the declared paper namespace.",
    }),
    field("paper_id_namespace", {
      semanticRole: "identifier_namespace",
      ontology: NAMESPACE_ONTOLOGY,
      description: "Controlled publication namespace such as pubmed, pmc, or doi.",
    }),
    field("title", {
      semanticRole: "entity_label",
      description: "Paper title as reported by the source.",
    }),
    optionalField("journal", {
      description: "Journal or proceedings title.",
    }),
    optionalField("publication_date", {
      dataType: "date",
      description: "Publication date in ISO 8601 date form when available.",
    }),
    optionalField("authors", {
      dataType: "json",
      description: "Ordered JSON array of author names or identifiers.",
    }),
    optionalField("source_url", {
      semanticRole: "source_locator",
      description: "Canonical landing-page URL for the paper.",
    }),
    SOURCE_ID,
  ],
};

const COMPOUND_TEMPLATE: CommonSchemaTemplate = {
  rowGranularity: "one compound identity",
  primaryKey: ["compound_id", "compound_id_namespace"],
  fields: [
    field("compound_id", {
      semanticRole: "entity_identifier",
      description: "Compound identifier assigned by the declared namespace.",
    }),
    field("compound_id_namespace", {
      semanticRole: "identifier_namespace",
      ontology: NAMESPACE_ONTOLOGY,
      description: "Controlled compound namespace such as chembl_compound or pubchem_cid.",
    }),
    field("preferred_name", {
      semanticRole: "entity_label",
      description: "Preferred compound name supplied by the source authority.",
    }),
    optionalField("canonical_smiles", {
      semanticRole: "chemical_structure",
      description: "Canonical SMILES string from the source authority.",
    }),
    optionalField("isomeric_smiles", {
      semanticRole: "chemical_structure",
      description: "Isomeric SMILES string from the source authority.",
    }),
    optionalField("inchi", {
      semanticRole: "chemical_structure",
      description: "IUPAC International Chemical Identifier.",
    }),
    optionalField("inchi_key", {
      semanticRole: "entity_identifier",
      ontology: "InChIKey",
      description: "Hashed InChI key used as chemical identity evidence.",
    }),
    optionalField("molecular_formula", {
      description: "Molecular formula reported by the source.",
    }),
    optionalField("molecular_weight", {
      dataType: "float",
      semanticRole: "measurement",
      unitPolicy: "g/mol",
      description: "Molecular weight in grams per mole when reported.",
    }),
    SOURCE_ID,
  ],
};

const ASSAY_TEMPLATE: CommonSchemaTemplate = {
  rowGranularity: "one assay definition",
  primaryKey: ["assay_id", "assay_id_namespace"],
  fields: [
    field("assay_id", {
      semanticRole: "entity_identifier",
      description: "Assay identifier assigned by the declared namespace.",
    }),
    field("assay_id_namespace", {
      semanticRole: "identifier_namespace",
      ontology: NAMESPACE_ONTOLOGY,
      description: "Controlled assay namespace such as chembl_assay.",
    }),
    field("assay_type", {
      semanticRole: "assay_type",
      description: "Source assay category or measurement type.",
    }),
    optionalField("description", {
      description: "Source description of the assay protocol or endpoint.",
    }),
    optionalField("organism", {
      semanticRole: "organism",
      ontology: "NCBI Taxonomy",
      description: "Assay organism when declared.",
    }),
    optionalField("cell_line", {
      description: "Cell line or experimental system when declared.",
    }),
    optionalField("target_entity_id", {
      semanticRole: "foreign_key",
      description: "Identifier of the entity measured by the assay.",
    }),
    optionalField("target_entity_namespace", {
      semanticRole: "identifier_namespace",
      ontology: NAMESPACE_ONTOLOGY,
      description: "Controlled namespace for target_entity_id.",
    }),
    optionalField("bao_format_id", {
      semanticRole: "ontology_identifier",
      ontology: "BAO",
      description: "BioAssay Ontology format identifier.",
    }),
    SOURCE_ID,
  ],
};

const STRUCTURE_TEMPLATE: CommonSchemaTemplate = {
  rowGranularity: "one macromolecular structure dimension",
  primaryKey: ["structure_id", "structure_id_namespace", "chain_id"],
  fields: [
    field("structure_id", {
      semanticRole: "entity_identifier",
      description: "Structure identifier assigned by the declared namespace.",
    }),
    field("structure_id_namespace", {
      semanticRole: "identifier_namespace",
      ontology: NAMESPACE_ONTOLOGY,
      description: "Controlled structure namespace, normally pdb.",
    }),
    field("chain_id", {
      semanticRole: "dimension_identifier",
      description: "Polymer chain identifier; use an explicit source token for structure-level rows.",
    }),
    optionalField("title", {
      semanticRole: "entity_label",
      description: "Structure title reported by the source.",
    }),
    optionalField("experimental_method", {
      description: "Experimental or computational method reported by the source.",
    }),
    optionalField("resolution_angstrom", {
      dataType: "float",
      semanticRole: "measurement",
      unitPolicy: "angstrom",
      description: "Reported structure resolution in angstroms.",
    }),
    optionalField("entity_id", {
      semanticRole: "foreign_key",
      description: "Linked biomedical entity identifier.",
    }),
    optionalField("entity_namespace", {
      semanticRole: "identifier_namespace",
      ontology: NAMESPACE_ONTOLOGY,
      description: "Controlled namespace for entity_id.",
    }),
    optionalField("ligand_compound_id", {
      semanticRole: "foreign_key",
      description: "Linked ligand compound identifier.",
    }),
    optionalField("ligand_compound_namespace", {
      semanticRole: "identifier_namespace",
      ontology: NAMESPACE_ONTOLOGY,
      description: "Controlled namespace for ligand_compound_id.",
    }),
    SOURCE_ID,
  ],
};

const TRIAL_TEMPLATE: CommonSchemaTemplate = {
  rowGranularity: "one clinical trial identity",
  primaryKey: ["trial_id", "trial_id_namespace"],
  fields: [
    field("trial_id", {
      semanticRole: "entity_identifier",
      description: "Clinical trial identifier assigned by the declared namespace.",
    }),
    field("trial_id_namespace", {
      semanticRole: "identifier_namespace",
      ontology: NAMESPACE_ONTOLOGY,
      description: "Controlled clinical trial registry namespace.",
    }),
    field("official_title", {
      semanticRole: "entity_label",
      description: "Official trial title reported by the registry.",
    }),
    optionalField("phase", {
      description: "Trial phase as reported by the registry.",
    }),
    optionalField("recruitment_status", {
      description: "Current recruitment status reported by the registry.",
    }),
    optionalField("conditions", {
      dataType: "json",
      description: "JSON array of conditions studied by the trial.",
    }),
    optionalField("interventions", {
      dataType: "json",
      description: "JSON array of trial interventions.",
    }),
    optionalField("source_url", {
      semanticRole: "source_locator",
      description: "Canonical registry URL for the trial.",
    }),
    SOURCE_ID,
  ],
};

const SOURCE_TEMPLATE: CommonSchemaTemplate = {
  rowGranularity: "one source carrier record",
  primaryKey: ["source_id"],
  fields: [
    field("source_id", {
      semanticRole: "row_identifier",
      description: "Stable identifier for this source carrier record.",
    }),
    field("source_database", {
      semanticRole: "source_authority",
      description: "Database, repository, journal, or provider that supplied the source.",
    }),
    field("source_asset_id", {
      semanticRole: "source_asset_reference",
      description: "Core-registered immutable SourceAsset identifier.",
    }),
    field("source_locator", {
      dataType: "json",
      semanticRole: "source_locator",
      description: "Serialized SourceLocator 2.0 locating the supporting record or cell.",
    }),
    field("retrieved_at", {
      dataType: "datetime",
      semanticRole: "provenance",
      description: "ISO 8601 retrieval timestamp.",
    }),
    field("carrier_type", {
      semanticRole: "source_carrier_type",
      description: "Carrier form such as api_record, paper_table, supplementary_file, or figure.",
    }),
  ],
};

function crosswalkFields(compound: boolean): SchemaFieldV2[] {
  const identityPrefix = compound ? "compound" : "entity";
  return [
    field("crosswalk_id", {
      semanticRole: "row_identifier",
      description: "Stable identifier for this identity-link assertion.",
    }),
    field("left_id", {
      semanticRole: `${identityPrefix}_identifier`,
      description: "Identifier on the left side of the asserted link.",
    }),
    field("left_namespace", {
      semanticRole: "identifier_namespace",
      ontology: NAMESPACE_ONTOLOGY,
      description: "Controlled namespace for left_id.",
    }),
    field("right_id", {
      semanticRole: `${identityPrefix}_identifier`,
      description: "Identifier on the right side of the asserted link.",
    }),
    field("right_namespace", {
      semanticRole: "identifier_namespace",
      ontology: NAMESPACE_ONTOLOGY,
      description: "Controlled namespace for right_id.",
    }),
    field("relation_type", {
      semanticRole: "crosswalk_link_type",
      ontology: RELATION_ONTOLOGY,
      description: "Controlled semantic relation asserted between the two identifiers.",
    }),
    field("match_method", {
      semanticRole: "matching_evidence_type",
      ontology: MATCH_METHOD_ONTOLOGY,
      description: "Controlled method used to propose or establish the link.",
    }),
    field("match_evidence", {
      dataType: "json",
      semanticRole: "matching_evidence",
      description: "Structured evidence supporting the match, including compared source values.",
    }),
    field("conflict_status", {
      semanticRole: "conflict_status",
      ontology: CONFLICT_STATUS_ONTOLOGY,
      description: "Controlled status that keeps matched, conflicting, and unresolved assertions distinct.",
    }),
    optionalField("conflict_details", {
      dataType: "json",
      semanticRole: "conflict_evidence",
      description: "Structured conflicting values and source references; conflicts are retained, not merged away.",
    }),
    field("confidence_score", {
      dataType: "float",
      semanticRole: "confidence",
      unitPolicy: "range_0_1",
      description: "Numeric confidence score in the inclusive range from zero to one.",
    }),
    field("confidence_level", {
      semanticRole: "confidence",
      ontology: CONFIDENCE_ONTOLOGY,
      description: "Controlled qualitative confidence level.",
    }),
    SOURCE_ID,
  ];
}

const TEMPLATES: Readonly<Record<CommonSchemaKind, CommonSchemaTemplate>> = {
  entity: ENTITY_TEMPLATE,
  paper: PAPER_TEMPLATE,
  compound: COMPOUND_TEMPLATE,
  assay: ASSAY_TEMPLATE,
  structure_dimension: STRUCTURE_TEMPLATE,
  trial: TRIAL_TEMPLATE,
  source: SOURCE_TEMPLATE,
  entity_crosswalk: {
    rowGranularity: "one cross-database entity link assertion",
    primaryKey: ["crosswalk_id"],
    fields: crosswalkFields(false),
  },
  compound_crosswalk: {
    rowGranularity: "one cross-database compound identity link assertion",
    primaryKey: ["crosswalk_id"],
    fields: crosswalkFields(true),
  },
};

function safeFamilyFragment(datasetFamily: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(datasetFamily)) {
    throw new TypeError("datasetFamily must be a non-empty safe identifier");
  }
  return datasetFamily;
}

export function buildCommonSchema(
  kind: CommonSchemaKind,
  options: CommonSchemaOptions,
): DatasetSchemaV2 {
  const family = safeFamilyFragment(options.datasetFamily);
  const template = TEMPLATES[kind];
  return parseDatasetSchemaV2({
    schema_version: "2.0",
    schema_id: options.schemaId ?? `${family}.common.${kind}.v1`,
    dataset_family: family,
    row_granularity: options.rowGranularity ?? template.rowGranularity,
    primary_key: [...template.primaryKey],
    fields: template.fields.map((item) => ({ ...item })),
  });
}

export function buildCommonTable(
  kind: CommonSchemaKind,
  options: CommonTableOptions,
): CommonTableBuilderResult {
  const schema = buildCommonSchema(kind, options);
  const allFieldNames = schema.fields.map((item) => item.name);
  const fieldNames = options.fieldNames === undefined
    ? allFieldNames
    : allFieldNames.filter((name) => options.fieldNames?.includes(name));
  const requestedFields = new Set(options.fieldNames ?? allFieldNames);
  const unknownFields = [...requestedFields].filter((name) => !allFieldNames.includes(name));
  if (unknownFields.length > 0) {
    throw new TypeError(`common table references unknown field(s): ${unknownFields.join(", ")}`);
  }
  const requiredFields = schema.fields.filter((item) => item.required).map((item) => item.name);
  const missingFields = [...schema.primary_key, ...requiredFields]
    .filter((name) => !requestedFields.has(name));
  if (missingFields.length > 0) {
    throw new TypeError(`common table omits required field(s): ${[...new Set(missingFields)].join(", ")}`);
  }
  if (options.role === "primary" && options.allowEmpty === true) {
    throw new TypeError("primary common tables cannot allow empty data");
  }
  const definition = parseTableDefinition({
    table_id: options.tableId,
    schema_ref: schema.schema_id,
    role: options.role,
    required: options.required ?? true,
    allow_empty: options.allowEmpty ?? false,
    primary_key: [...schema.primary_key],
    field_names: fieldNames,
  });
  return { schema, definition };
}

export function buildBiomedicalRelation(
  options: BiomedicalRelationOptions,
): RelationDefinition {
  const relationType = parseRelationType(options.relationType);
  if (!RELATION_CARDINALITIES.includes(options.cardinality)) {
    throw new TypeError(`unsupported relation cardinality '${options.cardinality}'`);
  }
  return parseRelationDefinition({
    relation_id: options.relationId ?? relationType,
    from_table_id: options.fromTableId,
    from_fields: [...options.fromFields],
    to_table_id: options.toTableId,
    to_fields: [...options.toFields],
    cardinality: options.cardinality,
    missing_policy: options.missingPolicy ?? "reject",
  });
}

export function buildEntitySchema(options: CommonSchemaOptions): DatasetSchemaV2 {
  return buildCommonSchema("entity", options);
}

export function buildPaperSchema(options: CommonSchemaOptions): DatasetSchemaV2 {
  return buildCommonSchema("paper", options);
}

export function buildCompoundSchema(options: CommonSchemaOptions): DatasetSchemaV2 {
  return buildCommonSchema("compound", options);
}

export function buildAssaySchema(options: CommonSchemaOptions): DatasetSchemaV2 {
  return buildCommonSchema("assay", options);
}

export function buildStructureDimensionSchema(options: CommonSchemaOptions): DatasetSchemaV2 {
  return buildCommonSchema("structure_dimension", options);
}

export function buildTrialSchema(options: CommonSchemaOptions): DatasetSchemaV2 {
  return buildCommonSchema("trial", options);
}

export function buildSourceSchema(options: CommonSchemaOptions): DatasetSchemaV2 {
  return buildCommonSchema("source", options);
}

export function buildEntityCrosswalkSchema(options: CommonSchemaOptions): DatasetSchemaV2 {
  return buildCommonSchema("entity_crosswalk", options);
}

export function buildCompoundCrosswalkSchema(options: CommonSchemaOptions): DatasetSchemaV2 {
  return buildCommonSchema("compound_crosswalk", options);
}

export function buildEntityTable(options: CommonTableOptions): CommonTableBuilderResult {
  return buildCommonTable("entity", options);
}

export function buildPaperTable(options: CommonTableOptions): CommonTableBuilderResult {
  return buildCommonTable("paper", options);
}

export function buildCompoundTable(options: CommonTableOptions): CommonTableBuilderResult {
  return buildCommonTable("compound", options);
}

export function buildAssayTable(options: CommonTableOptions): CommonTableBuilderResult {
  return buildCommonTable("assay", options);
}

export function buildStructureDimensionTable(options: CommonTableOptions): CommonTableBuilderResult {
  return buildCommonTable("structure_dimension", options);
}

export function buildTrialTable(options: CommonTableOptions): CommonTableBuilderResult {
  return buildCommonTable("trial", options);
}

export function buildSourceTable(options: CommonTableOptions): CommonTableBuilderResult {
  return buildCommonTable("source", options);
}

export function buildEntityCrosswalkTable(options: CommonTableOptions): CommonTableBuilderResult {
  return buildCommonTable("entity_crosswalk", options);
}

export function buildCompoundCrosswalkTable(options: CommonTableOptions): CommonTableBuilderResult {
  return buildCommonTable("compound_crosswalk", options);
}
