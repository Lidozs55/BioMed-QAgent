/**
 * Pure parsers for official PubMed response formats (Python
 * ``app/integrations/ncbi/parsers.py`` parity, PubMed subset).
 *
 * ``parse_ncbi_esearch`` maps the esearch JSON page;
 * ``parse_pubmed_xml`` maps PubMed efetch XML to the stable wire record shape
 * the ``search_pubmed`` tool publishes (Python
 * ``skills/builtin/discovery/pubmed.py`` ``search_pubmed_adapter`` records):
 *
 * ```text
 * { title, abstract, authors, journal, pub_date, doi, pmid, pmcid,
 *   is_open_access, source_url }
 * ```
 *
 * ``authors`` is the ``"; "``-joined author list and ``pub_date`` the ISO date
 * string (empty when unknown) — exactly the JSON the Python adapter returns,
 * so tool output needs no second mapping layer.
 */

import { XMLParser } from "fast-xml-parser";

export interface NcbiSearchPage {
  count: number;
  retmax: number;
  retstart: number;
  ids: string[];
  query_translation: string;
}

export interface PubmedRecord {
  title: string;
  abstract: string;
  /** ``"; "``-joined author names (Python adapter wire shape). */
  authors: string;
  journal: string;
  /** ISO date (``YYYY-MM-DD``) or ``""`` when unknown. */
  pub_date: string;
  doi: string;
  pmid: string;
  pmcid: string;
  is_open_access: boolean;
  source_url: string;
}

// ---------------------------------------------------------------------------
// esearch JSON
// ---------------------------------------------------------------------------

/** Python ``int()`` semantics for defensive JSON fields. */
function strictInt(value: unknown): number {
  const text = String(value).trim();
  if (!/^[+-]?\d+$/.test(text)) {
    throw new TypeError(`invalid literal for int() with base 10: ${JSON.stringify(String(value))}`);
  }
  return Number.parseInt(text, 10);
}

function recordGet(record: Record<string, unknown>, key: string, fallback: unknown): unknown {
  return key in record ? record[key] : fallback;
}

