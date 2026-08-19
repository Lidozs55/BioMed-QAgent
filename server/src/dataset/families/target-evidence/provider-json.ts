import { createHash } from "node:crypto";
import type { JsonValue, SourceLocatorV2 } from "@biomed/contracts";
import { assertTargetEvidenceRows, type TargetEvidenceRows } from "./validation.js";
import type { TargetEvidenceSourceDatabase } from "./schemas.js";

export interface TargetEvidenceJsonCarrier {
  assetId: string;
  sourceId: string;
  sourceDatabase: TargetEvidenceSourceDatabase;
  logicalFile: string;
  retrievedAt: string;
  payload: unknown;
}

export const TARGET_EVIDENCE_PROVIDER_IDS = Object.freeze({
  uniprot: "target.evidence.uniprot.v1",
  ncbi_clinvar: "target.evidence.clinvar.v1",
  clinicaltrials_gov: "target.evidence.trials.v1",
});

type MutableRows = {
  targets: Record<string, unknown>[];
  evidence: TargetEvidenceRows["evidence"][number][];
  sources: TargetEvidenceRows["sources"][number][];
  supporting: TargetEvidenceRows["supporting"][number][];
};

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`target evidence provider rejected: ${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`target evidence provider rejected: ${path} must be a non-empty array`);
  }
  return value;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`target evidence provider rejected: ${path} must be a non-empty string`);
  }
  return value.trim();
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 24)}`;
}

function locator(carrier: TargetEvidenceJsonCarrier, pointer: string, rawValue: string): SourceLocatorV2 {
  return {
    locator_version: "2.0",
    locator_type: "json_pointer",
    asset_id: carrier.assetId,
    logical_file: carrier.logicalFile,
    raw_value: rawValue,
    json_pointer: pointer,
  };
}

function jsonValue(value: unknown, path: string): JsonValue {
  try {
    const normalized = JSON.parse(JSON.stringify(value)) as unknown;
    if (normalized === undefined) throw new Error("undefined");
    return normalized as JsonValue;
  } catch {
    throw new TypeError(`target evidence provider rejected: ${path} is not JSON-compatible`);
  }
}

function addSource(rows: MutableRows, carrier: TargetEvidenceJsonCarrier, pointer: string, rawValue: string): void {
  rows.sources.push({
    source_id: carrier.sourceId,
    source_database: carrier.sourceDatabase,
    source_asset_id: carrier.assetId,
    source_locator: locator(carrier, pointer, rawValue),
    retrieved_at: carrier.retrievedAt,
    carrier_type: "api_record",
  });
}

function parseUniProt(carrier: TargetEvidenceJsonCarrier, rows: MutableRows): void {
  const root = record(carrier.payload, "UniProt response");
  const results = array(root.results, "UniProt /results");
  results.forEach((value, index) => {
    const entry = record(value, `UniProt /results/${index}`);
    const accession = text(entry.primaryAccession, `UniProt /results/${index}/primaryAccession`);
    const genes = array(entry.genes, `UniProt /results/${index}/genes`);
    const geneName = text(record(record(genes[0], "UniProt gene").geneName, "UniProt geneName").value, "UniProt gene symbol");
    const description = record(record(record(entry.proteinDescription, "UniProt proteinDescription").recommendedName, "UniProt recommendedName").fullName, "UniProt fullName");
    const proteinName = text(description.value, "UniProt protein name");
    const organism = record(entry.organism, "UniProt organism");
    const organismName = text(organism.scientificName, "UniProt organism scientificName");
    const evidenceId = stableId("evidence", carrier.assetId, accession);
    rows.targets.push({ entity_id: accession, entity_namespace: "uniprot", entity_type: "protein", preferred_name: geneName, organism: organismName, source_id: carrier.sourceId });
    rows.evidence.push({
      evidence_id: evidenceId,
      target_id: accession,
      target_namespace: "uniprot",
      evidence_type: "protein_annotation",
      assertion: proteinName,
      evidence_value: { gene_symbol: geneName, protein_name: proteinName, taxon_id: organism.taxonId ?? null },
      source_id: carrier.sourceId,
      source_locator: locator(carrier, `/results/${index}/primaryAccession`, accession),
    });
    rows.supporting.push({ supporting_id: stableId("supporting", evidenceId, "uniprot"), evidence_id: evidenceId, supporting_type: "uniprot_identifiers", supporting_value: { uniprot_accession: accession, gene_symbol: geneName }, source_id: carrier.sourceId });
  });
  addSource(rows, carrier, "/results/0/primaryAccession", text(record(results[0], "UniProt first result").primaryAccession, "UniProt accession"));
}

