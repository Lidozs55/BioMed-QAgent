import { createHash } from "node:crypto";

import type { JsonValue, SourceLocatorV2 } from "@biomed/contracts";
import { XMLParser, XMLValidator } from "fast-xml-parser";

import { MAX_XML_CARRIER_BYTES } from "../../runtime/provider-limits.js";

export const BIOC_LITERATURE_PROVIDER_ID = "literature.bioc_xml.v1";
export const BIOC_LITERATURE_PROVIDER_VERSION = "1.0.0";

export interface BioCLiteratureTransformInput {
  bytes: Buffer;
  assetId: string;
  logicalFile: string;
  retrievedAt: string;
  sourceDatabase?: string;
}

export interface BioCLiteratureEvidenceRow {
  evidence_id: string;
  paper_id: string;
  paper_id_namespace: string;
  experiment_id: string;
  evidence_type: string;
  claim_text: string;
  result_summary: string;
  study_context: JsonValue;
  source_id: string;
}

export interface BioCLiteraturePaperRow {
  paper_id: string;
  paper_id_namespace: string;
  title: string;
  journal: string | null;
  publication_date: string | null;
  authors: JsonValue;
  source_url: string | null;
  source_id: string;
}

export interface BioCLiteratureSourceRow {
  source_id: string;
  source_database: string;
  source_asset_id: string;
  source_locator: SourceLocatorV2;
  retrieved_at: string;
  carrier_type: "paper_table";
}

export interface BioCLiteratureCanonicalTables {
  literature_evidence: BioCLiteratureEvidenceRow[];
  papers: BioCLiteraturePaperRow[];
  sources: BioCLiteratureSourceRow[];
}

type XmlRecord = Record<string, unknown>;

