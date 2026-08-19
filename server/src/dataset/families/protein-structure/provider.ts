import type { JsonPointerSourceLocator } from "@biomed/contracts";

import type {
  ProteinStructureChainInput,
  ProteinStructureLigandInput,
  ProteinStructureRows,
} from "./types.js";
import { assertProteinStructureRows } from "./validation.js";

export const PROTEIN_STRUCTURE_PROVIDER_ID = "protein.structure.carrier.v1";

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

type CifToken = { value: string; line: number };
type CifLoop = { headers: string[]; rows: Map<string, CifToken>[] };
type CifDocument = { scalars: Map<string, CifToken>; loops: CifLoop[] };

function tokenizeCif(content: string): CifToken[] {
  const tokens: CifToken[] = [];
  let index = 0;
  let line = 1;
  let lineStart = true;
  while (index < content.length) {
    const character = content[index]!;
    if (character === "\r" || character === "\n") {
      if (character === "\r" && content[index + 1] === "\n") index += 1;
      index += 1;
      line += 1;
      lineStart = true;
      continue;
    }
    if (character === " " || character === "\t") {
      index += 1;
      lineStart = false;
      continue;
    }
    if (character === "#") {
      while (index < content.length && content[index] !== "\r" && content[index] !== "\n") index += 1;
      continue;
    }
    const tokenLine = line;
    if (character === ";" && lineStart) {
      index += 1;
      const start = index;
      while (index < content.length) {
        const atLineStart = index === 0 || content[index - 1] === "\n" || content[index - 1] === "\r";
        if (atLineStart && content[index] === ";") break;
        if (content[index] === "\r" || content[index] === "\n") {
          if (content[index] === "\r" && content[index + 1] === "\n") index += 1;
          line += 1;
          lineStart = true;
        } else {
          lineStart = false;
        }
        index += 1;
      }
      tokens.push({ value: content.slice(start, index).replace(/^\r?\n/, "").replace(/\r?\n$/, ""), line: tokenLine });
      if (index < content.length) {
        index += 1;
        lineStart = false;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      const quote = character;
      index += 1;
      const start = index;
      while (index < content.length && content[index] !== quote) index += 1;
      if (index >= content.length) fail("mmCIF contains an unterminated quoted value");
      tokens.push({ value: content.slice(start, index), line: tokenLine });
      index += 1;
      lineStart = false;
      continue;
    }
    const start = index;
    while (index < content.length && !/\s/.test(content[index]!)) index += 1;
    tokens.push({ value: content.slice(start, index), line: tokenLine });
    lineStart = false;
  }
  return tokens;
}

function parseCif(content: string): CifDocument {
  const tokens = tokenizeCif(content);
  if (tokens.length === 0 || !/^data_/i.test(tokens[0]!.value)) fail("mmCIF is missing a data block");
  const scalars = new Map<string, CifToken>();
  const loops: CifLoop[] = [];
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token.value.toLowerCase() === "loop_") {
      index += 1;
      const headers: string[] = [];
      while (index < tokens.length && tokens[index]!.value.startsWith("_")) headers.push(tokens[index++]!.value.toLowerCase());
      if (headers.length === 0) fail(`mmCIF loop at line ${token.line} has no tags`);
      const values: CifToken[] = [];
      while (index < tokens.length) {
        const next = tokens[index]!;
        if (next.value.toLowerCase() === "loop_" || /^data_/i.test(next.value) ||
            (next.value.startsWith("_") && values.length % headers.length === 0)) break;
        values.push(next);
        index += 1;
      }
      if (values.length % headers.length !== 0) fail(`mmCIF loop at line ${token.line} has incomplete rows`);
      const rows: Map<string, CifToken>[] = [];
      for (let offset = 0; offset < values.length; offset += headers.length) {
        rows.push(new Map(headers.map((header, headerIndex) => [header, values[offset + headerIndex]!] as const)));
      }
      loops.push({ headers, rows });
      continue;
    }
    if (token.value.startsWith("_")) {
      const value = tokens[index + 1];
      if (value === undefined || value.value.toLowerCase() === "loop_" || value.value.startsWith("_")) {
        fail(`mmCIF tag ${token.value} at line ${token.line} has no value`);
      }
      scalars.set(token.value.toLowerCase(), value);
      index += 2;
      continue;
    }
    index += 1;
  }
  return { scalars, loops };
}

