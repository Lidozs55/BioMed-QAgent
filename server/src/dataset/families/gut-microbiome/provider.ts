import * as XLSX from "xlsx";
import type { SourceLocatorV2 } from "@biomed/contracts";
import type {
  GutMicrobiomeCrosswalkInput,
  GutMicrobiomeDifferentialAbundanceInput,
  GutMicrobiomePaperDifferentialInput,
  GutMicrobiomeReferencePrevalenceInput,
  GutMicrobiomeSourceInput,
  GutMicrobiomeStudyInput,
  GutMicrobiomeTaxonDetailInput,
  GutMicrobiomeTaxonResolutionInput,
} from "./types.js";
import { assertGutMicrobiomeRows } from "./validation.js";

export const GUT_MICROBIOME_PAPER_SUPPLEMENT_CSV_ADAPTER_ID = "gut_microbiome.paper_supplement_differential_abundance_csv.v1";

const ASSET_ID = /^asset_[0-9a-f]{64}$/;

export interface GutMicrobiomeCarrierRequest {
  assetId: string;
  logicalFile: string;
  retrievedAt: string;
  mediaType: string;
  bytes: Uint8Array;
  studyId: string;
  adapterId?: string;
  /** Binding accession: the verbatim literature name (ESearch) or numeric taxid (EFetch). */
  accession?: string;
  sourceId?: string;
  diseaseId?: string;
  diseaseName?: string;
  hostTaxonId?: string;
}

export interface GutMicrobiomeCarrierRows {
  studies: readonly GutMicrobiomeStudyInput[];
  taxonResolutions: readonly GutMicrobiomeTaxonResolutionInput[];
  taxonDetails: readonly GutMicrobiomeTaxonDetailInput[];
  differentialAbundances: readonly GutMicrobiomeDifferentialAbundanceInput[];
  paperDifferentials: readonly GutMicrobiomePaperDifferentialInput[];
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
  return { studies: [study], taxonResolutions: [], taxonDetails: [], differentialAbundances: [], paperDifferentials: [], referencePrevalences: [], sources: [sourceRow] };
}

function safeTaxonId(value: unknown, label: string): string {
  if ((typeof value !== "string" && typeof value !== "number") || String(value).trim() === "") fail(`${label} is required`);
  const parsed = String(value).trim();
  if (!/^[1-9][0-9]{0,11}$/.test(parsed)) fail(`${label} must be a numeric NCBI taxon ID`);
  return parsed;
}

