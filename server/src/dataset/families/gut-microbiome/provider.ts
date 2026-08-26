import type { SourceLocatorV2 } from "@biomed/contracts";
import type {
  GutMicrobiomeDifferentialAbundanceInput,
  GutMicrobiomeReferencePrevalenceInput,
  GutMicrobiomeSourceInput,
  GutMicrobiomeStudyInput,
  GutMicrobiomeTaxonInput,
} from "./types.js";
import { assertGutMicrobiomeRows } from "./validation.js";

const ASSET_ID = /^asset_[0-9a-f]{64}$/;

export interface GutMicrobiomeCarrierRequest {
  assetId: string;
  logicalFile: string;
  retrievedAt: string;
  mediaType: string;
  bytes: Uint8Array;
  studyId: string;
}

export interface GutMicrobiomeCarrierRows {
  studies: readonly GutMicrobiomeStudyInput[];
  taxa: readonly GutMicrobiomeTaxonInput[];
  differentialAbundances: readonly GutMicrobiomeDifferentialAbundanceInput[];
  referencePrevalences: readonly GutMicrobiomeReferencePrevalenceInput[];
  sources: readonly GutMicrobiomeSourceInput[];
}

function fail(message: string): never {
  throw new TypeError(`gut microbiome provider rejected: ${message}`);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} is required`);
  return value.trim();
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function locator(request: GutMicrobiomeCarrierRequest, pointer: string, raw: string, xml = false): SourceLocatorV2 {
  return xml
    ? {
        locator_version: "2.0",
        locator_type: "xml_cell",
        asset_id: request.assetId,
        logical_file: request.logicalFile,
        raw_value: raw,
        xml_path: pointer,
        table_id: "differential_abundance",
        row_index: 1,
        column_index: 1,
      }
    : {
        locator_version: "2.0",
        locator_type: "json_pointer",
        asset_id: request.assetId,
        logical_file: request.logicalFile,
        raw_value: raw,
        json_pointer: pointer || "/",
      };
}

function source(request: GutMicrobiomeCarrierRequest, database: GutMicrobiomeSourceInput["source_database"], carrierType: string): GutMicrobiomeSourceInput {
  const sourceId = `source_${database}_${request.studyId}`;
  return {
    source_id: sourceId,
    source_database: database,
    source_asset_id: request.assetId,
    source_locator: locator(request, "/", request.studyId),
    retrieved_at: request.retrievedAt,
    carrier_type: carrierType,
  };
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${label} must be a finite number`);
  return value;
}

function integerValue(value: unknown, label: string): number {
  const parsed = numberValue(value, label);
  if (!Number.isSafeInteger(parsed)) fail(`${label} must be an integer`);
  return parsed;
}

function parseStudyJson(request: GutMicrobiomeCarrierRequest, root: Record<string, unknown>): GutMicrobiomeCarrierRows {
  const item = record(root.study, "study");
  const sourceRow = source(request, "mgnify", "mgnify_study_json");
  const study: GutMicrobiomeStudyInput = {
    study_id: text(item.study_id, "study.study_id"),
    study_accession: text(item.study_accession, "study.study_accession"),
    study_title: text(item.study_title, "study.study_title"),
    disease_id: text(item.disease_id, "study.disease_id"),
    disease_name: text(item.disease_name, "study.disease_name"),
    host_taxon_id: text(item.host_taxon_id, "study.host_taxon_id"),
    sample_count: integerValue(item.sample_count, "study.sample_count"),
    source_id: sourceRow.source_id,
    source_asset_id: request.assetId,
    source_locator: locator(request, "/study", JSON.stringify(item)),
  };
  return { studies: [study], taxa: [], differentialAbundances: [], referencePrevalences: [], sources: [sourceRow] };
}