function cifValue(document: CifDocument, tag: string): string | null {
  const value = document.scalars.get(tag.toLowerCase())?.value;
  return value === undefined || value === "?" || value === "." ? null : value.trim();
}

function cifLoop(document: CifDocument, tag: string): CifLoop | null {
  const normalized = tag.toLowerCase();
  return document.loops.find((loop) => loop.headers.includes(normalized)) ?? null;
}

function loopValue(row: Map<string, CifToken>, tag: string): string | null {
  const value = row.get(tag.toLowerCase())?.value;
  return value === undefined || value === "?" || value === "." ? null : value.trim();
}

function cifValueOrLoop(document: CifDocument, tag: string): string | null {
  const scalar = cifValue(document, tag);
  if (scalar !== null) return scalar;
  const loop = cifLoop(document, tag);
  return loop === null ? null : loopValue(loop.rows[0] ?? new Map(), tag);
}

function cifDate(value: string | null, label: string): string {
  if (value === null) fail(`${label} is required`);
  return isoDate(value, label);
}

function cifNumber(value: string | null, label: string): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) fail(`${label} is not a number`);
  return parsed;
}

function cifInteger(value: string | null, label: string): number | null {
  if (value === null) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) fail(`${label} is not a positive integer`);
  return parsed;
}

function parseMmcifText(request: ProteinStructureCarrierRequest, content: string): ProteinStructureRows {
  const document = parseCif(content);
  const structureId = text(cifValue(document, "_entry.id"), "_entry.id").toUpperCase();
  const revisionLoop = cifLoop(document, "_database_pdb_rev.num");
  const revisions = (revisionLoop?.rows ?? []).map((row, index) => ({
    number: cifInteger(loopValue(row, "_database_pdb_rev.num"), `database_PDB_rev.num[${index}]`),
    date: loopValue(row, "_database_pdb_rev.date"),
  })).filter((revision): revision is { number: number; date: string | null } => revision.number !== null);
  const revision = revisions.sort((left, right) => left.number - right.number).at(-1);
  const structureVersion = String(revision?.number ?? 1);
  const depositedAt = cifDate(
    cifValue(document, "_pdbx_database_status.recvd_initial_deposition_date") ?? revision?.date ?? null,
    "mmCIF deposition date",
  );
  const title = text(cifValue(document, "_struct.title"), "_struct.title");
  const experimentalLoop = cifLoop(document, "_exptl.method");
  const experimentalMethod = text(
    cifValueOrLoop(document, "_exptl.method") ?? loopValue(experimentalLoop?.rows[0] ?? new Map(), "_exptl.method"),
    "_exptl.method",
  );
  const resolution = cifNumber(
    cifValueOrLoop(document, "_refine.ls_d_res_high") ?? cifValueOrLoop(document, "_reflns.d_resolution_high"),
    "mmCIF resolution",
  );
  const source = sourceRows(request, structureId, "/_entry.id", "mmcif_text");

  const entityPoly = cifLoop(document, "_entity_poly.entity_id");
  const structAsym = cifLoop(document, "_struct_asym.id");
  if (entityPoly === null || structAsym === null) fail("mmCIF is missing entity_poly or struct_asym loops");
  const polymerByEntity = new Map<string, { type: string; sequenceLength: number }>();
  entityPoly.rows.forEach((row, index) => {
    const entityId = text(loopValue(row, "_entity_poly.entity_id"), `entity_poly.entity_id[${index}]`);
    const polymerType = text(loopValue(row, "_entity_poly.type"), `entity_poly.type[${index}]`);
    const sequence = loopValue(row, "_entity_poly.pdbx_seq_one_letter_code_can");
    const normalizedSequence = sequence?.replace(/\s/g, "");
    const sequenceLength = normalizedSequence === null || normalizedSequence === undefined || normalizedSequence === ""
      ? cifInteger(loopValue(row, "_entity_poly.pdbx_seq_length"), `entity_poly.pdbx_seq_length[${index}]`)
      : normalizedSequence.length;
    if (sequenceLength === null) fail(`entity_poly sequence length[${index}] is required`);
    polymerByEntity.set(entityId, { type: polymerType, sequenceLength });
  });
  const chains: ProteinStructureChainInput[] = [];
  structAsym.rows.forEach((row, index) => {
    const chainId = text(loopValue(row, "_struct_asym.id"), `struct_asym.id[${index}]`);
    const entityId = text(loopValue(row, "_struct_asym.entity_id"), `struct_asym.entity_id[${index}]`);
    const polymer = polymerByEntity.get(entityId);
    if (polymer === undefined) return;
    chains.push({
      chain_record_id: `${structureId}_v${structureVersion}_${chainId}`,
      structure_id: structureId,
      structure_version: structureVersion,
      chain_id: chainId,
      polymer_type: polymer.type,
      entity_id: entityId,
      entity_namespace: "pdb_entity",
      sequence_length: polymer.sequenceLength,
      source_id: source.sourceId,
      source_locator: locator(request, `/_struct_asym.id[${index}]`, chainId),
    });
  });

  const chemicalComponents = new Map<string, { name: string; formula: string | null }>();
  const chemComp = cifLoop(document, "_chem_comp.id");
  chemComp?.rows.forEach((row, index) => {
    const id = text(loopValue(row, "_chem_comp.id"), `chem_comp.id[${index}]`);
    chemicalComponents.set(id, {
      name: loopValue(row, "_chem_comp.name") ?? id,
      formula: loopValue(row, "_chem_comp.formula"),
    });
  });
  const nonpolymerEntities = new Set<string>();
  const entityLoop = cifLoop(document, "_entity.id");
  entityLoop?.rows.forEach((row) => {
    if (loopValue(row, "_entity.type")?.toLowerCase().includes("non-polymer")) {
      const entityId = loopValue(row, "_entity.id");
      if (entityId !== null) nonpolymerEntities.add(entityId);
    }
  });
  const ligandOccurrences: { entityId: string | null; chainId: string; ligandId: string }[] = [];
  const nonpolymerScheme = cifLoop(document, "_nonpolymer_scheme.asym_id");
  nonpolymerScheme?.rows.forEach((row) => {
    const entityId = loopValue(row, "_nonpolymer_scheme.entity_id");
    const ligandId = loopValue(row, "_nonpolymer_scheme.mon_id");
    const chainId = loopValue(row, "_nonpolymer_scheme.asym_id");
    if (ligandId !== null && chainId !== null && (entityId === null || nonpolymerEntities.size === 0 || nonpolymerEntities.has(entityId))) {
      ligandOccurrences.push({ entityId, chainId, ligandId });
    }
  });
  const entityNonpoly = cifLoop(document, "_pdbx_entity_nonpoly.comp_id");
  entityNonpoly?.rows.forEach((row) => {
    const ligandId = loopValue(row, "_pdbx_entity_nonpoly.comp_id");
    const entityId = loopValue(row, "_pdbx_entity_nonpoly.entity_id");
    if (ligandId !== null && ligandOccurrences.every((occurrence) => occurrence.ligandId !== ligandId)) {
      ligandOccurrences.push({ entityId, chainId: "_", ligandId });
    }
  });
  const ligands: ProteinStructureLigandInput[] = [];
  const seenLigands = new Set<string>();
  ligandOccurrences.forEach((occurrence, index) => {
    if (["HOH", "DOD", "WAT"].includes(occurrence.ligandId.toUpperCase())) return;
    const component = chemicalComponents.get(occurrence.ligandId);
    const key = `${occurrence.ligandId}_${occurrence.chainId}_${occurrence.entityId ?? "_"}`;
    if (seenLigands.has(key)) return;
    seenLigands.add(key);
    ligands.push({
      ligand_record_id: `${structureId}_v${structureVersion}_${key}`,
      structure_id: structureId,
      structure_version: structureVersion,
      ligand_id: occurrence.ligandId,
      ligand_namespace: "pdb_chemical_component",
      chemical_name: component?.name ?? occurrence.ligandId,
      formula: component?.formula ?? null,
      source_id: source.sourceId,
      source_locator: locator(request, `/_nonpolymer_scheme.mon_id[${index}]`, occurrence.ligandId),
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
      source_locator: locator(request, "/_entry.id", structureId),
    }],
    chains,
    ligands,
    sources: source.rows,
  };
  assertProteinStructureRows(rows);
  return rows;
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
  const trimmed = content.trimStart();
  const json = request.mediaType.includes("json") || trimmed.startsWith("{");
  const mmcif = request.mediaType.includes("cif") || /^data_\\S+/i.test(trimmed);
  if (json) return parseRcsbJson(request, content);
  return mmcif ? parseMmcifText(request, content) : parsePdbText(request, content);
}