function parseNcbiJson(request: GutMicrobiomeCarrierRequest, root: Record<string, unknown>): GutMicrobiomeCarrierRows {
  const result = record(root.esearchresult, "esearchresult");
  const idList = array(result.idlist, "esearchresult.idlist");
  const queryName = (request.accession ?? request.studyId).trim();
  if (queryName === "") fail("NCBI ESearch binding must carry the queried literature name as its accession");
  const sourceRow = source(request, "ncbi_taxonomy", "ncbi_taxonomy_esearch_json");
  if (idList.length === 0) {
    // An empty idlist is a legitimate unresolved-name outcome, not a parse
    // failure: the name stays out of the crosswalk and rows keyed by it are
    // skipped deterministically downstream.
    return { studies: [], taxonResolutions: [{
      query_name: queryName,
      taxon_id: null,
      source_id: sourceRow.source_id,
      source_asset_id: request.assetId,
      source_locator: locator(request, "/esearchresult/idlist", ""),
    }], taxonDetails: [], differentialAbundances: [], paperDifferentials: [], referencePrevalences: [], sources: [sourceRow] };
  }
  if (idList.length !== 1 || typeof idList[0] !== "string" || !/^[1-9][0-9]{0,11}$/.test(idList[0])) fail("NCBI ESearch must return exactly one numeric taxid");
  return { studies: [], taxonResolutions: [{
    query_name: queryName,
    taxon_id: idList[0],
    source_id: sourceRow.source_id,
    source_asset_id: request.assetId,
    source_locator: locator(request, "/esearchresult/idlist/0", idList[0]),
  }], taxonDetails: [], differentialAbundances: [], paperDifferentials: [], referencePrevalences: [], sources: [sourceRow] };
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * NCBI name-class classification, shared by the ClassCDE/NameType element
 * form and the legacy single-letter codes. Only the three crosswalk classes
 * are tracked; authority, misspelling, common-name, and similar classes are
 * intentionally dropped.
 */
function classifyNcbiNameClass(raw: string): "synonym" | "equivalent" | "historical" | null {
  const code = raw.trim().toLowerCase();
  if (code === "") return null;
  if (code.includes("equivalent") || code === "e") return "equivalent";
  if (code.includes("historical") || code === "h") return "historical";
  if (code.includes("synonym") || code === "s" || code === "d") return "synonym";
  return null;
}

const MAX_NAMES_PER_CLASS = 20;

function parseNcbiXml(request: GutMicrobiomeCarrierRequest, content: string): GutMicrobiomeCarrierRows {
  // LineageEx nests <Taxon> elements inside the requested taxon; strip those
  // blocks first so top-level Taxon extraction cannot stop at a nested close.
  const withoutLineageEx = content.replace(/<LineageEx>[\s\S]*?<\/LineageEx>/g, "");
  const taxonBlocks = [...withoutLineageEx.matchAll(/<Taxon>([\s\S]*?)<\/Taxon>/g)].map((match) => match[1] ?? "");
  if (taxonBlocks.length === 0) fail("NCBI EFetch XML must contain a Taxon record");
  const sourceRow = source(request, "ncbi_taxonomy", "ncbi_taxonomy_efetch_xml");
  const details: GutMicrobiomeTaxonDetailInput[] = [];
  for (const [index, block] of taxonBlocks.entries()) {
    const firstTag = (tag: string): string | null => {
      const match = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(block);
      const raw = match?.[1]?.trim();
      return raw === undefined || raw === "" ? null : decodeXmlEntities(raw);
    };
    const taxId = firstTag("TaxId");
    const scientificName = firstTag("ScientificName");
    const rank = firstTag("Rank") ?? "no rank";
    if (taxId === null || scientificName === null) fail(`NCBI EFetch Taxon record ${index} must contain TaxId and ScientificName`);
    const synonyms: string[] = [];
    const equivalents: string[] = [];
    const historical: string[] = [];
    const otherNames = /<OtherNames>([\s\S]*?)<\/OtherNames>/.exec(block)?.[1];
    if (otherNames !== undefined) {
      const push = (nameClass: "synonym" | "equivalent" | "historical" | null, value: string): void => {
        if (nameClass === null) return;
        const target = nameClass === "synonym" ? synonyms : nameClass === "equivalent" ? equivalents : historical;
        if (target.length < MAX_NAMES_PER_CLASS) target.push(value);
      };
      for (const match of otherNames.matchAll(/<(Synonym|GenbankSynonym|EquivalentName)>([^<]*)<\/\1>/g)) {
        const value = decodeXmlEntities((match[2] ?? "").trim());
        if (value !== "") push(match[1] === "EquivalentName" ? "equivalent" : "synonym", value);
      }
      for (const match of otherNames.matchAll(/<Name>([\s\S]*?)<\/Name>/g)) {
        const nameBlock = match[1] ?? "";
        const classCode = /<(?:ClassCDE|NameType|Class)>([^<]+)<\/(?:ClassCDE|NameType|Class)>/.exec(nameBlock)?.[1];
        const display = /<DispName>([^<]*)<\/DispName>/.exec(nameBlock)?.[1]?.trim();
        const value = display === undefined || display === "" ? null : decodeXmlEntities(display);
        if (classCode !== undefined && value !== null && value !== "") push(classifyNcbiNameClass(classCode), value);
      }
    }
    details.push({
      ncbi_taxon_id: taxId,
      current_name: scientificName,
      common_name: firstTag("CommonName"),
      taxon_rank: rank,
      parent_taxon_id: firstTag("ParentTaxId"),
      lineage: firstTag("Lineage"),
      synonyms,
      equivalent_names: equivalents,
      historical_names: historical,
      source_id: sourceRow.source_id,
      source_asset_id: request.assetId,
      source_locator: locator(request, `/TaxaSet/Taxon/${index}/TaxId`, taxId, true, "taxon_records", index + 1, 1),
    });
  }
  return { studies: [], taxonResolutions: [], taxonDetails: details, differentialAbundances: [], paperDifferentials: [], referencePrevalences: [], sources: [sourceRow] };
}

/**
 * Join raw paper supplement records to NCBI taxids via the ESearch
 * resolutions of the same spec. Records whose reported name has no resolved
 * ESearch binding are skipped deterministically; a paper whose names all fail
 * the join fails closed with the verbatim-name remedy.
 */
export function joinPaperDifferentials(
  records: readonly GutMicrobiomePaperDifferentialInput[],
  resolutions: readonly GutMicrobiomeTaxonResolutionInput[],
): GutMicrobiomeDifferentialAbundanceInput[] {
  const taxidByName = new Map<string, string>();
  for (const resolution of resolutions) {
    if (resolution.taxon_id !== null && !taxidByName.has(resolution.query_name.trim())) {
      taxidByName.set(resolution.query_name.trim(), resolution.taxon_id);
    }
  }
  const joined: GutMicrobiomeDifferentialAbundanceInput[] = [];
  for (const record of records) {
    const taxonId = taxidByName.get(record.reported_taxon_name.trim());
    if (taxonId === undefined) continue;
    joined.push({
      study_id: record.study_id,
      taxon_id: taxonId,
      comparison_id: record.comparison_id,
      comparison_label: record.comparison_label,
      effect_size: record.effect_size,
      p_value: record.p_value,
      adjusted_p_value: record.adjusted_p_value,
      effect_direction: record.effect_direction,
      source_id: record.source_id,
      source_asset_id: record.source_asset_id,
      source_locator: record.source_locator,
    });
  }
  if (records.length > 0 && joined.length === 0) {
    fail(
      "paper supplement records could not join any NCBI taxon — bind gut_microbiome.ncbi_taxonomy_esearch_json.v1 " +
        "accessions with the verbatim reported taxon names of the supplement (e.g. '[Ruminococcus] torques')",
    );
  }
  return joined;
}

/**
 * Compose the final taxon_records crosswalk rows: one row per EFetch detail,
 * carrying the deduplicated literature query names that resolved to it.
 * A resolution whose taxid has no EFetch detail binding fails closed with the
 * exact missing accession so the caller can complete the binding pair.
 */
export function composeGutMicrobiomeCrosswalk(
  resolutions: readonly GutMicrobiomeTaxonResolutionInput[],
  details: readonly GutMicrobiomeTaxonDetailInput[],
): GutMicrobiomeCrosswalkInput[] {
  const detailsById = new Map<string, GutMicrobiomeTaxonDetailInput>();
  for (const detail of details) {
    const existing = detailsById.get(detail.ncbi_taxon_id);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(detail)) {
      fail(`NCBI EFetch returned conflicting records for taxid ${detail.ncbi_taxon_id}`);
    }
    detailsById.set(detail.ncbi_taxon_id, detail);
  }
  const queryNamesByTaxid = new Map<string, string[]>();
  for (const resolution of resolutions) {
    if (resolution.taxon_id === null) continue;
    const names = queryNamesByTaxid.get(resolution.taxon_id) ?? [];
    if (!names.includes(resolution.query_name)) names.push(resolution.query_name);
    queryNamesByTaxid.set(resolution.taxon_id, names);
  }
  const missing: string[] = [];
  for (const taxid of queryNamesByTaxid.keys()) {
    if (!detailsById.has(taxid)) missing.push(taxid);
  }
  if (missing.length > 0) {
    fail(
      `resolved taxid${missing.length === 1 ? "" : "s"} ${missing.sort().join(", ")} ha${missing.length === 1 ? "s" : "ve"} no NCBI EFetch detail binding — ` +
        `add one gut_microbiome.ncbi_taxonomy_efetch_xml.v1 binding per taxid (numeric accession)`,
    );
  }
  return [...detailsById.values()].map((detail): GutMicrobiomeCrosswalkInput => {
    const names = queryNamesByTaxid.get(detail.ncbi_taxon_id) ?? [];
    const alternativeNames = [...detail.synonyms, ...detail.equivalent_names, ...detail.historical_names]
      .map((name) => name.trim().toLowerCase());
    const nameChangeObserved = names.some((name) =>
      name.trim().toLowerCase() !== detail.current_name.trim().toLowerCase() ||
      alternativeNames.includes(name.trim().toLowerCase()));
    return {
      ncbi_taxon_id: detail.ncbi_taxon_id,
      current_name: detail.current_name,
      common_name: detail.common_name,
      taxon_rank: detail.taxon_rank,
      parent_taxon_id: detail.parent_taxon_id,
      lineage: detail.lineage,
      synonyms: detail.synonyms.join("; "),
      equivalent_names: detail.equivalent_names.join("; "),
      historical_names: detail.historical_names.join("; "),
      name_change_observed: nameChangeObserved,
      query_names: names.length === 0 ? null : names.join("; "),
      source_id: detail.source_id,
      source_asset_id: detail.source_asset_id,
      source_locator: detail.source_locator,
    };
  });
}