function parseTaxonomyJson(request: GutMicrobiomeCarrierRequest, root: Record<string, unknown>): GutMicrobiomeCarrierRows {
  const sourceRow = source(request, "mgnify", "mgnify_taxonomy_json");
  const rows = array(root.records, "records");
  const taxa = rows.map((value, index): GutMicrobiomeTaxonInput => {
    const item = record(value, `records[${index}]`);
    return {
      study_id: request.studyId,
      sample_id: text(item.sample_id, `records[${index}].sample_id`),
      taxon_path: text(item.taxon_path, `records[${index}].taxon_path`),
      taxon_id: text(item.taxon_id, `records[${index}].taxon_id`),
      abundance: integerValue(item.abundance, `records[${index}].abundance`),
      source_id: sourceRow.source_id,
      source_asset_id: request.assetId,
      source_locator: locator(request, `/records/${index}`, JSON.stringify(item)),
    };
  });
  return { studies: [], taxa, differentialAbundances: [], referencePrevalences: [], sources: [sourceRow] };
}

function parseNcbiJson(request: GutMicrobiomeCarrierRequest, root: Record<string, unknown>): GutMicrobiomeCarrierRows {
  const result = record(root.esearchresult, "esearchresult");
  const idList = array(result.idlist, "esearchresult.idlist");
  if (idList.length !== 1 || typeof idList[0] !== "string" || !/^[1-9][0-9]{0,11}$/.test(idList[0])) fail("NCBI ESearch must return exactly one numeric taxid");
  const sourceRow = source(request, "ncbi_taxonomy", "ncbi_taxonomy_esearch_json");
  return { studies: [], taxa: [{
    study_id: request.studyId,
    sample_id: "taxonomy_reference",
    taxon_path: text(result.querytranslation, "esearchresult.querytranslation"),
    taxon_id: idList[0],
    abundance: 0,
    source_id: sourceRow.source_id,
    source_asset_id: request.assetId,
    source_locator: locator(request, "/esearchresult/idlist/0", idList[0]),
  }], differentialAbundances: [], referencePrevalences: [], sources: [sourceRow] };
}

function parseNcbiXml(request: GutMicrobiomeCarrierRequest, content: string): GutMicrobiomeCarrierRows {
  const taxId = /<TaxId>([1-9][0-9]{0,11})<\/TaxId>/.exec(content)?.[1];
  const scientificName = /<ScientificName>([^<]+)<\/ScientificName>/.exec(content)?.[1];
  const rank = /<Rank>([^<]+)<\/Rank>/.exec(content)?.[1];
  if (taxId === undefined || scientificName === undefined || rank === undefined) fail("NCBI EFetch XML must contain TaxId, ScientificName, and Rank");
  const sourceRow = source(request, "ncbi_taxonomy", "ncbi_taxonomy_efetch_xml");
  return { studies: [], taxa: [{
    study_id: request.studyId,
    sample_id: "taxonomy_reference",
    taxon_path: `${rank}:${scientificName}`,
    taxon_id: taxId,
    abundance: 0,
    source_id: sourceRow.source_id,
    source_asset_id: request.assetId,
    source_locator: locator(request, "/TaxaSet/Taxon/TaxId", taxId, true),
  }], differentialAbundances: [], referencePrevalences: [], sources: [sourceRow] };
}

function parseGmrepoJson(request: GutMicrobiomeCarrierRequest, root: Record<string, unknown>): GutMicrobiomeCarrierRows {
  const sourceRow = source(request, "gmrepo", "gmrepo_associated_species_json");
  const taxa = array(root.associated_species, "associated_species").map((value, index): GutMicrobiomeReferencePrevalenceInput => {
    const item = record(value, `associated_species[${index}]`);
    const samples = integerValue(item.samples, `associated_species[${index}].samples`);
    const total = integerValue(root.nr_valid_samples, "nr_valid_samples");
    if (total < 1 || samples < 0 || samples > total) fail("GMRepo sample counts are inconsistent");
    return {
      study_id: request.studyId,
      taxon_id: String(integerValue(item.ncbi_taxon_id, `associated_species[${index}].ncbi_taxon_id`)),
      reference_group: "gmrepo_reference",
      prevalence: samples / total,
      reference_sample_count: total,
      source_id: sourceRow.source_id,
      source_asset_id: request.assetId,
      source_locator: locator(request, `/associated_species/${index}`, JSON.stringify(item)),
    };
  });
  return { studies: [], taxa: [], differentialAbundances: [], referencePrevalences: taxa, sources: [sourceRow] };
}

