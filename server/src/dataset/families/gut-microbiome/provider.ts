import * as XLSX from "xlsx";
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
  adapterId?: string;
  sourceId?: string;
  diseaseId?: string;
  diseaseName?: string;
  hostTaxonId?: string;
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

function locator(
  request: GutMicrobiomeCarrierRequest,
  pointer: string,
  raw: string,
  xml = false,
  tableId = "differential_abundance_records",
  rowIndex = 1,
  columnIndex = 1,
): SourceLocatorV2 {
  return xml
    ? {
        locator_version: "2.0",
        locator_type: "xml_cell",
        asset_id: request.assetId,
        logical_file: request.logicalFile,
        raw_value: raw,
        xml_path: pointer,
        table_id: tableId,
        row_index: rowIndex,
        column_index: columnIndex,
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
  const assetSuffix = request.assetId.slice("asset_".length, "asset_".length + 12);
  const sourceId = request.sourceId ?? `source_${database}_${request.studyId}_${assetSuffix}`;
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
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^[+-]?\d+$/.test(value.trim())
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(parsed) || !Number.isSafeInteger(parsed)) fail(`${label} must be an integer`);
  return parsed;
}

function parseStudyJson(request: GutMicrobiomeCarrierRequest, root: Record<string, unknown>): GutMicrobiomeCarrierRows {
  const sourceRow = source(request, "mgnify", "mgnify_study_json");
  const item = root.study === undefined
    ? (() => {
        const data = record(root.data, "data");
        const attributes = record(data.attributes, "data.attributes");
        return {
          study_id: data.id ?? attributes.accession,
          study_accession: attributes.accession ?? data.id,
          study_title: attributes["study-name"],
          disease_id: request.diseaseId,
          disease_name: request.diseaseName,
          host_taxon_id: request.hostTaxonId,
          sample_count: attributes["samples-count"],
        };
      })()
    : record(root.study, "study");
  const studyId = text(item.study_id, "study.study_id");
  if (studyId !== request.studyId) fail("study.study_id does not match the requested study");
  const study: GutMicrobiomeStudyInput = {
    study_id: studyId,
    study_accession: text(item.study_accession, "study.study_accession"),
    study_title: text(item.study_title, "study.study_title"),
    disease_id: text(item.disease_id, "study.disease_id"),
    disease_name: text(item.disease_name, "study.disease_name"),
    host_taxon_id: text(item.host_taxon_id, "study.host_taxon_id"),
    sample_count: integerValue(item.sample_count, "study.sample_count"),
    source_id: sourceRow.source_id,
    source_asset_id: request.assetId,
    source_locator: locator(request, root.study === undefined ? "/data" : "/study", JSON.stringify(item)),
  };
  return { studies: [study], taxa: [], differentialAbundances: [], referencePrevalences: [], sources: [sourceRow] };
}

function safeTaxonId(value: unknown, label: string): string {
  if ((typeof value !== "string" && typeof value !== "number") || String(value).trim() === "") fail(`${label} is required`);
  const parsed = String(value).trim();
  if (!/^[1-9][0-9]{0,11}$/.test(parsed)) fail(`${label} must be a numeric NCBI taxon ID`);
  return parsed;
}