function parseGmrepoJson(request: GutMicrobiomeCarrierRequest, root: Record<string, unknown>): GutMicrobiomeCarrierRows {
  const sourceRow = source(request, "gmrepo", "gmrepo_taxon_phenotypes_json");
  // Rows belong to exactly one queried taxon by construction: the fixed
  // provider POSTs ``{"ncbi_taxon_id": <binding accession>}`` upstream, so
  // the carrier needs no separate study/taxon equality check here.
  const rows = array(root.phenotypes_associated_with_taxon, "phenotypes_associated_with_taxon").map((value, index): GutMicrobiomeReferencePrevalenceInput => {
    const item = record(value, `phenotypes_associated_with_taxon[${index}]`);
    const samples = integerValue(item.samples, `phenotypes_associated_with_taxon[${index}].samples`);
    const total = integerValue(item.all_samples, `phenotypes_associated_with_taxon[${index}].all_samples`);
    if (total < 1 || samples < 0 || samples > total) fail("GMRepo sample counts are inconsistent");
    return {
      study_id: request.studyId,
      taxon_id: String(integerValue(item.ncbi_taxon_id, `phenotypes_associated_with_taxon[${index}].ncbi_taxon_id`)),
      reference_group: `gmrepo:${text(item.term ?? item.disease, `phenotypes_associated_with_taxon[${index}].term`)} (${text(item.disease, `phenotypes_associated_with_taxon[${index}].disease`)})`,
      prevalence: samples / total,
      reference_sample_count: total,
      source_id: sourceRow.source_id,
      source_asset_id: request.assetId,
      source_locator: locator(request, `/phenotypes_associated_with_taxon/${index}`, JSON.stringify(item)),
    };
  });
  return { studies: [], taxonResolutions: [], taxonDetails: [], differentialAbundances: [], paperDifferentials: [], referencePrevalences: rows, sources: [sourceRow] };
}