function parseDifferentialXlsx(request: GutMicrobiomeCarrierRequest, content: string): GutMicrobiomeCarrierRows {
  const sourceRow = source(request, "mgnify", "differential_abundance_xlsx");
  const lines = content.replaceAll("\r\n", "\n").split("\n").filter((line) => line.length > 0);
  if (lines.length < 2) fail("differential abundance XLSX fixture requires a fixed exported text representation");
  const header = lines[0]!.split("\t");
  const expected = ["study_id", "taxon_id", "comparison_id", "comparison_label", "effect_size", "p_value", "adjusted_p_value", "effect_direction"];
  if (JSON.stringify(header) !== JSON.stringify(expected)) fail("differential abundance table header is not the fixed schema");
  const differentialAbundances = lines.slice(1).map((line, index) => {
    const values = line.split("\t");
    if (values.length !== expected.length) fail(`differential abundance row ${index + 2} has the wrong width`);
    return {
      study_id: text(values[0], "study_id"),
      taxon_id: text(values[1], "taxon_id"),
      comparison_id: text(values[2], "comparison_id"),
      comparison_label: text(values[3], "comparison_label"),
      effect_size: numberValue(Number(values[4]), "effect_size"),
      p_value: numberValue(Number(values[5]), "p_value"),
      adjusted_p_value: values[6] === "" ? null : numberValue(Number(values[6]), "adjusted_p_value"),
      effect_direction: text(values[7], "effect_direction"),
      source_id: sourceRow.source_id,
      source_asset_id: request.assetId,
      source_locator: locator(request, `/${index + 2}`, line, true),
    } satisfies GutMicrobiomeDifferentialAbundanceInput;
  });
  return { studies: [], taxa: [], differentialAbundances, referencePrevalences: [], sources: [sourceRow] };
}

export function parseGutMicrobiomeCarrier(request: GutMicrobiomeCarrierRequest): GutMicrobiomeCarrierRows {
  if (!ASSET_ID.test(request.assetId)) fail("assetId must be content addressed");
  if (request.logicalFile.trim() === "") fail("logicalFile is required");
  if (Number.isNaN(Date.parse(request.retrievedAt))) fail("retrievedAt must be an ISO datetime");
  if (request.mediaType.includes("vnd.ms-excel") || request.logicalFile.toLowerCase().endsWith(".xls") || request.logicalFile.toLowerCase().endsWith(".docx")) fail("legacy XLS/DOCX carriers are not promoted");
  const content = new TextDecoder("utf-8", { fatal: true }).decode(request.bytes);
  if (request.mediaType.includes("spreadsheetml") || request.logicalFile.toLowerCase().endsWith(".xlsx")) return parseDifferentialXlsx(request, content);
  if (request.mediaType.includes("xml") || content.trimStart().startsWith("<?xml")) return parseNcbiXml(request, content);
  let root: unknown;
  try { root = JSON.parse(content) as unknown; } catch (error) { fail(`carrier is not strict JSON: ${error instanceof Error ? error.message : String(error)}`); }
  const document = record(root, "carrier");
  if (document.esearchresult !== undefined) return parseNcbiJson(request, document);
  if (document.associated_species !== undefined) return parseGmrepoJson(request, document);
  if (document.study !== undefined) return parseStudyJson(request, document);
  if (document.records !== undefined) return parseTaxonomyJson(request, document);
  fail("carrier does not match a promoted MGnify, NCBI, or GMRepo fixed shape");
}

export function assertGutMicrobiomeCarrierRows(rows: GutMicrobiomeCarrierRows): void {
  assertGutMicrobiomeRows({
    studies: rows.studies,
    taxa: rows.taxa,
    differentialAbundances: rows.differentialAbundances,
    referencePrevalences: rows.referencePrevalences,
    sources: rows.sources,
  });
}
