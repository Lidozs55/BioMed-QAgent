import type { JsonPointerSourceLocator } from "@biomed/contracts";

import type {
  ProteinStructureChainInput,
  ProteinStructureLigandInput,
  ProteinStructureRows,
} from "./types.js";
import { assertProteinStructureRows } from "./validation.js";

const ASSET_ID = /^asset_[0-9a-f]{64}$/;
const PDB_DATE = /^(\d{2})-([A-Z]{3})-(\d{2})$/;
const MONTHS: Readonly<Record<string, string>> = {
  JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
  JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
};

export interface ProteinStructureCarrierRequest {
  assetId: string;
  logicalFile: string;
  retrievedAt: string;
  mediaType: string;
  bytes: Uint8Array;
}

type JsonRecord = Record<string, unknown>;

function fail(message: string): never {
  throw new TypeError(`PDB structure provider rejected: ${message}`);
}

function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value as JsonRecord;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} is required`);
  return value.trim();
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isoDate(value: string, label: string): string {
  const direct = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  if (direct !== null) return direct[1]!;
  const match = PDB_DATE.exec(value.toUpperCase());
  if (match === null || MONTHS[match[2]!] === undefined) fail(`${label} is not a supported date`);
  const year = Number(match[3]) + (Number(match[3]) >= 70 ? 1900 : 2000);
  return `${year}-${MONTHS[match[2]!]}-${match[1]}`;
}

function locator(request: ProteinStructureCarrierRequest, pointer: string, rawValue: string): JsonPointerSourceLocator {
  return {
    locator_version: "2.0",
    locator_type: "json_pointer",
    asset_id: request.assetId,
    logical_file: request.logicalFile,
    raw_value: rawValue,
    json_pointer: pointer,
  };
}

function sourceRows(
  request: ProteinStructureCarrierRequest,
  structureId: string,
  pointer: string,
  carrierType: string,
) {
  const sourceId = `source_pdb_${structureId.toLowerCase()}`;
  return {
    sourceId,
    rows: [{
      source_id: sourceId,
      source_database: "pdb" as const,
      source_asset_id: request.assetId,
      source_locator: locator(request, pointer, structureId),
      retrieved_at: request.retrievedAt,
      carrier_type: carrierType,
    }],
  };
}

function parsePdbText(request: ProteinStructureCarrierRequest, content: string): ProteinStructureRows {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const first = (name: string) => lines.findIndex((line) => line.startsWith(name));
  const headerIndex = first("HEADER");
  if (headerIndex < 0) fail("PDB text is missing HEADER");
  const header = lines[headerIndex]!;
  const structureId = text(header.slice(62, 66), "HEADER PDB identifier").toUpperCase();
  const depositedAt = isoDate(text(header.slice(50, 59), "HEADER deposition date"), "HEADER deposition date");
  const titleLines = lines.filter((line) => line.startsWith("TITLE "));
  const title = text(titleLines.map((line) => line.slice(10).trim()).join(" "), "TITLE");
  const methodIndex = first("EXPDTA");
  if (methodIndex < 0) fail("PDB text is missing EXPDTA");
  const experimentalMethod = text(lines[methodIndex]!.slice(10), "EXPDTA method");
  const revisionNumbers = lines
    .filter((line) => line.startsWith("REVDAT"))
    .map((line) => Number.parseInt(line.slice(7, 10).trim(), 10))
    .filter(Number.isSafeInteger);
  const structureVersion = String(revisionNumbers.length === 0 ? 1 : Math.max(...revisionNumbers));
  const resolutionLine = lines.find((line) => /^REMARK\s+2 RESOLUTION\./.test(line));
  const resolutionMatch = resolutionLine === undefined ? null : /RESOLUTION\.\s+([0-9.]+)\s+ANGSTROMS/i.exec(resolutionLine);
  const resolution = resolutionMatch === null ? null : Number(resolutionMatch[1]);
  const source = sourceRows(request, structureId, `/pdb_lines/${headerIndex + 1}`, "pdb_text");

  const chains: ProteinStructureChainInput[] = [];
  const chainLengths = new Map<string, { length: number; line: number }>();
  lines.forEach((line, index) => {
    if (!line.startsWith("SEQRES")) return;
    const chainId = text(line.slice(11, 12), `SEQRES chain at line ${index + 1}`);
    const length = Number.parseInt(line.slice(13, 17).trim(), 10);
    if (!Number.isSafeInteger(length) || length < 1) fail(`SEQRES length at line ${index + 1} is invalid`);
    if (!chainLengths.has(chainId)) chainLengths.set(chainId, { length, line: index + 1 });
  });
  for (const [chainId, chain] of chainLengths) {
    chains.push({
      chain_record_id: `${structureId}_v${structureVersion}_${chainId}`,
      structure_id: structureId,
      structure_version: structureVersion,
      chain_id: chainId,
      polymer_type: "polypeptide(L)",
      entity_id: null,
      entity_namespace: null,
      sequence_length: chain.length,
      source_id: source.sourceId,
      source_locator: locator(request, `/pdb_lines/${chain.line}`, chainId),
    });
  }

  const ligandNames = new Map<string, string>();
  const ligandFormulas = new Map<string, string>();
  lines.forEach((line) => {
    if (line.startsWith("HETNAM")) {
      const id = line.slice(11, 14).trim();
      ligandNames.set(id, `${ligandNames.get(id) ?? ""} ${line.slice(15).trim()}`.trim());
    } else if (line.startsWith("FORMUL")) {
      ligandFormulas.set(line.slice(12, 15).trim(), line.slice(18).replace(/^\d+\s*/, "").trim());
    }
  });
  const ligands: ProteinStructureLigandInput[] = [];
  const seenLigands = new Set<string>();
  lines.forEach((line, index) => {
    if (!line.startsWith("HETATM")) return;
    const ligandId = line.slice(17, 20).trim();
    const chainId = line.slice(21, 22).trim() || "_";
    const residueId = line.slice(22, 27).trim();
    const occurrence = `${ligandId}_${chainId}_${residueId}`;
    if (ligandId === "HOH" || seenLigands.has(occurrence)) return;
    seenLigands.add(occurrence);
    ligands.push({
      ligand_record_id: `${structureId}_v${structureVersion}_${occurrence}`,
      structure_id: structureId,
      structure_version: structureVersion,
      ligand_id: text(ligandId, `HETATM ligand at line ${index + 1}`),
      ligand_namespace: "pdb_chemical_component",
      chemical_name: ligandNames.get(ligandId) ?? ligandId,
      formula: ligandFormulas.get(ligandId) ?? null,
      source_id: source.sourceId,
      source_locator: locator(request, `/pdb_lines/${index + 1}`, occurrence),
    });
  });

  const rows: ProteinStructureRows = {
    structures: [{
      structure_id: structureId,
      structure_namespace: "pdb",
      structure_version: structureVersion,
      title,
      experimental_method: experimentalMethod,
      resolution_angstrom: resolution,
      deposited_at: depositedAt,
      source_id: source.sourceId,
      source_locator: locator(request, `/pdb_lines/${headerIndex + 1}`, structureId),
    }],
    chains,
    ligands,
    sources: source.rows,
  };
  assertProteinStructureRows(rows);
  return rows;
}

function parseRcsbJson(request: ProteinStructureCarrierRequest, content: string): ProteinStructureRows {
  let value: unknown;
  try { value = JSON.parse(content); } catch { fail("RCSB carrier is not valid JSON"); }
  const root = record(value, "RCSB entry");
  const structureId = text(root.rcsb_id, "rcsb_id").toUpperCase();
  const accession = record(root.rcsb_accession_info, "rcsb_accession_info");
  const entryInfo = record(root.rcsb_entry_info, "rcsb_entry_info");
  const structure = record(root.struct, "struct");
  const experiments = array(root.exptl);
  const experiment = record(experiments[0], "exptl[0]");
  const revisionDate = optionalText(accession.revision_date) ?? optionalText(accession.initial_release_date) ?? "1";
  const source = sourceRows(request, structureId, "", "rcsb_entry_json");
  const polymerEntities = array(root.polymer_entities);
  const chains: ProteinStructureChainInput[] = [];
  polymerEntities.forEach((item, entityIndex) => {
    const entity = record(item, `polymer_entities[${entityIndex}]`);
    const polymer = record(entity.entity_poly, `polymer_entities[${entityIndex}].entity_poly`);
    const identifiers = record(entity.rcsb_polymer_entity_container_identifiers, `polymer_entities[${entityIndex}].identifiers`);
    const chainIds = array(identifiers.auth_asym_ids).map((chain) => text(chain, "auth_asym_id"));
    const uniprot = array(identifiers.uniprot_ids).map((id) => text(id, "uniprot_id"))[0] ?? null;
    const sequence = text(polymer.pdbx_seq_one_letter_code_can, "polymer sequence").replace(/\s/g, "");
    for (const chainId of chainIds) {
      chains.push({
        chain_record_id: `${structureId}_v${revisionDate}_${chainId}`,
        structure_id: structureId,
        structure_version: revisionDate,
        chain_id: chainId,
        polymer_type: text(polymer.type, "polymer type"),
        entity_id: uniprot,
        entity_namespace: uniprot === null ? null : "uniprot",
        sequence_length: sequence.length,
        source_id: source.sourceId,
        source_locator: locator(request, `/polymer_entities/${entityIndex}`, chainId),
      });
    }
  });
  const ligands: ProteinStructureLigandInput[] = array(root.nonpolymer_entities).map((item, index) => {
    const entity = record(item, `nonpolymer_entities[${index}]`);
    const component = record(record(entity.nonpolymer_comp, "nonpolymer_comp").chem_comp, "chem_comp");
    const ligandId = text(component.id, "chem_comp.id");
    return {
      ligand_record_id: `${structureId}_v${revisionDate}_${ligandId}_${index + 1}`,
      structure_id: structureId,
      structure_version: revisionDate,
      ligand_id: ligandId,
      ligand_namespace: "pdb_chemical_component",
      chemical_name: text(component.name, "chem_comp.name"),
      formula: optionalText(component.formula),
      source_id: source.sourceId,
      source_locator: locator(request, `/nonpolymer_entities/${index}`, ligandId),
    };
  });
  const resolutions = array(entryInfo.resolution_combined).filter((item): item is number => typeof item === "number" && Number.isFinite(item));
  const rows: ProteinStructureRows = {
    structures: [{
      structure_id: structureId,
      structure_namespace: "pdb",
      structure_version: revisionDate,
      title: text(structure.title, "struct.title"),
      experimental_method: text(experiment.method, "exptl[0].method"),
      resolution_angstrom: resolutions[0] ?? null,
      deposited_at: isoDate(text(accession.deposit_date, "deposit_date"), "deposit_date"),
      source_id: source.sourceId,
      source_locator: locator(request, "/rcsb_id", structureId),
    }],
    chains,
    ligands,
    sources: source.rows,
  };
  assertProteinStructureRows(rows);
  return rows;
}

/** Fixed server capability: one trusted PDB/RCSB carrier expands to every required canonical table. */
export function parseProteinStructureCarrier(request: ProteinStructureCarrierRequest): ProteinStructureRows {
  if (!ASSET_ID.test(request.assetId)) fail("assetId must be content addressed");
  if (request.logicalFile.trim() === "") fail("logicalFile is required");
  if (Number.isNaN(Date.parse(request.retrievedAt))) fail("retrievedAt must be an ISO datetime");
  const content = new TextDecoder("utf-8", { fatal: true }).decode(request.bytes);
  const json = request.mediaType.includes("json") || content.trimStart().startsWith("{");
  return json ? parseRcsbJson(request, content) : parsePdbText(request, content);
}