/** RFC4180-style whole-document CSV parse: quoted fields may contain commas, CRLF, and doubled quotes. */
function parseCsvDocument(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStarted = false;
  const endField = (): void => { row.push(field); field = ""; fieldStarted = false; };
  const endRow = (): void => { endField(); rows.push(row); row = []; };
  for (let index = 0; index < content.length; index += 1) {
    const ch = content[index];
    if (inQuotes) {
      if (ch === '"') {
        if (content[index + 1] === '"') { field += '"'; index += 1; } else { inQuotes = false; }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && !fieldStarted) { inQuotes = true; fieldStarted = true; continue; }
    if (ch === ",") { endField(); continue; }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && content[index + 1] === "\n") index += 1;
      endRow();
      continue;
    }
    field += ch;
    fieldStarted = true;
  }
  if (field !== "" || row.length > 0 || fieldStarted) endRow();
  return rows;
}

type SupplementMetric = "effect" | "p_value" | "adjusted_p_value";

/**
 * Metric sub-header classification. Header cells are matched after folding to
 * lower case and collapsing spacing, so `β`, `pvalue`, and `q value` all
 * resolve while unrelated prose cells stay unmatched.
 */
function supplementMetricFor(cell: string): SupplementMetric | null {
  const token = cell.trim().toLowerCase().replace(/\s+/g, " ");
  if (["β", "beta", "b", "coefficient", "coeff", "effect", "effect size", "estimate", "fold change", "log2fc", "log2 fold change", "log fold change", "odds ratio", "difference"].includes(token)) return "effect";
  if (["p", "p value", "pvalue", "p-value", "p val", "pval"].includes(token)) return "p_value";
  if (["q", "q value", "qvalue", "q-value", "padj", "p adj", "p.adjust", "fdr", "adjusted p", "adjusted p value", "adjusted p-value"].includes(token)) return "adjusted_p_value";
  return null;
}

function slug(value: string): string {
  const normalized = value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized.slice(0, 60) || "col";
}

