import { createHash } from "node:crypto";

import type { SourceLocatorV2 } from "@biomed/contracts";
import { XMLParser, XMLValidator } from "fast-xml-parser";

import { assertInheritedDiseaseEvidenceRows } from "./validation.js";
import type {
  InheritedDiseaseDiseaseRecord,
  InheritedDiseaseEvidenceCarrier,
  InheritedDiseaseEvidenceCrosswalkRecord,
  InheritedDiseaseEvidenceRows,
  InheritedDiseaseGeneDiseaseRecord,
  InheritedDiseaseGeneRecord,
} from "./types.js";

const GENE_SYMBOL = /^[A-Za-z][A-Za-z0-9-]{0,30}$/;
const HGNC_ID = /^HGNC:[0-9]+$/;
const ORPHA_ID = /^ORPHA:[0-9]+$/;
const OMIM_ID = /^OMIM:[0-9]+$/;
const MONDO_ID = /^MONDO:[0-9]+$/;

const REQUIRED_SOURCES = [
  "orphanet_en_product1",
  "orphanet_en_product6",
  "hgnc_approved",
  "clinvar_gene_esearch",
  "clingen_gene_validity",
] as const;

type XmlRecord = Record<string, unknown>;

interface DiseaseClaim {
  diseaseId: string;
  diseaseName: string;
  omimId: string | null;
  sourceId: string;
  sourceLocator: SourceLocatorV2;
}

interface AssociationClaim {
  diseaseId: string;
  diseaseName: string;
  geneSymbol: string;
  hgncId: string | null;
  associationType: string;
  associationStatus: string;
  sourceId: string;
  sourceLocator: SourceLocatorV2;
}

interface ClinGenClaim {
  geneSymbol: string;
  diseaseName: string;
  diseaseId: string | null;
  classification: string;
}

interface ParsedCarrierParts {
  readonly genes: InheritedDiseaseGeneRecord[];
  readonly diseases: DiseaseClaim[];
  readonly associations: AssociationClaim[];
  readonly crosswalks: Array<{
    evidenceId: string;
    geneSymbol: string;
    pathogenicCount: number;
    sourceId: string;
    sourceLocator: SourceLocatorV2;
  }>;
  readonly clingen: ClinGenClaim[];
}

function fail(message: string): never {
  throw new TypeError(`inherited disease evidence rejected: ${message}`);
}

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== "string" && typeof value !== "number") fail(`${name} is required`);
  const text = String(value).trim();
  if (text === "") fail(`${name} is required`);
  return text;
}