function parseClinVar(carrier: TargetEvidenceJsonCarrier, rows: MutableRows): void {
  const root = record(carrier.payload, "ClinVar response");
  const result = record(root.result, "ClinVar /result");
  const uids = array(result.uids, "ClinVar /result/uids").map((uid, index) => text(uid, `ClinVar uid ${index}`));
  uids.forEach((uid) => {
    const entry = record(result[uid], `ClinVar /result/${uid}`);
    const accession = text(entry.accession, `ClinVar /result/${uid}/accession`);
    const title = text(entry.title, `ClinVar /result/${uid}/title`);
    const significance = text(record(entry.clinical_significance, "ClinVar clinical_significance").description, "ClinVar significance");
    const genes = array(entry.genes, "ClinVar genes");
    const gene = record(genes[0], "ClinVar first gene");
    const geneSymbol = text(gene.symbol, "ClinVar gene symbol");
    const evidenceId = stableId("evidence", carrier.assetId, accession);
    rows.targets.push({ entity_id: accession, entity_namespace: "clinvar", entity_type: "variant", preferred_name: title, organism: "Homo sapiens", source_id: carrier.sourceId });
    rows.evidence.push({ evidence_id: evidenceId, target_id: accession, target_namespace: "clinvar", evidence_type: "clinical_significance", assertion: significance, evidence_value: { clinvar_uid: uid, gene_id: optionalText(gene.geneid), gene_symbol: geneSymbol }, source_id: carrier.sourceId, source_locator: locator(carrier, `/result/${uid}/clinical_significance/description`, significance) });
    rows.supporting.push({ supporting_id: stableId("supporting", evidenceId, "clinvar"), evidence_id: evidenceId, supporting_type: "variant_gene_link", supporting_value: { variant_id: accession, gene_id: optionalText(gene.geneid), gene_symbol: geneSymbol }, source_id: carrier.sourceId });
  });
  addSource(rows, carrier, "/result/uids/0", uids[0]!);
}

function parseClinicalTrials(carrier: TargetEvidenceJsonCarrier, rows: MutableRows): void {
  const root = record(carrier.payload, "ClinicalTrials.gov response");
  const studies = array(root.studies, "ClinicalTrials.gov /studies");
  studies.forEach((value, index) => {
    const study = record(value, `ClinicalTrials.gov /studies/${index}`);
    const protocol = record(study.protocolSection, "ClinicalTrials.gov protocolSection");
    const identification = record(protocol.identificationModule, "ClinicalTrials.gov identificationModule");
    const status = record(protocol.statusModule, "ClinicalTrials.gov statusModule");
    const nctId = text(identification.nctId, "ClinicalTrials.gov nctId");
    const title = text(identification.briefTitle, "ClinicalTrials.gov briefTitle");
    const overallStatus = text(status.overallStatus, "ClinicalTrials.gov overallStatus");
    const evidenceId = stableId("evidence", carrier.assetId, nctId);
    rows.targets.push({ entity_id: nctId, entity_namespace: "clinicaltrials.gov", entity_type: "trial", preferred_name: title, organism: null, source_id: carrier.sourceId });
    rows.evidence.push({ evidence_id: evidenceId, target_id: nctId, target_namespace: "clinicaltrials.gov", evidence_type: "trial_status", assertion: overallStatus, evidence_value: { nct_id: nctId, phases: jsonValue(record(protocol.designModule, "ClinicalTrials.gov designModule").phases ?? [], "ClinicalTrials.gov phases") }, source_id: carrier.sourceId, source_locator: locator(carrier, `/studies/${index}/protocolSection/statusModule/overallStatus`, overallStatus) });
    rows.supporting.push({ supporting_id: stableId("supporting", evidenceId, "trial"), evidence_id: evidenceId, supporting_type: "trial_record", supporting_value: { nct_id: nctId, brief_title: title, conditions: jsonValue(record(protocol.conditionsModule, "ClinicalTrials.gov conditionsModule").conditions ?? [], "ClinicalTrials.gov conditions") }, source_id: carrier.sourceId });
  });
  const firstProtocol = record(record(studies[0], "ClinicalTrials.gov first study").protocolSection, "ClinicalTrials.gov first protocol");
  const firstId = text(record(firstProtocol.identificationModule, "ClinicalTrials.gov first identification").nctId, "ClinicalTrials.gov first nctId");
  addSource(rows, carrier, "/studies/0/protocolSection/identificationModule/nctId", firstId);
}

export function expandTargetEvidenceJsonCarriers(carriers: readonly TargetEvidenceJsonCarrier[]): TargetEvidenceRows {
  if (carriers.length === 0) throw new TypeError("target evidence provider rejected: at least one carrier is required");
  const rows: MutableRows = { targets: [], evidence: [], sources: [], supporting: [] };
  for (const carrier of carriers) {
    if (carrier.sourceDatabase === "uniprot") parseUniProt(carrier, rows);
    else if (carrier.sourceDatabase === "ncbi_clinvar") parseClinVar(carrier, rows);
    else if (carrier.sourceDatabase === "clinicaltrials_gov") parseClinicalTrials(carrier, rows);
    else throw new TypeError(`target evidence provider rejected: unsupported source database '${carrier.sourceDatabase}'`);
  }
  assertTargetEvidenceRows(rows);
  return rows;
}
