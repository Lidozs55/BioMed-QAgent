import type { DatasetSchemaV2, RelationDefinition } from "@biomed/contracts";

import {
  buildBiomedicalRelation,
  buildSourceTable,
} from "../../schema/common/index.js";
import {
  parseDatasetSchemaV2,
  parseTableDefinition,
} from "../../contracts/index.js";
import type { ProteinStructureSchemaSet } from "./types.js";
import {
  PROTEIN_STRUCTURE_FAMILY_ID,
  PROTEIN_STRUCTURE_ROW_GRANULARITY,
} from "./types.js";

const ID_NAMESPACE_ONTOLOGY = "biomed:id_namespace.v1";
const STRUCTURE_VERSION_ONTOLOGY = "biomed:structure_version.v1";

function field(
  name: string,
  options: {
    dataType?: string;
    semanticRole: string;
    required?: boolean;
    nullable?: boolean;
    unitPolicy?: string | null;
    ontology?: string | null;
    description: string;
  },
): DatasetSchemaV2["fields"][number] {
  return {
    schema_version: "2.0",
    name,
    data_type: options.dataType ?? "string",
    semantic_role: options.semanticRole,
    required: options.required ?? true,
    nullable: options.nullable ?? false,
    unit_policy: options.unitPolicy ?? null,
    ontology: options.ontology ?? null,
    description: options.description,
    derivation_policy: null,
  };
}

function optionalField(
  name: string,
  options: Parameters<typeof field>[1],
): DatasetSchemaV2["fields"][number] {
  return field(name, { ...options, required: false, nullable: true });
}

export function buildProteinStructureSchema(): DatasetSchemaV2 {
  return parseDatasetSchemaV2({
    schema_version: "2.0",
    schema_id: "protein_structure.structure.v1",
    dataset_family: PROTEIN_STRUCTURE_FAMILY_ID,
    row_granularity: PROTEIN_STRUCTURE_ROW_GRANULARITY,
    primary_key: ["structure_id", "structure_version"],
    fields: [
      field("structure_id", {
        semanticRole: "entity_identifier",
        description: "PDB entry identifier for the macromolecular structure.",
      }),
      field("structure_namespace", {
        semanticRole: "identifier_namespace",
        ontology: ID_NAMESPACE_ONTOLOGY,
        description: "Structure identifier authority; protein_structure accepts only pdb.",
      }),
      field("structure_version", {
        semanticRole: "structure_version",
        ontology: STRUCTURE_VERSION_ONTOLOGY,
        description: "Exact PDB revision or version used to interpret all supporting records.",
      }),
      field("title", {
        semanticRole: "entity_label",
        description: "Structure title reported by PDB.",
      }),
      field("experimental_method", {
        semanticRole: "structure_method",
        description: "Experimental method reported for the PDB entry.",
      }),
      optionalField("resolution_angstrom", {
        dataType: "float",
        semanticRole: "measurement",
        unitPolicy: "angstrom",
        description: "Reported experimental resolution in angstroms when applicable.",
      }),
      field("deposited_at", {
        dataType: "date",
        semanticRole: "structure_deposition_date",
        description: "PDB deposition date in ISO 8601 date form.",
      }),
      field("source_id", {
        semanticRole: "foreign_key",
        description: "PDB source carrier record for this structure revision.",
      }),
      field("source_locator", {
        dataType: "json",
        semanticRole: "source_locator",
        description: "SourceLocator 2.0 locating the exact PDB record.",
      }),
    ],
  });
}

export function buildProteinStructureChainSchema(): DatasetSchemaV2 {
  return parseDatasetSchemaV2({
    schema_version: "2.0",
    schema_id: "protein_structure.chain.v1",
    dataset_family: PROTEIN_STRUCTURE_FAMILY_ID,
    row_granularity: "one polymer chain in one structure version",
    primary_key: ["chain_record_id"],
    fields: [
      field("chain_record_id", {
        semanticRole: "row_identifier",
        description: "Stable identity of one chain in one PDB structure revision.",
      }),
      field("structure_id", {
        semanticRole: "foreign_key",
        description: "PDB entry containing the chain.",
      }),
      field("structure_version", {
        semanticRole: "structure_version",
        ontology: STRUCTURE_VERSION_ONTOLOGY,
        description: "PDB revision to which this chain belongs.",
      }),
      field("chain_id", {
        semanticRole: "dimension_identifier",
        description: "Author or label chain identifier preserved from PDB.",
      }),
      field("polymer_type", {
        semanticRole: "polymer_type",
        description: "PDB polymer type for this chain.",
      }),
      optionalField("entity_id", {
        semanticRole: "entity_identifier",
        description: "Linked protein or macromolecule identifier when PDB supplies one.",
      }),
      optionalField("entity_namespace", {
        semanticRole: "identifier_namespace",
        ontology: ID_NAMESPACE_ONTOLOGY,
        description: "Authority for entity_id when present.",
      }),
      field("sequence_length", {
        dataType: "integer",
        semanticRole: "sequence_length",
        description: "Number of residues reported for the chain.",
      }),
      field("source_id", {
        semanticRole: "foreign_key",
        description: "PDB source carrier record for this chain.",
      }),
      field("source_locator", {
        dataType: "json",
        semanticRole: "source_locator",
        description: "SourceLocator 2.0 locating the chain record.",
      }),
    ],
  });
}

