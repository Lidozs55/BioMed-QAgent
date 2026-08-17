/**
 * UCSC Xena public hub helpers (Python
 * ``skills/builtin/acquisition/xena.py`` parity).
 *
 * The dataset index is fetched from the official hub query API
 * (``POST https://toil.xenahubs.net/data/`` with a Clojure-style text/plain
 * body) and falls back to the S3 ListObjectsV2 XML listing when the query
 * endpoint fails. Downloads never happen here — they route through
 * ``acquireSource`` (P5-D3), whose curated allowlist already contains the S3
 * hub host.
 *
 * Policy deviation (documented): ``toil.xenahubs.net`` is not part of
 * ``CURATED_SOURCE_HOSTS`` (only the S3 download host is curated). The search
 * index egress validates against ``XENA_SEARCH_HOSTS`` at this layer, exactly
 * as the Python crawler facade did for its ``api`` path. Downloads still go
 * through the curated allowlist via ``acquireSource``.
 */

import type { AddressResolver } from "../network/dns.js";
import { PublicHttpClient, validateCuratedSourceUrl } from "../network/http-client.js";
import { BROWSER_UA } from "../gdc/api.js";

export const XENA_HUB_BASE = "https://toil-xena-hub.s3.us-east-1.amazonaws.com";
export const XENA_DOWNLOAD_BASE = `${XENA_HUB_BASE}/download`;
/** Official Xena hub query endpoint (replaces the S3 listing, which the
 * bucket policy denies with HTTP 403). */
export const XENA_QUERY_URL = "https://toil.xenahubs.net/data/";
/** ``allDatasets.xq`` — name + type for every dataset on the hub. */
export const XENA_QUERY_ALL_DATASETS =
  "(fn [] (query {:select [:name :type] :from [:dataset]}))";
/** POST body: the all-datasets query wrapped in parens (Python parity). */
export const XENA_QUERY_BODY = `(${XENA_QUERY_ALL_DATASETS} )`;

/** Search-index egress hosts: official query API + S3 fallback listing. */
export const XENA_SEARCH_HOSTS: ReadonlySet<string> = new Set([
  "toil.xenahubs.net",
  "toil-xena-hub.s3.us-east-1.amazonaws.com",
]);

export interface XenaRequestOptions {
  resolve?: AddressResolver;
  signal?: AbortSignal;
  timeoutMs?: number;
  connectTimeoutMs?: number;
  /** Enforced once before every external request (Python ``rate_limit``). */
  rateLimit?: () => Promise<void>;
}

// Known dataset type patterns for categorization (Python
// ``_DATASET_TYPE_PATTERNS``, ordered the same way).
const DATASET_TYPE_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["gene_expression", /gene.?expr|HiSeq|RNA.?seq|fpkm|tpm|rsem/i],
  ["clinical", /clinical|phenotype|survival|follow.?up/i],
  ["mutation", /mutation|mutect|varscan|muse|somaticsniper/i],
  ["copy_number", /copy.?number|cnv|gistic|seg/i],
  ["methylation", /methylation|hm450|hm27|450k/i],
  ["mirna", /miRNA|mirna|mirseq/i],
  ["protein", /protein|rppa|proteome/i],
  ["somatic_mutation", /masked.?somatic/i],
  ["pathway", /pathway|paradi[gm]/i],
  ["signature", /signature|stemness|immune/i],
  ["fusion", /fusion|star.?fusion/i],
  ["immune", /immune|lymphocyte|leukocyte|stromal/i],
];

/** Official hub query row types (Python ``_XENA_TYPE_MAP``). */
const XENA_TYPE_MAP: Readonly<Record<string, string>> = {
  genomicMatrix: "gene_expression",
  clinicalMatrix: "clinical",
  phenotypeMatrix: "clinical",
  sparseMatrix: "mutation",
  segmented: "copy_number",
  probeMap: "probe_map",
  genePredExt: "gene_model",
};

export interface XenaHubRecord {
  dataset_id: string;
  name: string;
  type: string;
  cohort: string;
  size_bytes: number;
  last_modified: string;
}

/** Infer a dataset type label from its name (Python ``_classify_dataset_type``). */
export function classifyXenaDatasetType(name: string): string {
  for (const [label, pattern] of DATASET_TYPE_PATTERNS) {
    if (pattern.test(name)) return label;
  }
  return "other";
}