function record(value: unknown, name: string): XmlRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an XML element`);
  }
  return value as XmlRecord;
}

function children(node: unknown, name: string): unknown[] {
  if (typeof node !== "object" || node === null || Array.isArray(node)) return [];
  const value = (node as XmlRecord)[name];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function descendants(node: unknown, name: string): unknown[] {
  const values: unknown[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, child] of Object.entries(value)) {
      if (key.startsWith("@_")) continue;
      if (key === name) values.push(...(Array.isArray(child) ? child : [child]));
      visit(child);
    }
  };
  visit(node);
  return values;
}

function text(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join(" ").trim();
  if (typeof node !== "object" || node === null) return "";
  return Object.entries(node)
    .filter(([key]) => !key.startsWith("@_"))
    .map(([, value]) => text(value))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstText(node: unknown, name: string): string {
  return text(children(node, name)[0]);
}

function infons(node: unknown): Map<string, string> {
  const values = new Map<string, string>();
  for (const infon of children(node, "infon")) {
    const element = record(infon, "infon");
    const key = element["@_key"];
    if (typeof key === "string" && key.trim() !== "") values.set(key.trim().toLowerCase(), text(infon));
  }
  return values;
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === "") throw new TypeError(`BioC literature table requires ${name}`);
  return value.trim();
}

function stableId(prefix: string, values: readonly string[]): string {
  return `${prefix}_${createHash("sha256").update(JSON.stringify(values)).digest("hex").slice(0, 24)}`;
}

function normalizedHeader(value: string): string {
  const key = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const aliases: Readonly<Record<string, string>> = {
    experiment: "experiment_id",
    experiment_identifier: "experiment_id",
    evidence: "evidence_type",
    claim: "claim_text",
    result: "result_summary",
    activity: "activity_value",
    value: "activity_value",
    reported_value: "activity_value",
    unit: "activity_unit",
    reported_unit: "activity_unit",
    precision: "value_precision",
    extraction_confidence: "confidence",
    human_review_status: "review_status",
  };
  return aliases[key] ?? key;
}

function paperIdentity(document: unknown): { id: string; namespace: string } {
  const metadata = infons(document);
  const pmid = metadata.get("pmid") ?? metadata.get("pubmed");
  if (pmid !== undefined) return { id: required(pmid, "paper PMID"), namespace: "pubmed" };
  const pmc = metadata.get("pmcid") ?? metadata.get("pmc");
  if (pmc !== undefined) return { id: required(pmc, "paper PMCID"), namespace: "pmc" };
  const doi = metadata.get("doi");
  if (doi !== undefined) return { id: required(doi, "paper DOI"), namespace: "doi" };
  return { id: required(firstText(document, "id"), "document id"), namespace: "bioc" };
}

function parseDate(value: string | undefined): string | null {
  if (value === undefined || value === "") return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TypeError("BioC publication_date must be an ISO date");
  }
  return value;
}

function parseDocument(options: {
  input: BioCLiteratureTransformInput;
  document: unknown;
  documentIndex: number;
  sourceDatabase: string;
}): BioCLiteratureCanonicalTables {
  const metadata = infons(options.document);
  const paper = paperIdentity(options.document);
  const passages = children(options.document, "passage");
  const title = required(
    metadata.get("title") ?? text(passages[0]),
    "paper title infon or first passage text",
  );
  const output: BioCLiteratureCanonicalTables = { literature_evidence: [], papers: [], sources: [] };

  passages.forEach((passage, passageIndex) => {
    const passageMetadata = infons(passage);
    descendants(passage, "table").forEach((table, tableIndex) => {
      const tableElement = record(table, "table");
      const tableId = required(
        typeof tableElement["@_id"] === "string" ? tableElement["@_id"] : passageMetadata.get("table_id"),
        "table id",
      );
      const rows = children(table, "row");
      if (rows.length < 2) throw new TypeError(`BioC table '${tableId}' requires a header and at least one data row`);
      const headers = children(rows[0], "cell").map((cell) => normalizedHeader(text(cell)));
      if (headers.length === 0 || new Set(headers).size !== headers.length) {
        throw new TypeError(`BioC table '${tableId}' has empty or duplicate headers`);
      }
      const requiredHeaders = [
        "experiment_id", "evidence_type", "claim_text", "result_summary",
        "value_precision", "confidence", "review_status",
      ];
      for (const header of requiredHeaders) {
        if (!headers.includes(header)) throw new TypeError(`BioC table '${tableId}' requires '${header}' column`);
      }

      rows.slice(1).forEach((row, rowIndex) => {
        const cells = children(row, "cell").map(text);
        if (cells.length !== headers.length) throw new TypeError(`BioC table '${tableId}' row ${rowIndex + 1} width mismatch`);
        const values = Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]));
        const precision = required(values.value_precision, "value_precision").toLowerCase();
        const confidence = required(values.confidence, "confidence").toLowerCase();
        const reviewStatus = required(values.review_status, "review_status").toLowerCase();
        if (precision !== "exact" && precision !== "estimated") throw new TypeError("value_precision must be exact or estimated");
        if (!new Set(["high", "medium", "low"]).has(confidence)) throw new TypeError("confidence must be high, medium, or low");
        if (!new Set(["not_required", "pending", "accepted", "corrected", "rejected"]).has(reviewStatus)) {
          throw new TypeError("review_status is invalid");
        }
        if (confidence === "low" && reviewStatus !== "accepted" && reviewStatus !== "corrected") {
          throw new TypeError(`BioC table '${tableId}' row ${rowIndex + 1} is low-confidence and unreviewed`);
        }
        if (reviewStatus === "rejected") throw new TypeError(`BioC table '${tableId}' row ${rowIndex + 1} was rejected by review`);
        const activityValue = values.activity_value?.trim() || null;
        if (precision === "exact" && activityValue !== null && !Number.isFinite(Number(activityValue))) {
          throw new TypeError("exact activity_value must be numeric; qualified or inferred values must be estimated");
        }

        const sourceId = stableId("source", [
          paper.id, tableId, String(passageIndex), String(tableIndex), String(rowIndex),
        ]);
        const locator: SourceLocatorV2 = {
          locator_version: "2.0",
          locator_type: "xml_cell",
          asset_id: options.input.assetId,
          logical_file: options.input.logicalFile,
          raw_value: cells.join(" | "),
          xml_path: `/collection/document[${options.documentIndex + 1}]/passage[${passageIndex + 1}]/table[${tableIndex + 1}]/row[${rowIndex + 2}]`,
          table_id: tableId,
          row_index: rowIndex + 1,
          column_index: 1,
        };
        if (!output.sources.some((source) => source.source_id === sourceId)) {
          output.sources.push({
            source_id: sourceId,
            source_database: options.sourceDatabase,
            source_asset_id: options.input.assetId,
            source_locator: locator,
            retrieved_at: options.input.retrievedAt,
            carrier_type: "paper_table",
          });
        }
        const experimentId = required(values.experiment_id, "experiment_id");
        output.literature_evidence.push({
          evidence_id: stableId("evidence", [paper.namespace, paper.id, tableId, experimentId, String(rowIndex)]),
          paper_id: paper.id,
          paper_id_namespace: paper.namespace,
          experiment_id: experimentId,
          evidence_type: required(values.evidence_type, "evidence_type"),
          claim_text: required(values.claim_text, "claim_text"),
          result_summary: required(values.result_summary, "result_summary"),
          study_context: {
            table_id: tableId,
            activity_value: activityValue,
            activity_unit: values.activity_unit?.trim() || null,
            value_precision: precision,
            confidence,
            review_status: reviewStatus,
          },
          source_id: sourceId,
        });
      });
    });
  });

  if (output.literature_evidence.length === 0 || output.sources.length === 0) {
    throw new TypeError("BioC document contains no canonical evidence table rows");
  }
  output.papers.push({
    paper_id: paper.id,
    paper_id_namespace: paper.namespace,
    title,
    journal: metadata.get("journal")?.trim() || null,
    publication_date: parseDate(metadata.get("publication_date")),
    authors: metadata.has("authors")
      ? metadata.get("authors")!.split(";").map((author) => author.trim()).filter(Boolean)
      : null,
    source_url: metadata.get("source_url")?.trim() || null,
    source_id: output.sources[0]!.source_id,
  });
  return output;
}

function jatsPaperIdentity(article: unknown): { id: string; namespace: string } {
  for (const item of descendants(article, "article-id")) {
    const element = record(item, "article-id");
    const namespace = element["@_pub-id-type"];
    const value = text(item);
    if (typeof namespace !== "string" || value === "") continue;
    if (namespace === "pmid") return { id: value, namespace: "pubmed" };
    if (namespace === "pmc" || namespace === "pmcid") return { id: value.startsWith("PMC") ? value : `PMC${value}`, namespace: "pmc" };
    if (namespace === "doi") return { id: value, namespace: "doi" };
  }
  throw new TypeError("Europe PMC fullTextXML article has no PMID, PMCID, or DOI");
}

function parseJatsArticle(
  input: BioCLiteratureTransformInput,
  article: unknown,
  sourceDatabase: string,
): BioCLiteratureCanonicalTables {
  const paper = jatsPaperIdentity(article);
  const title = required(text(descendants(article, "article-title")[0]), "JATS article title");
  const output: BioCLiteratureCanonicalTables = { literature_evidence: [], papers: [], sources: [] };
  const tableWraps = descendants(article, "table-wrap");
  tableWraps.forEach((tableWrap, tableIndex) => {
    const wrap = record(tableWrap, "table-wrap");
    const tableId = typeof wrap["@_id"] === "string" && wrap["@_id"].trim() !== ""
      ? wrap["@_id"].trim()
      : `table_${tableIndex + 1}`;
    const table = descendants(tableWrap, "table")[0];
    if (table === undefined) return;
    const rows = descendants(table, "tr");
    if (rows.length < 2) return;
    const headerCells = [
      ...children(rows[0], "th"),
      ...children(rows[0], "td"),
    ];
    const headers = headerCells.map((cell) => normalizedHeader(text(cell)));
    const requiredHeaders = [
      "experiment_id", "evidence_type", "claim_text", "result_summary",
      "value_precision", "confidence", "review_status",
    ];
    if (headers.length === 0 || new Set(headers).size !== headers.length ||
        requiredHeaders.some((header) => !headers.includes(header))) return;
    rows.slice(1).forEach((row, rowIndex) => {
      const cells = [...children(row, "td"), ...children(row, "th")].map(text);
      if (cells.length !== headers.length) {
        throw new TypeError(`JATS table '${tableId}' row ${rowIndex + 1} width mismatch`);
      }
      const values = Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]));
      const precision = required(values.value_precision, "value_precision").toLowerCase();
      const confidence = required(values.confidence, "confidence").toLowerCase();
      const reviewStatus = required(values.review_status, "review_status").toLowerCase();
      if (precision !== "exact" && precision !== "estimated") throw new TypeError("value_precision must be exact or estimated");
      if (!new Set(["high", "medium", "low"]).has(confidence)) throw new TypeError("confidence must be high, medium, or low");
      if (!new Set(["not_required", "pending", "accepted", "corrected", "rejected"]).has(reviewStatus)) {
        throw new TypeError("review_status is invalid");
      }
      if (confidence === "low" && reviewStatus !== "accepted" && reviewStatus !== "corrected") {
        throw new TypeError(`JATS table '${tableId}' row ${rowIndex + 1} is low-confidence and unreviewed`);
      }
      if (reviewStatus === "rejected") throw new TypeError(`JATS table '${tableId}' row ${rowIndex + 1} was rejected by review`);
      const sourceId = stableId("source", [paper.id, tableId, String(tableIndex), String(rowIndex)]);
      const locator: SourceLocatorV2 = {
        locator_version: "2.0",
        locator_type: "xml_cell",
        asset_id: input.assetId,
        logical_file: input.logicalFile,
        raw_value: cells.join(" | "),
        xml_path: `/article/body/table-wrap[${tableIndex + 1}]/table/tr[${rowIndex + 2}]`,
        table_id: tableId,
        row_index: rowIndex + 1,
        column_index: 1,
      };
      if (!output.sources.some((source) => source.source_id === sourceId)) {
        output.sources.push({
          source_id: sourceId,
          source_database: sourceDatabase,
          source_asset_id: input.assetId,
          source_locator: locator,
          retrieved_at: input.retrievedAt,
          carrier_type: "paper_table",
        });
      }
      const experimentId = required(values.experiment_id, "experiment_id");
      output.literature_evidence.push({
        evidence_id: stableId("evidence", [paper.namespace, paper.id, tableId, experimentId, String(rowIndex)]),
        paper_id: paper.id,
        paper_id_namespace: paper.namespace,
        experiment_id: experimentId,
        evidence_type: required(values.evidence_type, "evidence_type"),
        claim_text: required(values.claim_text, "claim_text"),
        result_summary: required(values.result_summary, "result_summary"),
        study_context: {
          table_id: tableId,
          activity_value: values.activity_value?.trim() || null,
          activity_unit: values.activity_unit?.trim() || null,
          value_precision: precision,
          confidence,
          review_status: reviewStatus,
        },
        source_id: sourceId,
      });
    });
  });
  if (output.literature_evidence.length === 0) {
    throw new TypeError("Europe PMC fullTextXML article contains no canonical evidence table rows");
  }
  output.papers.push({
    paper_id: paper.id,
    paper_id_namespace: paper.namespace,
    title,
    journal: text(descendants(article, "journal-title")[0]) || null,
    publication_date: null,
    authors: descendants(article, "contrib")
      .map((contributor) => text(contributor))
      .filter(Boolean),
    source_url: null,
    source_id: output.sources[0]!.source_id,
  });
  return output;
}

/** Fixed server-owned BioC/JATS XML transform. It never executes document-provided code. */
export function transformBioCLiteratureEvidence(input: BioCLiteratureTransformInput): BioCLiteratureCanonicalTables {
  if (!/^asset_[0-9a-f]{64}$/.test(input.assetId)) throw new TypeError("assetId must be content addressed");
  // 对象树闸门：整个 BioC 文档会被建成 JS 对象树（膨胀可达源文件 10 倍以上），
  // 超大载体曾把 Node 堆撑到 OOM 崩溃（2026-08-29 gold9 事故）。
  if (input.bytes.length > MAX_XML_CARRIER_BYTES) {
    throw new TypeError(
      `BioC XML carrier exceeded ${MAX_XML_CARRIER_BYTES} byte parse limit (${input.bytes.length} bytes); ` +
        "the full object tree would expand ~10x in memory — use a narrower extract or a streaming/sharded parser instead",
    );
  }
  const validation = XMLValidator.validate(input.bytes.toString("utf8"));
  if (validation !== true) throw new TypeError("malformed BioC XML");
  const root = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    trimValues: true,
    processEntities: true,
  }).parse(input.bytes.toString("utf8")) as unknown;
  const article = children(root, "article")[0];
  if (article !== undefined) {
    return parseJatsArticle(input, article, input.sourceDatabase?.trim() || "europe_pmc");
  }
  const collection = children(root, "collection")[0] ?? root;
  const sourceDatabase = input.sourceDatabase?.trim() || firstText(collection, "source") || "bioc";
  const documents = children(collection, "document");
  if (documents.length === 0) throw new TypeError("BioC collection contains no document");
  const output: BioCLiteratureCanonicalTables = { literature_evidence: [], papers: [], sources: [] };
  documents.forEach((document, documentIndex) => {
    const parsed = parseDocument({ input, document, documentIndex, sourceDatabase });
    output.literature_evidence.push(...parsed.literature_evidence);
    output.papers.push(...parsed.papers);
    output.sources.push(...parsed.sources);
  });
  return output;
}