function record(value: unknown, name: string): XmlRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${name} must be an object`);
  }
  return value as XmlRecord;
}

function children(node: unknown, key: string): unknown[] {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return [];
  const value = Reflect.get(node, key);
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function firstChild(node: unknown, key: string, name: string): unknown {
  const value = children(node, key)[0];
  if (value === undefined) fail(`${name} is missing`);
  return value;
}

function text(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(" ").trim();
  if (value === null || typeof value !== "object") return "";
  const object = value as XmlRecord;
  if (object["#text"] !== undefined) return text(object["#text"]);
  return Object.entries(object)
    .filter(([key]) => !key.startsWith("@_"))
    .map(([, child]) => text(child))
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function childText(node: unknown, key: string, name: string): string {
  return nonEmpty(text(firstChild(node, key, name)), name);
}

function optionalChildText(node: unknown, key: string): string | null {
  const value = children(node, key)[0];
  if (value === undefined) return null;
  const parsed = text(value);
  return parsed === "" ? null : parsed;
}

function stableDigest(parts: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24);
}

function xmlLocator(
  carrier: InheritedDiseaseEvidenceCarrier,
  xmlPath: string,
  tableId: string,
  rowIndex: number,
  rawValue: string,
): SourceLocatorV2 {
  return {
    locator_version: "2.0",
    locator_type: "xml_cell",
    asset_id: carrier.assetId,
    logical_file: carrier.logicalFile,
    raw_value: rawValue,
    xml_path: xmlPath,
    table_id: tableId,
    row_index: Math.max(1, rowIndex),
    column_index: 1,
  };
}

function tabularLocator(
  carrier: InheritedDiseaseEvidenceCarrier,
  lineNumber: number,
  columnName: string,
  rawValue: string,
): SourceLocatorV2 {
  // SourceLocator 2.0 has no CSV/TSV-specific variant. The fixed provider
  // transform materializes a logical row/column pointer before any table is
  // written; the carrier path and raw row remain the trust anchors.
  return {
    locator_version: "2.0",
    locator_type: "json_pointer",
    asset_id: carrier.assetId,
    logical_file: carrier.logicalFile,
    raw_value: rawValue,
    json_pointer: `/rows/${lineNumber}/columns/${encodeURIComponent(columnName)}`,
  };
}

function jsonLocator(
  carrier: InheritedDiseaseEvidenceCarrier,
  pointer: string,
  rawValue: string,
): SourceLocatorV2 {
  return {
    locator_version: "2.0",
    locator_type: "json_pointer",
    asset_id: carrier.assetId,
    logical_file: carrier.logicalFile,
    raw_value: rawValue,
    json_pointer: pointer,
  };
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function parseDelimitedLine(line: string, delimiter: string, label: string): string[] {
  const values: string[] = [];
  let value = "";
  let quoted = false;
  let closedQuote = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"') {
        if (line[index + 1] === '"') {
          value += '"';
          index += 1;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else {
        value += character;
      }
      continue;
    }
    if (character === delimiter) {
      values.push(value);
      value = "";
      closedQuote = false;
    } else if (character === '"') {
      if (value.length > 0 || closedQuote) fail(`${label} has an invalid quote`);
      quoted = true;
    } else {
      if (closedQuote) fail(`${label} has characters after a closing quote`);
      value += character;
    }
  }
  if (quoted) fail(`${label} has an unterminated quoted field`);
  values.push(value);
  return values;
}

function hgncId(value: string): string {
  const id = value.startsWith("HGNC:") ? value : `HGNC:${value}`;
  if (!HGNC_ID.test(id)) fail(`invalid HGNC identifier '${value}'`);
  return id;
}

function orphaId(value: string): string {
  const id = value.startsWith("ORPHA:") ? value : `ORPHA:${value}`;
  if (!ORPHA_ID.test(id)) fail(`invalid Orphanet identifier '${value}'`);
  return id;
}

function omimId(value: string): string {
  const id = value.startsWith("OMIM:") ? value : `OMIM:${value}`;
  if (!OMIM_ID.test(id)) fail(`invalid OMIM identifier '${value}'`);
  return id;
}

function geneSymbol(value: string): string {
  if (!GENE_SYMBOL.test(value)) fail(`invalid gene symbol '${value}'`);
  return value;
}

function parseOrphanetCarrier(carrier: InheritedDiseaseEvidenceCarrier): ParsedCarrierParts {
  const xml = carrier.bytes.toString("utf8");
  if (XMLValidator.validate(xml) !== true) fail(`${carrier.source} contains malformed XML`);
  let parsed: unknown;
  try {
    parsed = new XMLParser({
      ignoreAttributes: false,
      parseTagValue: false,
      trimValues: true,
      processEntities: true,
    }).parse(xml) as unknown;
  } catch (error) {
    fail(`${carrier.source} XML cannot be parsed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const document = record(parsed, `${carrier.source} XML root`);
  const root = document.JDBOR === undefined ? document : record(document.JDBOR, `${carrier.source}.JDBOR`);
  const disorderList = firstChild(root, "DisorderList", `${carrier.source}.DisorderList`);
  const disorders = children(disorderList, "Disorder");
  if (disorders.length === 0) fail(`${carrier.source}.DisorderList contains no disorders`);
  const diseases: DiseaseClaim[] = [];
  const associations: AssociationClaim[] = [];
  disorders.forEach((rawDisorder, disorderIndex) => {
    const disorder = record(rawDisorder, `${carrier.source} disorder ${disorderIndex + 1}`);
    const code = childText(disorder, "OrphaCode", `${carrier.source} disorder ${disorderIndex + 1} OrphaCode`);
    const diseaseId = orphaId(code);
    const diseaseName = childText(disorder, "Name", `${carrier.source} disorder ${disorderIndex + 1} Name`);
    const externalReferenceList = children(disorder, "ExternalReferenceList")[0];
    const externalReferences = externalReferenceList === undefined ? [] : children(externalReferenceList, "ExternalReference");
    let omim: string | null = null;
    for (const rawReference of externalReferences) {
      const reference = record(rawReference, `${carrier.source} external reference`);
      const source = optionalChildText(reference, "Source")?.toUpperCase();
      const value = optionalChildText(reference, "Reference");
      if (source === "OMIM" && value !== null) {
        const next = omimId(value);
        if (omim !== null && omim !== next) fail(`${diseaseId} has conflicting OMIM identifiers`);
        omim = next;
      }
    }
    const disorderPath = `/JDBOR/DisorderList/Disorder[${disorderIndex + 1}]`;
    diseases.push({
      diseaseId,
      diseaseName,
      omimId: omim,
      sourceId: carrier.sourceId,
      sourceLocator: xmlLocator(carrier, `${disorderPath}/Name`, "Disorder", disorderIndex + 1, diseaseName),
    });
    const associationLists = children(disorder, "DisorderGeneAssociationList");
    const associationNodes = associationLists.flatMap((list) => children(list, "DisorderGeneAssociation"));
    associationNodes.forEach((rawAssociation, associationIndex) => {
      const association = record(rawAssociation, `${carrier.source} association ${associationIndex + 1}`);
      const gene = record(firstChild(association, "Gene", `${carrier.source} association ${associationIndex + 1} Gene`), `${carrier.source} gene`);
      const symbol = geneSymbol(childText(gene, "Symbol", `${carrier.source} association ${associationIndex + 1} gene Symbol`));
      let directHgnc: string | null = null;
      const geneReferenceList = children(gene, "ExternalReferenceList")[0];
      const geneReferences = geneReferenceList === undefined ? [] : children(geneReferenceList, "ExternalReference");
      for (const rawReference of geneReferences) {
        const reference = record(rawReference, `${carrier.source} gene external reference`);
        if ((optionalChildText(reference, "Source") ?? "").toUpperCase() !== "HGNC") continue;
        const value = optionalChildText(reference, "Reference");
        if (value === null) continue;
        const next = hgncId(value);
        if (directHgnc !== null && directHgnc !== next) fail(`${carrier.source} gene ${symbol} has conflicting HGNC identifiers`);
        directHgnc = next;
      }
      const associationTypeNode = children(association, "DisorderGeneAssociationType")[0];
      const directAssociationType = children(association, "AssociationType")[0];
      const associationType = associationTypeNode === undefined
        ? nonEmpty(text(directAssociationType), `${carrier.source} association ${associationIndex + 1} AssociationType`)
        : childText(associationTypeNode, "Name", `${carrier.source} association ${associationIndex + 1} type Name`);
      const associationStatusNode = children(association, "DisorderGeneAssociationStatus")[0];
      const directAssociationStatus = children(association, "AssociationStatus")[0];
      const associationStatus = associationStatusNode === undefined
        ? directAssociationStatus === undefined ? "not_reported" : nonEmpty(text(directAssociationStatus), `${carrier.source} association ${associationIndex + 1} AssociationStatus`)
        : children(associationStatusNode, "Name").length > 0
          ? childText(associationStatusNode, "Name", `${carrier.source} association ${associationIndex + 1} status Name`)
          : nonEmpty(text(associationStatusNode), `${carrier.source} association ${associationIndex + 1} AssociationStatus`);
      const associationPath = `${disorderPath}/DisorderGeneAssociationList/DisorderGeneAssociation[${associationIndex + 1}]`;
      associations.push({
        diseaseId,
        diseaseName,
        geneSymbol: symbol,
        hgncId: directHgnc,
        associationType,
        associationStatus,
        sourceId: carrier.sourceId,
        sourceLocator: xmlLocator(carrier, `${associationPath}/Gene/Symbol`, "DisorderGeneAssociation", associationIndex + 1, `${symbol}|${associationType}`),
      });
    });
  });
  return { genes: [], diseases, associations, crosswalks: [], clingen: [] };
}

