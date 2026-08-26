import type { SourceLocatorV2 } from "@biomed/contracts";

import { parseSourceLocator } from "../../contracts/index.js";
import {
  inheritedDiseaseEvidenceTables,
  INHERITED_DISEASE_CROSSWALK_TABLE_ID,
  INHERITED_DISEASE_DISEASE_TABLE_ID,
  INHERITED_DISEASE_GENE_DISEASE_TABLE_ID,
  INHERITED_DISEASE_GENE_TABLE_ID,
} from "./schema.js";
import type {
  InheritedDiseaseEvidenceRows,
  InheritedDiseaseEvidenceSource,
  InheritedDiseaseEvidenceCrosswalkRecord,
  InheritedDiseaseDiseaseRecord,
  InheritedDiseaseGeneDiseaseRecord,
  InheritedDiseaseGeneRecord,
} from "./types.js";

const ASSET_ID = /^asset_[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const SOURCES = new Set<InheritedDiseaseEvidenceSource>([
  "orphanet_en_product1",
  "orphanet_en_product6",
  "hgnc_approved",
  "clinvar_gene_esearch",
  "clingen_gene_validity",
]);

export type InheritedDiseaseEvidenceTableId =
  | typeof INHERITED_DISEASE_GENE_TABLE_ID
  | typeof INHERITED_DISEASE_DISEASE_TABLE_ID
  | typeof INHERITED_DISEASE_GENE_DISEASE_TABLE_ID
  | typeof INHERITED_DISEASE_CROSSWALK_TABLE_ID;

function fail(message: string): never {
  throw new TypeError(`inherited disease evidence rejected: ${message}`);
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${name} is required`);
  return value;
}

function safeId(value: unknown, name: string): string {
  const result = text(value, name);
  if (!SAFE_ID.test(result) || result.includes("..")) fail(`${name} is not a safe identifier`);
  return result;
}

function locator(value: unknown, name: string): SourceLocatorV2 {
  let parsed: ReturnType<typeof parseSourceLocator>;
  try {
    parsed = parseSourceLocator(value);
  } catch (error) {
    fail(`${name} is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!("locator_version" in parsed) || parsed.locator_version !== "2.0") {
    fail(`${name} must use SourceLocator 2.0`);
  }
  if (!ASSET_ID.test(parsed.asset_id)) fail(`${name}.asset_id must be content addressed`);
  return parsed;
}

function sourceFields(
  value: {
    source_id: string;
    source_locator: SourceLocatorV2;
  },
  name: string,
): void {
  safeId(value.source_id, `${name}.source_id`);
  const parsed = locator(value.source_locator, `${name}.source_locator`);
  if (parsed.logical_file.trim() === "") fail(`${name}.source_locator.logical_file is required`);
}

function unique(values: readonly string[], name: string): void {
  if (new Set(values).size !== values.length) fail(`${name} contains duplicate identifiers`);
}

function assertGene(value: InheritedDiseaseGeneRecord): void {
  safeId(value.gene_id, "gene.gene_id");
  if (value.gene_namespace !== "hgnc") fail("gene.gene_namespace must be hgnc");
  text(value.gene_symbol, "gene.gene_symbol");
  text(value.gene_name, "gene.gene_name");
  text(value.status, "gene.status");
  sourceFields(value, "gene");
}

function assertDisease(value: InheritedDiseaseDiseaseRecord): void {
  safeId(value.disease_id, "disease.disease_id");
  if (value.disease_namespace !== "orphanet") fail("disease.disease_namespace must be orphanet");
  text(value.disease_name, "disease.disease_name");
  if (value.omim_id !== null) safeId(value.omim_id, "disease.omim_id");
  sourceFields(value, "disease");
}

function assertGeneDisease(value: InheritedDiseaseGeneDiseaseRecord): void {
  safeId(value.gene_disease_id, "gene_disease.gene_disease_id");
  safeId(value.gene_id, "gene_disease.gene_id");
  if (value.gene_namespace !== "hgnc") fail("gene_disease.gene_namespace must be hgnc");
  safeId(value.disease_id, "gene_disease.disease_id");
  if (value.disease_namespace !== "orphanet") fail("gene_disease.disease_namespace must be orphanet");
  text(value.association_type, "gene_disease.association_type");
  text(value.classification, "gene_disease.classification");
  sourceFields(value, "gene_disease");
}

function assertCrosswalk(value: InheritedDiseaseEvidenceCrosswalkRecord): void {
  safeId(value.crosswalk_id, "crosswalk.crosswalk_id");
  safeId(value.evidence_id, "crosswalk.evidence_id");
  safeId(value.gene_id, "crosswalk.gene_id");
  if (value.gene_namespace !== "hgnc") fail("crosswalk.gene_namespace must be hgnc");
  if (!SOURCES.has(value.evidence_source as InheritedDiseaseEvidenceSource)) {
    fail(`crosswalk.evidence_source '${value.evidence_source}' is not a fixed provider source`);
  }
  if (!Number.isSafeInteger(value.pathogenic_count) || value.pathogenic_count < 0) {
    fail("crosswalk.pathogenic_count must be a non-negative safe integer");
  }
  sourceFields(value, "crosswalk");
}

/** Family-owned row invariants run before the generic B3 relation validator. */
export function assertInheritedDiseaseEvidenceRows(rows: InheritedDiseaseEvidenceRows): void {
  if (rows.gene_records.length === 0) fail("gene_records must not be empty");
  if (rows.disease_records.length === 0) fail("disease_records must not be empty");
  if (rows.gene_disease_records.length === 0) fail("gene_disease_records must not be empty");
  if (rows.gene_evidence_crosswalk.length === 0) fail("gene_evidence_crosswalk must not be empty");

  rows.gene_records.forEach(assertGene);
  rows.disease_records.forEach(assertDisease);
  rows.gene_disease_records.forEach(assertGeneDisease);
  rows.gene_evidence_crosswalk.forEach(assertCrosswalk);

  unique(rows.gene_records.map((row) => `${row.gene_id}\u0000${row.gene_namespace}`), "gene_records");
  unique(rows.disease_records.map((row) => `${row.disease_id}\u0000${row.disease_namespace}`), "disease_records");
  unique(rows.gene_disease_records.map((row) => row.gene_disease_id), "gene_disease_records");
  unique(rows.gene_evidence_crosswalk.map((row) => row.crosswalk_id), "gene_evidence_crosswalk");

  const genes = new Set(rows.gene_records.map((row) => `${row.gene_id}\u0000${row.gene_namespace}`));
  const diseases = new Set(rows.disease_records.map((row) => `${row.disease_id}\u0000${row.disease_namespace}`));
  for (const row of rows.gene_disease_records) {
    if (!genes.has(`${row.gene_id}\u0000${row.gene_namespace}`)) {
      fail(`gene_disease ${row.gene_disease_id} references missing gene ${row.gene_id}`);
    }
    if (!diseases.has(`${row.disease_id}\u0000${row.disease_namespace}`)) {
      fail(`gene_disease ${row.gene_disease_id} references missing disease ${row.disease_id}`);
    }
  }
  for (const row of rows.gene_evidence_crosswalk) {
    if (!genes.has(`${row.gene_id}\u0000${row.gene_namespace}`)) {
      fail(`crosswalk ${row.crosswalk_id} references missing gene ${row.gene_id}`);
    }
  }
}

export function inheritedDiseaseEvidenceTableIds(): readonly InheritedDiseaseEvidenceTableId[] {
  return inheritedDiseaseEvidenceTables.map((entry) => entry.tableId);
}