function parseTaxonomyTsv(request: GutMicrobiomeCarrierRequest, content: string): GutMicrobiomeCarrierRows {
  const sourceRow = source(request, "mgnify", "mgnify_taxonomy_tsv");
  const lines = content.replaceAll("\r\n", "\n").split("\n").filter((line) => line.length > 0);
  if (lines.length < 2) fail("MGnify taxonomy TSV must contain a header and at least one record");
  const header = lines[0]!.split("\t");
  const rawExpected = ["study_id", "sample_id", "taxon_path", "taxon_id", "abundance"];
  const canonicalExpected = [...rawExpected, "source_id", "source_asset_id", "source_locator"];
  const canonical = JSON.stringify(header) === JSON.stringify(canonicalExpected);
  if (!canonical && JSON.stringify(header) !== JSON.stringify(rawExpected)) {
    fail("MGnify taxonomy TSV header is not one of the fixed promoted schemas");
  }
  const taxa = lines.slice(1).map((line, index): GutMicrobiomeTaxonInput => {
    const values = line.split("\t");
    const expectedWidth = canonical ? canonicalExpected.length : rawExpected.length;
    if (values.length !== expectedWidth) fail(`MGnify taxonomy TSV row ${index + 2} has the wrong width`);
    if (values[0] !== request.studyId) fail(`MGnify taxonomy TSV row ${index + 2} belongs to a different study`);
    return {
      study_id: text(values[0], "study_id"),
      sample_id: text(values[1], "sample_id"),
      taxon_path: text(values[2], "taxon_path"),
      taxon_id: safeTaxonId(values[3], `row ${index + 2}.taxon_id`),
      abundance: integerValue(Number(values[4]), `row ${index + 2}.abundance`),
      source_id: sourceRow.source_id,
      source_asset_id: request.assetId,
      source_locator: locator(request, `/rows/${index + 1}/taxon_id`, values[3] ?? ""),
    };
  });
  return { studies: [], taxa, differentialAbundances: [], referencePrevalences: [], sources: [sourceRow] };
}

