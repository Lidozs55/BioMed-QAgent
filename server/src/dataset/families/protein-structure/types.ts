import type {
  DatasetSchemaV2,
  RelationDefinition,
  SourceLocatorV2,
  TableDefinition,
} from "@biomed/contracts";

export const PROTEIN_STRUCTURE_FAMILY_ID = "protein_structure";
export const PROTEIN_STRUCTURE_ROW_GRANULARITY =
  "one versioned macromolecular structure record";

export type ProteinStructureTableId =
  | "structures"
  | "chains"
  | "ligands"
  | "sources";

export interface ProteinStructureSchemaSet {
  structure: DatasetSchemaV2;
  chain: DatasetSchemaV2;
  ligand: DatasetSchemaV2;
  source: DatasetSchemaV2;
  structureTable: TableDefinition;
  chainTable: TableDefinition;
  ligandTable: TableDefinition;
  sourceTable: TableDefinition;
  relations: readonly RelationDefinition[];
}

export interface ProteinStructureRecordInput {
  structure_id: string;
  structure_namespace: "pdb";
  structure_version: string;
  title: string;
  experimental_method: string;
  resolution_angstrom: number | null;
  deposited_at: string;
  source_id: string;
  source_locator: SourceLocatorV2;
}

export interface ProteinStructureChainInput {
  chain_record_id: string;
  structure_id: string;
  structure_version: string;
  chain_id: string;
  polymer_type: string;
  entity_id: string | null;
  entity_namespace: string | null;
  sequence_length: number;
  source_id: string;
  source_locator: SourceLocatorV2;
}

export interface ProteinStructureLigandInput {
  ligand_record_id: string;
  structure_id: string;
  structure_version: string;
  ligand_id: string;
  ligand_namespace: string;
  chemical_name: string;
  formula: string | null;
  source_id: string;
  source_locator: SourceLocatorV2;
}

export interface ProteinStructureSourceInput {
  source_id: string;
  source_database: "pdb";
  source_asset_id: string;
  source_locator: SourceLocatorV2;
  retrieved_at: string;
  carrier_type: string;
}

export interface ProteinStructureRows {
  structures: readonly ProteinStructureRecordInput[];
  chains: readonly ProteinStructureChainInput[];
  ligands: readonly ProteinStructureLigandInput[];
  sources: readonly ProteinStructureSourceInput[];
}