function parseHgncCarrier(carrier: InheritedDiseaseEvidenceCarrier): ParsedCarrierParts {
  const lines = carrier.bytes.toString("utf8").split(/\r\n|\n|\r/);
  const headerIndex = lines.findIndex((line) => line.trim() !== "" && !line.startsWith("#"));
  if (headerIndex < 0) fail("hgnc_approved contains no header");
  const header = parseDelimitedLine(lines[headerIndex]!, "\t", "hgnc_approved header").map(normalizeHeader);
  const required = ["hgnc_id", "symbol", "name", "status"] as const;
  const indexes = Object.fromEntries(required.map((key) => [key, header.indexOf(key)]));
  if (required.some((key) => indexes[key] === -1)) fail("hgnc_approved header must contain hgnc_id, symbol, name, and status");
  const genes: InheritedDiseaseGeneRecord[] = [];
  for (let lineIndex = headerIndex + 1; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!;
    if (line.trim() === "") continue;
    const values = parseDelimitedLine(line, "\t", `hgnc_approved row ${lineIndex + 1}`);
    if (values.length !== header.length) fail(`hgnc_approved row ${lineIndex + 1} width does not match header`);
    const id = hgncId(nonEmpty(values[indexes.hgnc_id]!, `hgnc_approved row ${lineIndex + 1} hgnc_id`));
    const symbol = geneSymbol(nonEmpty(values[indexes.symbol]!, `hgnc_approved row ${lineIndex + 1} symbol`));
    const name = nonEmpty(values[indexes.name]!, `hgnc_approved row ${lineIndex + 1} name`);
    const status = nonEmpty(values[indexes.status]!, `hgnc_approved row ${lineIndex + 1} status`);
    if (status.toLowerCase() !== "approved") continue;
    genes.push({
      gene_id: id,
      gene_namespace: "hgnc",
      gene_symbol: symbol,
      gene_name: name,
      status,
      source_id: carrier.sourceId,
      source_locator: tabularLocator(carrier, lineIndex + 1, "hgnc_id", line),
    });
  }
  if (genes.length === 0) fail("hgnc_approved contains no approved genes");
  return { genes, diseases: [], associations: [], crosswalks: [], clingen: [] };
}