function parseTaxonomyJson(request: GutMicrobiomeCarrierRequest, root: Record<string, unknown>): GutMicrobiomeCarrierRows {
  const sourceRow = source(request, "mgnify", "mgnify_taxonomy_json");
  const rows = array(root.records, "records");
  const taxa = rows.map((value, index): GutMicrobiomeTaxonInput => {
    const item = record(value, `records[${index}]`);
    const rowStudyId = item.study_id === undefined ? request.studyId : text(item.study_id, `records[${index}].study_id`);
    if (rowStudyId !== request.studyId) fail(`records[${index}].study_id does not match the requested study`);
    return {
      study_id: rowStudyId,
      sample_id: text(item.sample_id, `records[${index}].sample_id`),
      taxon_path: text(item.taxon_path, `records[${index}].taxon_path`),
      taxon_id: safeTaxonId(item.taxon_id, `records[${index}].taxon_id`),
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
    source_locator: locator(request, "/TaxaSet/Taxon/TaxId", taxId, true, "taxon_records", 1, 1),
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

function parseDifferentialXlsx(request: GutMicrobiomeCarrierRequest, bytes: Uint8Array): GutMicrobiomeCarrierRows {
  const sourceRow = source(request, "mgnify", "differential_abundance_xlsx");
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(Buffer.from(bytes), { type: "buffer", cellDates: false, cellNF: false, cellText: false });
  } catch (error) {
    fail(`differential abundance XLSX cannot be parsed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const sheet = workbook.Sheets["DifferentialAbundance"];
  if (sheet === undefined) fail("differential abundance XLSX must contain the DifferentialAbundance sheet");
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null, blankrows: false });
  if (rows.length < 2) fail("differential abundance XLSX must contain a header and at least one record");
  const rawExpected = ["study_id", "taxon_id", "comparison_id", "comparison_label", "effect_size", "p_value", "adjusted_p_value", "effect_direction"];
  const canonicalExpected = [...rawExpected, "source_id", "source_asset_id", "source_locator"];
  const header = (rows[0] ?? []).map((value) => value === null ? "" : String(value));
  const canonical = JSON.stringify(header) === JSON.stringify(canonicalExpected);
  if (!canonical && JSON.stringify(header) !== JSON.stringify(rawExpected)) {
    fail("differential abundance XLSX header is not the fixed promoted schema");
  }
  const differentialAbundances = rows.slice(1).map((row, index): GutMicrobiomeDifferentialAbundanceInput => {
    const values = row ?? [];
    const expectedWidth = canonical ? canonicalExpected.length : rawExpected.length;
    if (values.length !== expectedWidth) fail(`differential abundance XLSX row ${index + 2} has the wrong width`);
    const studyId = text(values[0], `row ${index + 2}.study_id`);
    if (studyId !== request.studyId) fail(`differential abundance XLSX row ${index + 2} belongs to a different study`);
    const adjusted = values[6];
    return {
      study_id: studyId,
      taxon_id: safeTaxonId(values[1], `row ${index + 2}.taxon_id`),
      comparison_id: text(values[2], `row ${index + 2}.comparison_id`),
      comparison_label: text(values[3], `row ${index + 2}.comparison_label`),
      effect_size: numberValue(Number(values[4]), `row ${index + 2}.effect_size`),
      p_value: numberValue(Number(values[5]), `row ${index + 2}.p_value`),
      adjusted_p_value: adjusted === null || adjusted === "" ? null : numberValue(Number(adjusted), `row ${index + 2}.adjusted_p_value`),
      effect_direction: text(values[7], `row ${index + 2}.effect_direction`),
      source_id: sourceRow.source_id,
      source_asset_id: request.assetId,
      source_locator: locator(
        request,
        `/DifferentialAbundance/row/${index + 1}`,
        JSON.stringify(values),
        true,
        "differential_abundance_records",
        index + 1,
        1,
      ),
    };
  });
  return { studies: [], taxa: [], differentialAbundances, referencePrevalences: [], sources: [sourceRow] };
}

export function parseGutMicrobiomeCarrier(request: GutMicrobiomeCarrierRequest): GutMicrobiomeCarrierRows {
  if (!ASSET_ID.test(request.assetId)) fail("assetId must be content addressed");
  if (request.logicalFile.trim() === "") fail("logicalFile is required");
  if (Number.isNaN(Date.parse(request.retrievedAt))) fail("retrievedAt must be an ISO datetime");
  if (request.mediaType.includes("vnd.ms-excel") || request.logicalFile.toLowerCase().endsWith(".xls") || request.logicalFile.toLowerCase().endsWith(".docx")) fail("legacy XLS/DOCX carriers are not promoted");
  const lowerMediaType = request.mediaType.toLowerCase();
  const lowerFile = request.logicalFile.toLowerCase();
  if (request.adapterId === "registered_gut_microbiome_differential_abundance_xlsx" || lowerMediaType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" || lowerFile.endsWith(".xlsx")) {
    if (request.adapterId !== "registered_gut_microbiome_differential_abundance_xlsx") fail("modern XLSX requires the fixed registered differential-abundance adapter");
    if (lowerMediaType !== "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") fail("modern XLSX has an unapproved media type");
    return parseDifferentialXlsx(request, request.bytes);
  }
  const content = new TextDecoder("utf-8", { fatal: true }).decode(request.bytes);
  if (request.adapterId === "registered_gut_microbiome_taxon_long_tsv" || request.adapterId === "gut_microbiome.mgnify_taxon_tsv.v1") return parseTaxonomyTsv(request, content);
  if (request.mediaType.includes("xml") || content.trimStart().startsWith("<?xml")) return parseNcbiXml(request, content);
  let root: unknown;
  try { root = JSON.parse(content) as unknown; } catch (error) { fail(`carrier is not strict JSON: ${error instanceof Error ? error.message : String(error)}`); }
  const document = record(root, "carrier");
  switch (request.adapterId) {
    case "registered_gut_microbiome_study_json":
      if (document.study === undefined && document.data === undefined) fail("MGnify study JSON must contain study or JSON:API data");
      return parseStudyJson(request, document);
    case "registered_gut_microbiome_taxon_json":
      if (document.records === undefined) fail("MGnify taxonomy JSON must contain records");
      return parseTaxonomyJson(request, document);
    case "gut_microbiome.ncbi_taxonomy_esearch_json.v1":
      if (document.esearchresult === undefined) fail("NCBI ESearch JSON must contain esearchresult");
      return parseNcbiJson(request, document);
    case "gut_microbiome.gmrepo_associated_species_json.v1":
      if (document.associated_species === undefined) fail("GMRepo JSON must contain associated_species");
      return parseGmrepoJson(request, document);
    default:
      fail(`JSON carrier adapter '${request.adapterId ?? "missing"}' is not promoted`);
  }
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