export function buildProteinStructureLigandSchema(): DatasetSchemaV2 {
  return parseDatasetSchemaV2({
    schema_version: "2.0",
    schema_id: "protein_structure.ligand.v1",
    dataset_family: PROTEIN_STRUCTURE_FAMILY_ID,
    row_granularity: "one ligand occurrence in one structure version",
    primary_key: ["ligand_record_id"],
    fields: [
      field("ligand_record_id", {
        semanticRole: "row_identifier",
        description: "Stable identity of one ligand occurrence in one PDB structure revision.",
      }),
      field("structure_id", {
        semanticRole: "foreign_key",
        description: "PDB entry containing the ligand.",
      }),
      field("structure_version", {
        semanticRole: "structure_version",
        ontology: STRUCTURE_VERSION_ONTOLOGY,
        description: "PDB revision to which this ligand occurrence belongs.",
      }),
      field("ligand_id", {
        semanticRole: "compound_identifier",
        description: "PDB chemical component identifier.",
      }),
      field("ligand_namespace", {
        semanticRole: "identifier_namespace",
        ontology: ID_NAMESPACE_ONTOLOGY,
        description: "Authority for ligand_id; normally pdb_chemical_component.",
      }),
      field("chemical_name", {
        semanticRole: "entity_label",
        description: "Ligand name reported by PDB.",
      }),
      optionalField("formula", {
        semanticRole: "chemical_formula",
        description: "Molecular formula reported by PDB.",
      }),
      field("source_id", {
        semanticRole: "foreign_key",
        description: "PDB source carrier record for this ligand.",
      }),
      field("source_locator", {
        dataType: "json",
        semanticRole: "source_locator",
        description: "SourceLocator 2.0 locating the ligand record.",
      }),
    ],
  });
}

function tableDefinition(
  tableId: string,
  schema: DatasetSchemaV2,
  role: "primary" | "supporting",
) {
  return parseTableDefinition({
    table_id: tableId,
    schema_ref: schema.schema_id,
    role,
    required: true,
    allow_empty: false,
    primary_key: [...schema.primary_key],
    field_names: schema.fields.map((item) => item.name),
  });
}

export function buildProteinStructureTables(): ProteinStructureSchemaSet {
  const structure = buildProteinStructureSchema();
  const chain = buildProteinStructureChainSchema();
  const ligand = buildProteinStructureLigandSchema();
  const sourceResult = buildSourceTable({
    datasetFamily: PROTEIN_STRUCTURE_FAMILY_ID,
    schemaId: "protein_structure.source.v1",
    rowGranularity: "one PDB source carrier record",
    tableId: "sources",
    role: "supporting",
  });
  const relations: RelationDefinition[] = [
    buildBiomedicalRelation({
      relationType: "structure_represents_entity",
      relationId: "chain_structure",
      fromTableId: "chains",
      fromFields: ["structure_id", "structure_version"],
      toTableId: "structures",
      toFields: ["structure_id", "structure_version"],
      cardinality: "many_to_one",
      missingPolicy: "reject",
    }),
    buildBiomedicalRelation({
      relationType: "structure_represents_entity",
      relationId: "ligand_structure",
      fromTableId: "ligands",
      fromFields: ["structure_id", "structure_version"],
      toTableId: "structures",
      toFields: ["structure_id", "structure_version"],
      cardinality: "many_to_one",
      missingPolicy: "reject",
    }),
    ...(["structures", "chains", "ligands"] as const).map((tableId) =>
      buildBiomedicalRelation({
        relationType: "entity_identity_link",
        relationId: `${tableId.slice(0, -1)}_source`,
        fromTableId: tableId,
        fromFields: ["source_id"],
        toTableId: "sources",
        toFields: ["source_id"],
        cardinality: "many_to_one",
        missingPolicy: "reject",
      }),
    ),
  ];
  return {
    structure,
    chain,
    ligand,
    source: sourceResult.schema,
    structureTable: tableDefinition("structures", structure, "primary"),
    chainTable: tableDefinition("chains", chain, "supporting"),
    ligandTable: tableDefinition("ligands", ligand, "supporting"),
    sourceTable: sourceResult.definition,
    relations,
  };
}