function parseClinVarCarrier(carrier: InheritedDiseaseEvidenceCarrier): ParsedCarrierParts {
  let document: unknown;
  try {
    document = JSON.parse(carrier.bytes.toString("utf8")) as unknown;
  } catch (error) {
    fail(`clinvar_gene_esearch contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = record(document, "clinvar_gene_esearch JSON");
  const result = record(root.esearchresult, "clinvar_gene_esearch.esearchresult");
  const countText = nonEmpty(result.count, "clinvar_gene_esearch count");
  const retmax = nonEmpty(result.retmax, "clinvar_gene_esearch retmax");
  if (retmax !== "0") fail("clinvar_gene_esearch retmax must be 0 for a count-only response");
  if (!/^[0-9]+$/.test(countText)) fail("clinvar_gene_esearch count must be a non-negative integer");
  const count = Number(countText);
  if (!Number.isSafeInteger(count)) fail("clinvar_gene_esearch count is outside the safe integer range");
  const query = nonEmpty(result.querytranslation, "clinvar_gene_esearch querytranslation");
  const semanticQuery = query.toLowerCase().replace(/["']/g, "").replace(/\s+/g, " ");
  const match = query.match(/(?:^|\s)([A-Za-z][A-Za-z0-9-]{0,30})\s*\[gene\]/i);
  if (match?.[1] === undefined) fail("clinvar_gene_esearch querytranslation does not identify a gene term");
  if (!/(?:^|[ (])pathogenic\s*\[\s*clinical significance\s*\]/i.test(semanticQuery)) {
    fail("clinvar_gene_esearch querytranslation lacks the pathogenic clinical-significance term");
  }
  if (!/likely\s+pathogenic\s*\[\s*clinical significance\s*\]/i.test(semanticQuery)) {
    fail("clinvar_gene_esearch querytranslation lacks the likely pathogenic clinical-significance term");
  }
  const symbol = geneSymbol(match[1]);
  const evidenceId = carrier.source;
  return {
    genes: [],
    diseases: [],
    associations: [],
    crosswalks: [{
      evidenceId,
      geneSymbol: symbol,
      pathogenicCount: count,
      sourceId: carrier.sourceId,
      sourceLocator: jsonLocator(carrier, "/esearchresult/count", countText),
    }],
    clingen: [],
  };
}

function canonicalClinGenHeader(header: readonly string[]): "fixture" | "official" | null {
  const normalized = header.map(normalizeHeader);
  const fixture = ["gene_symbol", "disease_id", "disease_name", "classification", "evidence_level"];
  if (fixture.every((name) => normalized.includes(name))) return "fixture";
  const official = ["gene symbol", "gene id (hgnc)", "disease label", "disease id (mondo)", "classification"];
  if (official.every((name) => normalized.includes(name))) return "official";
  return null;
}

function parseClinGenCarrier(carrier: InheritedDiseaseEvidenceCarrier): ParsedCarrierParts {
  const lines = carrier.bytes.toString("utf8").split(/\r\n|\n|\r/);
  let headerIndex = -1;
  let header: string[] = [];
  let shape: "fixture" | "official" | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line === "") continue;
    const candidate = parseDelimitedLine(line, ",", `clingen.gene-validity line ${index + 1}`);
    const detected = canonicalClinGenHeader(candidate);
    if (detected !== null) {
      headerIndex = index;
      header = candidate.map(normalizeHeader);
      shape = detected;
      break;
    }
  }
  if (headerIndex < 0 || shape === null) fail("clingen.gene-validity has an unknown header; expected the fixed fixture or official export layout");
  const indexOf = (name: string): number => {
    const index = header.indexOf(name);
    if (index < 0) fail(`clingen.gene-validity header is missing ${name}`);
    return index;
  };
  const geneIndex = indexOf(shape === "fixture" ? "gene_symbol" : "gene symbol");
  const diseaseNameIndex = indexOf(shape === "fixture" ? "disease_name" : "disease label");
  const diseaseIdIndex = shape === "fixture" ? indexOf("disease_id") : indexOf("disease id (mondo)");
  const classificationIndex = indexOf("classification");
  const claims: ClinGenClaim[] = [];
  for (let lineIndex = headerIndex + 1; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!;
    if (line.trim() === "") continue;
    const values = parseDelimitedLine(line, ",", `clingen.gene-validity row ${lineIndex + 1}`);
    if (values.every((value) => /^\+*$/.test(value.trim()))) continue;
    if (values.length !== header.length) fail(`clingen.gene-validity row ${lineIndex + 1} width does not match header`);
    const symbol = geneSymbol(nonEmpty(values[geneIndex]!, `clingen.gene-validity row ${lineIndex + 1} gene_symbol`));
    const diseaseName = nonEmpty(values[diseaseNameIndex]!, `clingen.gene-validity row ${lineIndex + 1} disease_name`);
    const rawDiseaseId = nonEmpty(values[diseaseIdIndex]!, `clingen.gene-validity row ${lineIndex + 1} disease_id`);
    if (!MONDO_ID.test(rawDiseaseId) && shape === "official") fail(`clingen.gene-validity row ${lineIndex + 1} disease ID must be MONDO`);
    const classification = nonEmpty(values[classificationIndex]!, `clingen.gene-validity row ${lineIndex + 1} classification`);
    claims.push({ geneSymbol: symbol, diseaseName, diseaseId: rawDiseaseId || null, classification });
  }
  if (claims.length === 0) fail("clingen.gene-validity contains no curation rows");
  return { genes: [], diseases: [], associations: [], crosswalks: [], clingen: claims };
}

function parseCarrier(carrier: InheritedDiseaseEvidenceCarrier): ParsedCarrierParts {
  switch (carrier.source) {
    case "orphanet_en_product1":
    case "orphanet_en_product6":
      return parseOrphanetCarrier(carrier);
    case "hgnc_approved":
      return parseHgncCarrier(carrier);
    case "clinvar_gene_esearch":
      return parseClinVarCarrier(carrier);
    case "clingen_gene_validity":
      return parseClinGenCarrier(carrier);
    default: {
      const neverSource: never = carrier.source;
      return neverSource;
    }
  }
}

function normalizedName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function mergeDiseaseClaims(claims: readonly DiseaseClaim[]): InheritedDiseaseDiseaseRecord[] {
  const byId = new Map<string, DiseaseClaim>();
  for (const claim of claims) {
    const existing = byId.get(claim.diseaseId);
    if (existing === undefined) {
      byId.set(claim.diseaseId, claim);
      continue;
    }
    if (normalizedName(existing.diseaseName) !== normalizedName(claim.diseaseName)) {
      fail(`disease ${claim.diseaseId} has conflicting names`);
    }
    if (existing.omimId !== null && claim.omimId !== null && existing.omimId !== claim.omimId) {
      fail(`disease ${claim.diseaseId} has conflicting OMIM identifiers`);
    }
    if (existing.omimId === null && claim.omimId !== null) {
      byId.set(claim.diseaseId, { ...existing, omimId: claim.omimId });
    }
  }
  return [...byId.values()]
    .sort((left, right) => left.diseaseId.localeCompare(right.diseaseId))
    .map((claim) => ({
      disease_id: claim.diseaseId,
      disease_namespace: "orphanet",
      disease_name: claim.diseaseName,
      omim_id: claim.omimId,
      source_id: claim.sourceId,
      source_locator: claim.sourceLocator,
    }));
}

function geneMap(genes: readonly InheritedDiseaseGeneRecord[]): Map<string, InheritedDiseaseGeneRecord> {
  const byId = new Map<string, InheritedDiseaseGeneRecord>();
  const bySymbol = new Map<string, string>();
  for (const gene of genes) {
    const existing = byId.get(gene.gene_id);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(gene)) {
      fail(`HGNC gene ${gene.gene_id} has conflicting approved records`);
    }
    const priorId = bySymbol.get(gene.gene_symbol.toUpperCase());
    if (priorId !== undefined && priorId !== gene.gene_id) {
      fail(`HGNC symbol ${gene.gene_symbol} maps to conflicting identifiers`);
    }
    byId.set(gene.gene_id, gene);
    bySymbol.set(gene.gene_symbol.toUpperCase(), gene.gene_id);
  }
  return byId;
}

function resolveGeneId(
  symbol: string,
  directHgnc: string | null,
  genesById: ReadonlyMap<string, InheritedDiseaseGeneRecord>,
): string {
  const bySymbol = [...genesById.values()].find((gene) => gene.gene_symbol.toUpperCase() === symbol.toUpperCase());
  if (directHgnc !== null && bySymbol !== undefined && bySymbol.gene_id !== directHgnc) {
    fail(`gene ${symbol} has conflicting HGNC identifiers between Orphanet and HGNC`);
  }
  const id = directHgnc ?? bySymbol?.gene_id;
  if (id === undefined || !genesById.has(id)) {
    fail(`gene ${symbol} is absent from the approved HGNC crosswalk`);
  }
  return id;
}

function mergeAssociations(
  associations: readonly AssociationClaim[],
  clingenClaims: readonly ClinGenClaim[],
  genesById: ReadonlyMap<string, InheritedDiseaseGeneRecord>,
  diseasesById: ReadonlyMap<string, InheritedDiseaseDiseaseRecord>,
): InheritedDiseaseGeneDiseaseRecord[] {
  const classificationByKey = new Map<string, string>();
  for (const claim of clingenClaims) {
    const geneId = resolveGeneId(claim.geneSymbol, null, genesById);
    const disease = [...diseasesById.values()].find((candidate) => normalizedName(candidate.disease_name) === normalizedName(claim.diseaseName));
    if (disease === undefined) continue;
    const key = `${geneId}\u0000${disease.disease_id}`;
    const existing = classificationByKey.get(key);
    if (existing !== undefined && existing !== claim.classification) {
      fail(`gene ${geneId} and disease ${disease.disease_id} have conflicting ClinGen classifications`);
    }
    classificationByKey.set(key, claim.classification);
  }
  const byKey = new Map<string, AssociationClaim & { geneId: string; classification: string }>();
  for (const claim of associations) {
    if (!diseasesById.has(claim.diseaseId)) fail(`association references missing disease ${claim.diseaseId}`);
    const geneId = resolveGeneId(claim.geneSymbol, claim.hgncId, genesById);
    const key = `${geneId}\u0000${claim.diseaseId}`;
    const classification = classificationByKey.get(key) ?? "not_reported";
    const existing = byKey.get(key);
    if (existing !== undefined) {
      if (existing.associationType !== claim.associationType) {
        fail(`gene ${geneId} and disease ${claim.diseaseId} have conflicting association types`);
      }
      if (existing.classification !== classification) {
        fail(`gene ${geneId} and disease ${claim.diseaseId} have conflicting classifications`);
      }
      continue;
    }
    byKey.set(key, { ...claim, geneId, classification });
  }
  if (byKey.size === 0) fail("Orphanet carriers contain no gene-disease associations");
  return [...byKey.values()]
    .sort((left, right) => `${left.geneId}\u0000${left.diseaseId}`.localeCompare(`${right.geneId}\u0000${right.diseaseId}`))
    .map((claim) => ({
      gene_disease_id: `gene_disease_${stableDigest([claim.geneId, claim.diseaseId, claim.associationType])}`,
      gene_id: claim.geneId,
      gene_namespace: "hgnc",
      disease_id: claim.diseaseId,
      disease_namespace: "orphanet",
      association_type: claim.associationType,
      classification: claim.classification,
      source_id: claim.sourceId,
      source_locator: claim.sourceLocator,
    }));
}

function mergeCrosswalks(
  crosswalks: readonly ParsedCarrierParts["crosswalks"][number][],
  genesById: ReadonlyMap<string, InheritedDiseaseGeneRecord>,
): InheritedDiseaseEvidenceCrosswalkRecord[] {
  const byEvidenceId = new Map<string, ParsedCarrierParts["crosswalks"][number]>();
  for (const crosswalk of crosswalks) {
    if (byEvidenceId.has(crosswalk.evidenceId)) fail(`duplicate evidence ID ${crosswalk.evidenceId}`);
    byEvidenceId.set(crosswalk.evidenceId, crosswalk);
  }
  return [...byEvidenceId.values()]
    .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId))
    .map((crosswalk) => ({
      crosswalk_id: `crosswalk_${stableDigest([crosswalk.evidenceId, crosswalk.geneSymbol])}`,
      evidence_id: crosswalk.evidenceId,
      gene_id: resolveGeneId(crosswalk.geneSymbol, null, genesById),
      gene_namespace: "hgnc",
      evidence_source: "clinvar_gene_esearch",
      pathogenic_count: crosswalk.pathogenicCount,
      source_id: crosswalk.sourceId,
      source_locator: crosswalk.sourceLocator,
    }));
}

function assertRequiredSources(carriers: readonly InheritedDiseaseEvidenceCarrier[]): void {
  const present = new Set(carriers.map((carrier) => carrier.source));
  const missing = REQUIRED_SOURCES.filter((source) => !present.has(source));
  if (missing.length > 0) fail(`required source carrier(s) missing: ${missing.join(", ")}`);
}

function validateCarrierShape(carrier: InheritedDiseaseEvidenceCarrier): void {
  if (!/^asset_[0-9a-f]{64}$/.test(carrier.assetId)) fail(`${carrier.source} assetId must be content addressed`);
  if (carrier.logicalFile.trim() === "") fail(`${carrier.source} logicalFile is required`);
  if (carrier.retrievedAt.trim() === "" || Number.isNaN(Date.parse(carrier.retrievedAt))) fail(`${carrier.source} retrievedAt must be an ISO datetime`);
  if (!Buffer.isBuffer(carrier.bytes)) fail(`${carrier.source} bytes must be a Buffer`);
}

/** Parse the fixed Orphanet/HGNC/ClinVar/ClinGen carrier set into four tables. */
export function parseInheritedDiseaseEvidenceCarriers(
  carriers: readonly InheritedDiseaseEvidenceCarrier[],
): InheritedDiseaseEvidenceRows {
  if (carriers.length === 0) fail("at least one source carrier is required");
  for (const carrier of carriers) validateCarrierShape(carrier);
  const parts = carriers.map(parseCarrier);
  const genes = parts.flatMap((part) => part.genes);
  const diseases = parts.flatMap((part) => part.diseases);
  const associations = parts.flatMap((part) => part.associations);
  const crosswalks = parts.flatMap((part) => part.crosswalks);
  const clingen = parts.flatMap((part) => part.clingen);
  const genesById = geneMap(genes);
  const diseaseRecords = mergeDiseaseClaims(diseases);
  const diseasesById = new Map(diseaseRecords.map((disease) => [disease.disease_id, disease]));
  // Resolve gene references before the required-source check so an incomplete
  // crosswalk cannot be hidden behind a generic missing-carrier error.
  const geneDiseaseRecords = mergeAssociations(associations, clingen, genesById, diseasesById);
  const crosswalkRecords = mergeCrosswalks(crosswalks, genesById);
  assertRequiredSources(carriers);
  const usedGeneIds = new Set([
    ...geneDiseaseRecords.map((row) => row.gene_id),
    ...crosswalkRecords.map((row) => row.gene_id),
  ]);
  const geneRecords = [...genesById.values()]
    .filter((gene) => usedGeneIds.has(gene.gene_id))
    .sort((left, right) => left.gene_id.localeCompare(right.gene_id));
  if (geneRecords.length === 0) fail("no approved HGNC gene is referenced by the evidence carriers");
  const rows = {
    gene_records: geneRecords,
    disease_records: diseaseRecords,
    gene_disease_records: geneDiseaseRecords,
    gene_evidence_crosswalk: crosswalkRecords,
  };
  assertInheritedDiseaseEvidenceRows(rows);
  return rows;
}

export const INHERITED_DISEASE_EVIDENCE_PROVIDER_IDS = Object.freeze({
  orphanetProduct1: "orphanet.en_product1.v1",
  orphanetProduct6: "orphanet.en_product6.v1",
  hgncApproved: "hgnc.approved.v1",
  clinvarGeneEsearch: "clinvar.gene-esearch.v1",
  clingenGeneValidity: "clingen.gene-validity.v1",
});

export const inheritedDiseaseEvidenceCarrierTransform = Object.freeze({
  familyId: "inherited_disease_gene_evidence",
  transform: parseInheritedDiseaseEvidenceCarriers,
});