function parsePaperSupplementCsv(request: GutMicrobiomeCarrierRequest, content: string): GutMicrobiomeCarrierRows {
  const sourceRow = source(request, "europepmc_supplementary", "paper_supplement_differential_abundance_csv");
  const rows = parseCsvDocument(content);
  if (rows.length < 3) fail("paper supplement CSV must contain a header block and at least one record");

  // 1) Locate the metric sub-header row: several cells that classify as
  // effect/p/q metrics, with every non-empty cell a known metric.
  let subHeaderIndex = -1;
  let metricColumns = new Map<number, SupplementMetric>();
  for (let index = 0; index < Math.min(rows.length, 12); index += 1) {
    const metrics = new Map<number, SupplementMetric>();
    let matched = 0;
    for (const [column, cell] of rows[index]!.entries()) {
      const metric = supplementMetricFor(cell);
      if (metric !== null) { metrics.set(column, metric); matched += 1; }
    }
    if (matched >= 2 && [...rows[index]!.entries()].every(([column, cell]) => cell.trim() === "" || metrics.has(column))) {
      subHeaderIndex = index;
      metricColumns = metrics;
      break;
    }
  }
  if (subHeaderIndex < 1) fail("paper supplement CSV has no recognized metric sub-header row (expected effect/p/q column labels such as β, pvalue, q value)");
  const groupRow = rows[subHeaderIndex - 1]!.map((cell) => cell.trim());

  // 2) Entity column: labelled in the group row, empty in the sub-header row.
  const firstMetricColumn = Math.min(...metricColumns.keys());
  const entityColumn = groupRow.findIndex((cell, column) =>
    cell !== "" && column < firstMetricColumn && (rows[subHeaderIndex]![column] ?? "").trim() === "");
  if (entityColumn < 0) fail("paper supplement CSV has no entity column (group-header label with empty metric cell above the data rows)");

  // 3) Forward-fill merged group labels, then derive each group's metric
  // layout: labeled sub-header cells win; merged holes inherit the metric at
  // the same offset of the previous complete group block (microsoft-style
  // merged sub-headers like GCDCA's missing `pvalue` label).
  const groups: string[] = [];
  let lastGroup = "";
  for (let column = entityColumn + 1; column < groupRow.length; column += 1) {
    if (groupRow[column] !== "") lastGroup = groupRow[column]!;
    groups[column] = lastGroup;
  }
  const groupSpans: { group: string; start: number; end: number }[] = [];
  for (let column = entityColumn + 1; column < groups.length; column += 1) {
    const group = groups[column] ?? "";
    if (group === "") continue;
    const last = groupSpans[groupSpans.length - 1];
    if (last !== undefined && last.group === group) last.end = column + 1;
    else groupSpans.push({ group, start: column, end: column + 1 });
  }
  const metricByColumn = new Map<number, SupplementMetric>();
  let previousPattern: SupplementMetric[] = [];
  for (const span of groupSpans) {
    const block: SupplementMetric[] = [];
    for (let column = span.start; column < span.end && column < span.start + 4; column += 1) {
      const labeled = metricColumns.get(column);
      const filled = labeled ?? previousPattern[column - span.start];
      if (filled !== undefined) { block.push(filled); metricByColumn.set(column, filled); }
    }
    if (block.length >= 2) previousPattern = block;
  }

  // 4) Emit one record per (entity row, group block) with effect and p values.
  const paperSegment = request.logicalFile.split(/[\\/]/).pop() ?? request.logicalFile;
  const firstDot = paperSegment.indexOf(".");
  const paperSlug = slug(firstDot === -1 ? paperSegment : paperSegment.slice(0, firstDot));
  const records: GutMicrobiomePaperDifferentialInput[] = [];
  const seenComparisons = new Set<string>();
  for (let index = subHeaderIndex + 1; index < rows.length; index += 1) {
    const cells = rows[index]!.map((cell) => cell.trim());
    const entity = cells[entityColumn] ?? "";
    if (entity === "") continue;
    for (const span of groupSpans) {
      const effectColumn = [...metricByColumn.entries()].find(([column, metric]) =>
        column >= span.start && column < span.end && metric === "effect")?.[0];
      const pColumn = [...metricByColumn.entries()].find(([column, metric]) =>
        column >= span.start && column < span.end && metric === "p_value")?.[0];
      if (effectColumn === undefined || pColumn === undefined) continue;
      const adjustedColumn = [...metricByColumn.entries()].find(([column, metric]) =>
        column >= span.start && column < span.end && metric === "adjusted_p_value")?.[0];
      // Ragged trailing cells are blank by CSV convention, never an error.
      const cellAt = (column: number): string => cells[column] ?? "";
      const adjusted = adjustedColumn === undefined || cellAt(adjustedColumn) === "" ? null : Number(cellAt(adjustedColumn));
      if (cellAt(effectColumn) === "" || cellAt(pColumn) === "") continue;
      const effect = Number(cellAt(effectColumn));
      const pValue = Number(cellAt(pColumn));
      if (!Number.isFinite(effect) || !Number.isFinite(pValue) || pValue < 0 || pValue > 1) {
        fail(`paper supplement CSV row ${index + 1} group '${span.group}' has a non-numeric effect or an out-of-range p value`);
      }
      if (adjusted !== null && (!Number.isFinite(adjusted) || adjusted < 0 || adjusted > 1)) {
        fail(`paper supplement CSV row ${index + 1} group '${span.group}' has an out-of-range adjusted p value`);
      }
      const comparisonId = `${paperSlug}__${slug(entity)}__${slug(span.group)}`;
      if (seenComparisons.has(comparisonId)) continue;
      seenComparisons.add(comparisonId);
      records.push({
        study_id: request.studyId,
        reported_taxon_name: entity,
        comparison_id: comparisonId,
        comparison_label: span.group,
        effect_size: effect,
        p_value: pValue,
        adjusted_p_value: adjusted,
        effect_direction: effect > 0 ? "increase" : effect < 0 ? "decrease" : "unchanged",
        source_id: sourceRow.source_id,
        source_asset_id: request.assetId,
        source_locator: locator(request, `/row/${index}/col/${effectColumn}`, cellAt(effectColumn), true, "differential_abundance_records", index + 1, effectColumn + 1),
      });
    }
  }
  if (records.length === 0) fail("paper supplement CSV yielded no differential records from the recognized layout");
  return { studies: [], taxonResolutions: [], taxonDetails: [], differentialAbundances: [], paperDifferentials: records, referencePrevalences: [], sources: [sourceRow] };
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
  return { studies: [], taxonResolutions: [], taxonDetails: [], differentialAbundances, paperDifferentials: [], referencePrevalences: [], sources: [sourceRow] };
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
  if (request.adapterId === GUT_MICROBIOME_PAPER_SUPPLEMENT_CSV_ADAPTER_ID) {
    if (request.mediaType.toLowerCase() !== "text/csv") {
      fail("paper supplement differential CSV requires a text/csv extraction member asset (run acquire_core_carrier on europepmc.supplementary.v1 and bind the xlsx worksheet member asset via source_files)");
    }
    return parsePaperSupplementCsv(request, content);
  }
  if (request.mediaType.includes("xml") || content.trimStart().startsWith("<?xml")) return parseNcbiXml(request, content);
  let root: unknown;
  try { root = JSON.parse(content) as unknown; } catch (error) { fail(`carrier is not strict JSON: ${error instanceof Error ? error.message : String(error)}`); }
  const document = record(root, "carrier");
  switch (request.adapterId) {
    case "registered_gut_microbiome_study_json":
      if (document.study === undefined && document.data === undefined) fail("MGnify study JSON must contain study or JSON:API data");
      return parseStudyJson(request, document);
    case "gut_microbiome.ncbi_taxonomy_esearch_json.v1":
      if (document.esearchresult === undefined) fail("NCBI ESearch JSON must contain esearchresult");
      return parseNcbiJson(request, document);
    case "gut_microbiome.gmrepo_taxon_phenotypes_json.v1":
      if (document.phenotypes_associated_with_taxon === undefined) fail("GMRepo JSON must contain phenotypes_associated_with_taxon");
      return parseGmrepoJson(request, document);
    default:
      fail(`JSON carrier adapter '${request.adapterId ?? "missing"}' is not promoted`);
  }
}

export function assertGutMicrobiomeCarrierRows(rows: {
  studies: readonly GutMicrobiomeStudyInput[];
  crosswalk: readonly GutMicrobiomeCrosswalkInput[];
  differentialAbundances: readonly GutMicrobiomeDifferentialAbundanceInput[];
  referencePrevalences: readonly GutMicrobiomeReferencePrevalenceInput[];
  sources: readonly GutMicrobiomeSourceInput[];
}): void {
  assertGutMicrobiomeRows({
    studies: rows.studies,
    crosswalk: rows.crosswalk,
    differentialAbundances: rows.differentialAbundances,
    referencePrevalences: rows.referencePrevalences,
    sources: rows.sources,
  });
}
