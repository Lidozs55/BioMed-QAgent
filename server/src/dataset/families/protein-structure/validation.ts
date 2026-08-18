import type { RelationDefinition, SourceLocatorV2 } from "@biomed/contracts";

import type {
  MultiTableValidationRequest,
  MultiTableValidationResult,
} from "../../contracts/index.js";
import { parseSourceLocator } from "../../contracts/index.js";
import { validateMultiTableCandidate } from "../../validation/multitable.js";
import { buildProteinStructureTables } from "./schemas.js";
import type {
  ProteinStructureChainInput,
  ProteinStructureLigandInput,
  ProteinStructureRecordInput,
  ProteinStructureRows,
  ProteinStructureSourceInput,
} from "./types.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const CONTENT_ASSET_ID = /^asset_[0-9a-f]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function fail(message: string): never {
  throw new TypeError(`protein structure rejected: ${message}`);
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${name} is required`);
  return value;
}

function safeId(value: unknown, name: string): string {
  const parsed = text(value, name);
  if (!SAFE_ID.test(parsed) || parsed.includes("..")) fail(`${name} is not a safe identifier`);
  return parsed;
}

function locator(value: unknown, name: string): SourceLocatorV2 {
  try {
    const parsed = parseSourceLocator(value);
    if (!("locator_version" in parsed) || parsed.locator_version !== "2.0") {
      fail(`${name} must use SourceLocator 2.0`);
    }
    if (!CONTENT_ASSET_ID.test(parsed.asset_id)) {
      fail(`${name}.asset_id must be content addressed`);
    }
    return parsed;
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith("protein structure rejected:")) {
      throw error;
    }
    fail(`${name} is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function structureKey(structureId: string, version: string): string {
  return `${structureId}\u001f${version}`;
}

function assertSourceLink(
  sourceId: string,
  sourceLocator: SourceLocatorV2,
  sources: ReadonlyMap<string, ProteinStructureSourceInput>,
  label: string,
): void {
  const source = sources.get(sourceId);
  if (source === undefined) fail(`${label} references missing source_id`);
  if (source.source_database !== "pdb") fail(`${label} source must be PDB`);
  if (sourceLocator.asset_id !== source.source_asset_id) {
    fail(`${label} locator does not match its source asset`);
  }
}

export function assertProteinStructureRecord(value: ProteinStructureRecordInput): void {
  safeId(value.structure_id, "structure_id");
  if (value.structure_namespace !== "pdb") fail("structure_namespace must be pdb");
  text(value.structure_version, "structure_version");
  text(value.title, "title");
  text(value.experimental_method, "experimental_method");
  if (value.resolution_angstrom !== null &&
      (!Number.isFinite(value.resolution_angstrom) || value.resolution_angstrom <= 0)) {
    fail("resolution_angstrom must be positive when present");
  }
  if (!ISO_DATE.test(text(value.deposited_at, "deposited_at"))) fail("deposited_at must be an ISO date");
  safeId(value.source_id, "source_id");
  locator(value.source_locator, "source_locator");
}

export function assertProteinStructureChain(value: ProteinStructureChainInput): void {
  safeId(value.chain_record_id, "chain_record_id");
  safeId(value.structure_id, "structure_id");
  text(value.structure_version, "structure_version");
  text(value.chain_id, "chain_id");
  text(value.polymer_type, "polymer_type");
  if ((value.entity_id === null) !== (value.entity_namespace === null)) {
    fail("entity_id and entity_namespace must be present together");
  }
  if (value.entity_id !== null) safeId(value.entity_id, "entity_id");
  if (value.entity_namespace !== null) text(value.entity_namespace, "entity_namespace");
  if (!Number.isSafeInteger(value.sequence_length) || value.sequence_length < 1) {
    fail("sequence_length must be a positive integer");
  }
  safeId(value.source_id, "source_id");
  locator(value.source_locator, "source_locator");
}

export function assertProteinStructureLigand(value: ProteinStructureLigandInput): void {
  safeId(value.ligand_record_id, "ligand_record_id");
  safeId(value.structure_id, "structure_id");
  text(value.structure_version, "structure_version");
  safeId(value.ligand_id, "ligand_id");
  text(value.ligand_namespace, "ligand_namespace");
  text(value.chemical_name, "chemical_name");
  if (value.formula !== null) text(value.formula, "formula");
  safeId(value.source_id, "source_id");
  locator(value.source_locator, "source_locator");
}