export function parseNcbiEsearch(payload: Buffer): NcbiSearchPage {
  const text = payload.toString("utf8").replace(/^\uFEFF/, "");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new TypeError(`invalid NCBI esearch JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new TypeError("missing esearchresult in NCBI esearch payload");
  }
  const outer = data as Record<string, unknown>;
  const resultValue = outer["esearchresult"];
  if (typeof resultValue !== "object" || resultValue === null || Array.isArray(resultValue)) {
    throw new TypeError("missing esearchresult in NCBI esearch payload");
  }
  const result = resultValue as Record<string, unknown>;
  const count = strictInt(recordGet(result, "count", 0));
  const retmax = strictInt(recordGet(result, "retmax", 0));
  const retstart = strictInt(recordGet(result, "retstart", 0));
  if (count < 0 || retmax < 0 || retstart < 0) {
    throw new TypeError("NcbiSearchPage counts must be >= 0");
  }
  const rawIds = recordGet(result, "idlist", []);
  if (!Array.isArray(rawIds)) throw new TypeError("NCBI search IDs must be numeric UIDs");
  const ids = rawIds.map((value) => String(value));
  if (ids.some((value) => !/^\d+$/.test(value))) {
    throw new TypeError("NCBI search IDs must be numeric UIDs");
  }
  const queryTranslation = recordGet(result, "querytranslation", "");
  return {
    count,
    retmax,
    retstart,
    ids,
    query_translation: typeof queryTranslation === "string" ? queryTranslation : "",
  };
}

// ---------------------------------------------------------------------------
// PubMed efetch XML
// ---------------------------------------------------------------------------

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** Parse an XML document into fast-xml-parser's object tree. */
export function parseXmlDocument(xml: Buffer): unknown {
  const parser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    trimValues: false,
    processEntities: true,
  });
  return parser.parse(xml) as unknown;
}

/** Decode numeric character references (fast-xml-parser only decodes the five
 * named entities; Python's ElementTree also decodes ``&#xNN;`` refs). */
function decodeNumericReferences(value: string): string {
  return value.replace(/&#x([0-9a-fA-F]+);|&#(\d+);/g, (match, hex: string | undefined, dec: string | undefined) => {
    const codePoint = hex !== undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec ?? "", 10);
    if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
    return String.fromCodePoint(codePoint);
  });
}

/** Python ``"".join(element.itertext())`` equivalent. */
function collectText(value: unknown): string {
  if (typeof value === "string") return decodeNumericReferences(value);
  if (Array.isArray(value)) return value.map((item) => collectText(item)).join("");
  if (typeof value === "object" && value !== null) {
    const parts: string[] = [];
    for (const [key, child] of Object.entries(value)) {
      if (key.startsWith("@_")) continue;
      parts.push(collectText(child));
    }
    return parts.join("");
  }
  return "";
}

/** Python ``_element_text``: joined descendant text, stripped. */
function elementText(node: unknown): string {
  if (node === undefined) return "";
  return collectText(node).trim();
}

/** Direct text content of an element (Python ``element.text``). */
export function directText(node: unknown): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map((item) => directText(item)).join("");
  if (typeof node === "object" && node !== null) {
    const text = (node as Record<string, unknown>)["#text"];
    return typeof text === "string" ? text : "";
  }
  return "";
}

export function attribute(node: unknown, name: string): string {
  if (typeof node !== "object" || node === null) return "";
  const value = (node as Record<string, unknown>)[`@_${name}`];
  return typeof value === "string" ? value : "";
}

export function childNode(node: unknown, name: string): unknown {
  if (typeof node !== "object" || node === null) return undefined;
  const value = (node as Record<string, unknown>)[name];
  return value === undefined ? undefined : value;
}

/** Direct children named *name* (single elements are normalized to arrays). */
export function childNodes(node: unknown, name: string): unknown[] {
  const value = childNode(node, name);
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** All descendants named *name* in document order (ElementTree ``.//name``). */
export function findDescendants(node: unknown, name: string): unknown[] {
  const results: unknown[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, child] of Object.entries(value)) {
      if (key.startsWith("@_")) continue;
      if (key === name) results.push(child);
      visit(child);
    }
  };
  visit(node);
  return results;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Python ``datetime.date`` validation + ISO formatting. */
function formatIsoDate(year: number, month: number, day: number): string {
  if (year < 1 || year > 9999) throw new TypeError("year is out of range");
  if (month < 1 || month > 12) throw new TypeError("month must be in 1..12");
  const maxDay = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
  if (day < 1 || day > maxDay) throw new TypeError("day is out of range for month");
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Python ``_publication_date``: PubDate first, then ArticleDate. */
function publicationDate(article: unknown): string | null {
  const medline = childNode(article, "MedlineCitation");
  const articleData = childNode(medline, "Article");
  const journalPubDate = childNode(childNode(childNode(articleData, "Journal"), "JournalIssue"), "PubDate");
  const articleDate = childNode(articleData, "ArticleDate");
  for (const candidate of [journalPubDate, articleDate]) {
    if (candidate === undefined) continue;
    const yearText = elementText(childNode(candidate, "Year"));
    const monthText = elementText(childNode(candidate, "Month"));
    const dayText = elementText(childNode(candidate, "Day"));
    if (!yearText || !monthText || !dayText) continue;
    const month = /^\d+$/.test(monthText)
      ? Number.parseInt(monthText, 10)
      : MONTHS[monthText.slice(0, 3).toLowerCase()];
    if (month === undefined) continue;
    return formatIsoDate(strictInt(yearText), month, strictInt(dayText));
  }
  return null;
}

/** Python ``_authors``: CollectiveName wins, else "ForeName LastName". */
function authors(articleData: unknown): string[] {
  const names: string[] = [];
  for (const authorList of childNodes(articleData, "AuthorList")) {
    for (const author of childNodes(authorList, "Author")) {
      const collective = elementText(childNode(author, "CollectiveName"));
      if (collective !== "") {
        names.push(collective);
        continue;
      }
      const name = [elementText(childNode(author, "ForeName")), elementText(childNode(author, "LastName"))]
        .filter((part) => part !== "")
        .join(" ");
      if (name !== "") names.push(name);
    }
  }
  return names;
}

export function parsePubmedXml(xml: Buffer): PubmedRecord[] {
  const root = parseXmlDocument(xml);
  const records: PubmedRecord[] = [];
  for (const article of childNodes(root, "PubmedArticle")) {
    const medline = childNode(article, "MedlineCitation");
    const articleData = childNode(medline, "Article");
    if (articleData === undefined) continue;
    const pmid = elementText(childNode(medline, "PMID"));
    if (!/^\d+$/.test(pmid)) throw new TypeError("PubMed PMID must be numeric");

    const identifiers = new Map<string, string>();
    const idList = childNode(childNode(article, "PubmedData"), "ArticleIdList");
    if (idList !== undefined) {
      for (const identifier of childNodes(idList, "ArticleId")) {
        const text = directText(identifier).trim();
        if (!text) continue;
        identifiers.set(attribute(identifier, "IdType"), text);
      }
    }
    const pmcid = identifiers.get("pmc") ?? "";
    if (pmcid !== "" && !/^PMC\d+$/.test(pmcid)) {
      throw new TypeError("pmcid must match PMC followed by digits");
    }
    const title = elementText(childNode(articleData, "ArticleTitle"));
    if (title === "") throw new TypeError("title must have at least 1 character");

    const abstractParts = childNodes(articleData, "Abstract")
      .flatMap((abstract) => childNodes(abstract, "AbstractText"))
      .map((part) => elementText(part))
      .filter((part) => part !== "");

    records.push({
      pmid,
      pmcid,
      doi: identifiers.get("doi") ?? "",
      title,
      authors: authors(articleData).join("; "),
      journal: elementText(childNode(childNode(articleData, "Journal"), "Title")),
      pub_date: publicationDate(article) ?? "",
      abstract: abstractParts.join(" "),
      is_open_access: pmcid !== "",
      source_url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    });
  }
  return records;
}

export interface ArticleIdentifiers {
  pmcid: string;
  doi: string;
}

/**
 * Extract PMCID/DOI from a PubMed efetch XML document (Python
 * ``download_supplementary_adapter`` ArticleIdList walk parity: first
 * ``pmc`` and first ``doi`` ArticleId in document order).
 */
export function extractArticleIdentifiers(xml: Buffer): ArticleIdentifiers {
  const root = parseXmlDocument(xml);
  let pmcid = "";
  let doi = "";
  for (const pubmedData of findDescendants(root, "PubmedData")) {
    const idList = childNode(pubmedData, "ArticleIdList");
    if (idList === undefined) continue;
    for (const articleId of childNodes(idList, "ArticleId")) {
      const text = directText(articleId).trim();
      if (!text) continue;
      const idType = attribute(articleId, "IdType");
      if (idType === "pmc" && pmcid === "") pmcid = text;
      if (idType === "doi" && doi === "") doi = text;
    }
  }
  return { pmcid, doi };
}