/** Extract a cohort/project identifier from a dataset name. */
export function extractXenaCohort(name: string): string {
  let match = /^(TCGA\.[A-Z0-9]+)/i.exec(name);
  if (match !== null) return match[1].toUpperCase();
  match = /^(TARGET[-_][A-Z0-9]+)/i.exec(name);
  if (match !== null) return match[1].toUpperCase();
  match = /^(GTEx)/i.exec(name);
  if (match !== null) return "GTEx";
  match = /^([A-Za-z0-9_-]+)/.exec(name);
  if (match !== null) return match[1].toUpperCase();
  return "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Map one official hub query row (``name`` + ``type``) to a record. */
export function xenaHubRecordFromRow(row: unknown): XenaHubRecord {
  if (!isRecord(row)) throw new TypeError("hub query row is not an object");
  const name = String(row["name"] ?? "").trim();
  if (name === "") throw new Error("hub query row missing dataset name");
  let datasetId = name;
  for (const extension of [".gz", ".tsv", ".json"]) {
    if (datasetId.endsWith(extension)) {
      datasetId = datasetId.slice(0, -extension.length);
      break;
    }
  }
  const rawType = String(row["type"] ?? "").trim();
  return {
    dataset_id: datasetId,
    name,
    type: XENA_TYPE_MAP[rawType] ?? classifyXenaDatasetType(name),
    cohort: extractXenaCohort(name),
    size_bytes: 0,
    last_modified: "",
  };
}

/** Parse the official hub ``all-datasets`` JSON response into records. */
export function xenaHubRecordsFromQueryJson(content: string): XenaHubRecord[] {
  const rows = JSON.parse(content) as unknown;
  if (!Array.isArray(rows)) {
    throw new Error("hub query response is not a JSON array");
  }
  return rows.filter(isRecord).map((row) => xenaHubRecordFromRow(row));
}

/** S3 ListObjectsV2 listing URL (Python ``_hub_list_url``). */
export function xenaHubListUrl(continuationToken?: string): string {
  const params = new URLSearchParams({
    "list-type": "2",
    prefix: "download/",
    "max-keys": "1000",
  });
  if (continuationToken !== undefined) {
    params.set("continuation-token", continuationToken);
  }
  return `${XENA_HUB_BASE}/?${params.toString()}`;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function xmlText(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(block);
  return match === null ? null : decodeXmlEntities(match[1]);
}

/**
 * Parse one S3 ListBucketResult page into records and return the next
 * continuation token (Python ``_parse_hub_page``). A minimal XML reader is
 * used instead of ElementTree — Node has no built-in XML parser and no new
 * dependency is permitted; the fixture covers the exact S3 response shape.
 */
export function parseXenaHubPage(
  xml: string,
): { records: XenaHubRecord[]; nextToken: string | null } {
  const records = new Map<string, XenaHubRecord>();
  const contents = /<Contents>([\s\S]*?)<\/Contents>/g;
  for (const match of xml.matchAll(contents)) {
    const block = match[1];
    const key = xmlText(block, "Key");
    if (key === null || key === "" || key.endsWith("/")) continue;

    let datasetId = key.startsWith("download/") ? key.slice("download/".length) : key;
    if (datasetId.endsWith(".gz")) datasetId = datasetId.slice(0, -3);

    const lower = datasetId.toLowerCase();
    if (lower === "hub.txt" || lower === "genomes.txt" || lower === "hub.json" || lower === "index.html") {
      continue;
    }

    let name = datasetId;
    for (const extension of [".tsv", ".json"]) {
      if (name.endsWith(extension)) {
        name = name.slice(0, -extension.length);
        break;
      }
    }

    const sizeText = xmlText(block, "Size");
    const sizeBytes =
      sizeText !== null && sizeText !== "" ? Number.parseInt(sizeText, 10) : 0;
    const lastModified = xmlText(block, "LastModified") ?? "";

    records.set(datasetId, {
      dataset_id: datasetId,
      name,
      type: classifyXenaDatasetType(name),
      cohort: extractXenaCohort(name),
      size_bytes: sizeBytes,
      last_modified: lastModified,
    });
  }

  const isTruncated = xmlText(xml, "IsTruncated") === "true";
  const nextToken = xmlText(xml, "NextContinuationToken");
  return {
    records: [...records.values()],
    nextToken: isTruncated && nextToken !== null && nextToken !== "" ? nextToken : null,
  };
}

async function fetchXenaText(
  client: PublicHttpClient,
  url: string,
  method: "GET" | "POST",
  options: XenaRequestOptions,
): Promise<string> {
  await options.rateLimit?.();
  const resolve = options.resolve ?? client.resolve;
  await validateCuratedSourceUrl(url, XENA_SEARCH_HOSTS, resolve);
  // Python parity: the query POST sends Accept + Content-Type; the S3
  // listing GET sends only the User-Agent.
  const headers: Record<string, string> = { "User-Agent": BROWSER_UA };
  if (method === "POST") {
    headers["Content-Type"] = "text/plain";
    headers["Accept"] = "application/json";
  }
  const response = await client.request(url, {
    method,
    headers,
    body: method === "POST" ? XENA_QUERY_BODY : undefined,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    connectTimeoutMs: options.connectTimeoutMs,
    validateUrl: async (value) => {
      await validateCuratedSourceUrl(value, XENA_SEARCH_HOSTS, resolve);
    },
  });
  if (response.status < 200 || response.status >= 300) {
    await response.discard();
    throw new Error(`Xena hub returned HTTP ${response.status}`);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of response.body) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** Fetch the dataset index from the official hub query API. */
export async function fetchXenaHubIndexViaQuery(
  client: PublicHttpClient,
  options: XenaRequestOptions = {},
): Promise<XenaHubRecord[]> {
  const content = await fetchXenaText(client, XENA_QUERY_URL, "POST", options);
  return xenaHubRecordsFromQueryJson(content);
}

/** Fetch the dataset index via the S3 ListObjectsV2 XML listing (fallback). */
export async function fetchXenaHubIndexViaS3(
  client: PublicHttpClient,
  options: XenaRequestOptions = {},
): Promise<XenaHubRecord[]> {
  const records = new Map<string, XenaHubRecord>();
  let continuationToken: string | undefined;
  for (;;) {
    const content = await fetchXenaText(
      client,
      xenaHubListUrl(continuationToken),
      "GET",
      options,
    );
    const page = parseXenaHubPage(content);
    for (const record of page.records) records.set(record.dataset_id, record);
    if (page.nextToken === null) break;
    continuationToken = page.nextToken;
  }
  return [...records.values()];
}

/** Fetch the Xena dataset index: query API first, S3 listing as fallback. */
export async function fetchXenaHubIndex(
  client: PublicHttpClient,
  options: XenaRequestOptions = {},
): Promise<XenaHubRecord[]> {
  try {
    return await fetchXenaHubIndexViaQuery(client, options);
  } catch {
    return await fetchXenaHubIndexViaS3(client, options);
  }
}

/** Term matches dataset name, type, cohort, or ID (Python ``_match_term``). */
export function matchXenaRecord(record: XenaHubRecord, term: string): boolean {
  const lowerTerm = term.toLowerCase();
  for (const field of ["name", "type", "cohort", "dataset_id"] as const) {
    if (String(record[field]).toLowerCase().includes(lowerTerm)) return true;
  }
  return false;
}

/**
 * Build the canonical download URL: ``{dataset_id}.gz`` (never
 * ``{dataset_id}.tsv.gz``). URL-encoded inputs (``%2F``) are normalized via
 * percent-decoding so both forms work.
 */
export function buildXenaDownloadUrl(datasetId: string): string {
  let normalized: string;
  try {
    normalized = decodeURIComponent(datasetId);
  } catch {
    normalized = datasetId;
  }
  const baseId = normalized.endsWith(".gz") ? normalized.slice(0, -3) : normalized;
  return `${XENA_DOWNLOAD_BASE}/${baseId}.gz`;
}

/** Local filename for a remote ``{dataset_id}.gz`` (slashes flattened). */
export function xenaLocalFilename(remoteFilename: string): string {
  return remoteFilename.replace(/\//g, "_");
}

/** Output path for the decompressed file (Python ``_decompress_gz``). */
export function xenaDecompressedPath(gzPath: string): string {
  return gzPath.replace(/\.gz$/, "");
}