export function assertProteinStructureSource(value: ProteinStructureSourceInput): void {
  safeId(value.source_id, "source_id");
  if (value.source_database !== "pdb") fail("source_database must be pdb");
  if (!CONTENT_ASSET_ID.test(value.source_asset_id)) fail("source_asset_id must be content addressed");
  const parsedLocator = locator(value.source_locator, "source_locator");
  if (parsedLocator.asset_id !== value.source_asset_id) {
    fail("source locator does not match source_asset_id");
  }
  if (Number.isNaN(Date.parse(text(value.retrieved_at, "retrieved_at")))) {
    fail("retrieved_at must be an ISO datetime");
  }
  text(value.carrier_type, "carrier_type");
}

export function assertProteinStructureRelations(
  relations: readonly RelationDefinition[],
): void {
  const expected = buildProteinStructureTables().relations;
  if (relations.length !== expected.length) fail("all structure, chain, ligand, and source relations are required");
  for (const relation of expected) {
    const actual = relations.find((item) => item.relation_id === relation.relation_id);
    if (actual === undefined || JSON.stringify(actual) !== JSON.stringify(relation)) {
      fail(`relation ${relation.relation_id} is missing or changed`);
    }
  }
}

export async function validateProteinStructureCandidate(
  request: MultiTableValidationRequest,
  signal?: AbortSignal | null,
): Promise<MultiTableValidationResult> {
  const schemas = buildProteinStructureTables();
  const expectedTables = [
    schemas.structureTable,
    schemas.chainTable,
    schemas.ligandTable,
    schemas.sourceTable,
  ];
  const actualTableIds = request.tables.map((table) => table.definition.table_id).sort();
  const expectedTableIds = expectedTables.map((table) => table.table_id).sort();
  if (JSON.stringify(actualTableIds) !== JSON.stringify(expectedTableIds)) {
    fail("structures, chains, ligands, and sources tables are all required");
  }
  assertProteinStructureRelations(request.relations);
  const candidateRelationIds = [...request.candidate.relation_ids].sort();
  const expectedRelationIds = schemas.relations.map((relation) => relation.relation_id).sort();
  if (JSON.stringify(candidateRelationIds) !== JSON.stringify(expectedRelationIds)) {
    fail("candidate must reference every protein structure relation");
  }
  return validateMultiTableCandidate(request, signal);
}

export function assertProteinStructureRows(rows: ProteinStructureRows): void {
  if (rows.structures.length === 0) fail("primary structure table must not be empty");
  if (rows.chains.length === 0) fail("chain supporting table must not be empty");
  if (rows.ligands.length === 0) fail("ligand supporting table must not be empty");
  if (rows.sources.length === 0) fail("source supporting table must not be empty");

  const sources = new Map<string, ProteinStructureSourceInput>();
  for (const source of rows.sources) {
    assertProteinStructureSource(source);
    if (sources.has(source.source_id)) fail(`duplicate source_id ${source.source_id}`);
    sources.set(source.source_id, source);
  }

  const structures = new Set<string>();
  for (const structure of rows.structures) {
    assertProteinStructureRecord(structure);
    const key = structureKey(structure.structure_id, structure.structure_version);
    if (structures.has(key)) fail(`duplicate structure version ${structure.structure_id}`);
    structures.add(key);
    assertSourceLink(structure.source_id, structure.source_locator, sources, `structure ${structure.structure_id}`);
  }

  const chainIds = new Set<string>();
  for (const chain of rows.chains) {
    assertProteinStructureChain(chain);
    if (chainIds.has(chain.chain_record_id)) fail(`duplicate chain_record_id ${chain.chain_record_id}`);
    chainIds.add(chain.chain_record_id);
    if (!structures.has(structureKey(chain.structure_id, chain.structure_version))) {
      fail(`chain ${chain.chain_record_id} references missing structure version`);
    }
    assertSourceLink(chain.source_id, chain.source_locator, sources, `chain ${chain.chain_record_id}`);
  }

  const ligandIds = new Set<string>();
  for (const ligand of rows.ligands) {
    assertProteinStructureLigand(ligand);
    if (ligandIds.has(ligand.ligand_record_id)) fail(`duplicate ligand_record_id ${ligand.ligand_record_id}`);
    ligandIds.add(ligand.ligand_record_id);
    if (!structures.has(structureKey(ligand.structure_id, ligand.structure_version))) {
      fail(`ligand ${ligand.ligand_record_id} references missing structure version`);
    }
    assertSourceLink(ligand.source_id, ligand.source_locator, sources, `ligand ${ligand.ligand_record_id}`);
  }
}
