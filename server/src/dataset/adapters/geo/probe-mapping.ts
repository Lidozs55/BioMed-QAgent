/**
 * Probe → gene mapping for the V2 build chain (P5-04; Python
 * ``app/datasets/build/probe_mapping.py`` + the table parser shared with
 * ``app/pipeline/processing/geo_annotation.py`` parity).
 *
 * GEO platform annotation tables (SOFT ``!platform_table_begin`` /
 * ``!platform_table_end`` blocks) map probe IDs to gene identifiers.  This
 * module parses a local annotation asset (gzip or plain text), computes the
 * probe-level mapping statistics (distinct probes, never gene×sample rows)
 * and emits:
 *
 * - the probe → gene map consumed by the canonicalizer (mapped rows are
 *   re-namespaced to the target gene namespace; unmapped rows stay
 *   ``geo_probe``),
 * - one ``ProbeMappingSummary`` per binding/platform (feeds the coverage
 *   policy: gene-required builds need coverage 1.0; probe-level builds warn),
 * - a per-binding mapping-detail audit CSV
 *   (``canonical/<binding_id>_probe_mapping.csv``) with the D3 columns.
 *
 * The TS canonicalizer already consumes ``probeMap`` /
 * ``probeTargetNamespace`` (see ``src/dataset/canonicalizer/canonicalizer.ts``).
 *
 * TODO (M2 executor integration owner): the Python expression runner guards
 * the mapping with two typed rejections before calling this module — for a
 * series_matrix binding without complete ``!Sample_platform_id`` evidence
 * (``BindingRejectedError`` reason_code ``missing_sample_platform_evidence``)
 * and for a binding declaring multiple GPL platforms with one unsplit
 * mapping asset (reason_code ``ambiguous_multi_platform_mapping``) — and
 * emits a ``not_attempted`` ProbeMappingSummary when a probe-declaring
 * binding has no annotation asset.  The TS executor skeleton
 * (``src/dataset/runtime/executor.ts``) is not wired to operations yet; the
 * runtime integration owner must apply those guards in the canonicalize
 * operation handler before calling ``buildProbeMapping``.
 */

import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { gunzip as gunzipCb } from "node:zlib";
import path from "node:path";

const gunzip = promisify(gunzipCb);

import { CHECKPOINT_STRIDE, checkpoint, throwIfAborted } from "../../cooperative.js";
import { AdapterError } from "../errors.js";
import { sha256FileStream } from "../hashing.js";
import { BufferedCsvWriter } from "../base.js";
import { delimitedRowsFromFileAsync } from "../text.js";
import type { SourceAsset } from "../../contracts/source.js";
import { ProbeIndex } from "./probe-index.js";

/** Stable server-side mapping rule id (D3 ``mapping_rule_id``). */
export const PROBE_MAPPING_RULE_ID = "geo.probe-map.v1";

/** D3 mapping-detail audit CSV columns. */
export const MAPPING_DETAIL_COLUMNS = [
  "binding_id",
  "platform_id",
  "probe_id",
  "target_gene_id",
  "target_namespace",
  "status",
  "evidence_asset_id",
  "rule_id",
] as const;

/** D3 ``ProbeMappingStatus`` vocabulary (Python StrEnum). */
export type ProbeMappingStatus =
  | "mapped"
  | "partial"
  | "unmapped"
  | "no_gene_annotation"
  | "annotation_unavailable"
  | "not_attempted";

/** D3 ``AnnotationStatus`` vocabulary (Python StrEnum). */
export type AnnotationStatus =
  | "mapped"
  | "unmapped"
  | "no_gene_annotation"
  | "annotation_unavailable"
  | "not_attempted";

export type TargetNamespace = "gene_symbol" | "ensembl_gene";

export interface ProbeMappingSummary {
  schema_version: "1.0";
  binding_id: string;
  platform_id: string | null;
  source_namespace: string;
  target_namespace: TargetNamespace | null;
  mapping_status: ProbeMappingStatus;
  total_probe_count: number;
  mapped_probe_count: number;
  unmapped_probe_count: number;
  ambiguous_probe_count: number;
  coverage_ratio: number;
  mapping_asset_id: string | null;
  mapping_rule_id: string | null;
}

/** D3 ``PlatformRecord`` (F4: one per GPL attempt). */
export interface PlatformRecord {
  schema_version: "1.0";
  platform_id: string;
  source_id: string;
  annotation_asset_id: string | null;
  organism: string | null;
  annotation_status: AnnotationStatus;
  probe_id_field: string | null;
  gene_id_field: string | null;
  target_namespace: TargetNamespace | null;
  mapping_source_url: string | null;
  annotation_sha256: string | null;
}

/** Parsed SOFT platform table (shared V1/V2 parser). */
export interface SoftPlatformTable {
  probe_column: string | null;
  gene_column: string | null;
  rows: ReadonlyArray<readonly [string, string]>;
  has_table: boolean;
}

export interface ProbeMappingResult {
  /** Materialized full map; present only when ``materializeProbeMap`` is set. */
  probe_to_gene?: Record<string, string>;
  /** Disk-backed index retained for canonicalizer lookups (caller destroys). */
  probe_index: ProbeIndex;
  target_namespace: TargetNamespace;
  summary: ProbeMappingSummary;
  detail_path: string;
  platform_record: PlatformRecord | null;
}

/**
 * F2 (D3 bidirectional invariant): the declared annotation sha256 does not
 * match the file actually parsed.
 */
export class ProbeMappingAssetMismatchError extends AdapterError {
  constructor(message: string) {
    super(message);
    this.name = "ProbeMappingAssetMismatchError";
  }
}

//: Gene-identifier columns in SOFT platform tables, best first (Python
//: ``_GENE_COLUMN_PRIORITY``).
const GENE_COLUMN_PRIORITY = [
  "GENE_SYMBOL",
  "GENE_NAME",
  "REFSEQ",
  "GB_ACC",
  "ENSEMBL_ID",
  "UNIGENE_ID",
  "LOCUSLINK_ID",
  "TIGR_ID",
  "ENTREZ_GENE_ID",
] as const;

const MISSING_SENTINELS: ReadonlySet<string> = new Set([
  "",
  "---",
  "null",
  "NA",
  "NaN",
]);

function stripSoftField(value: string): string {
  return value.trim().replace(/^"+|"+$/g, "");
}

/** Gene column of a SOFT table header, best first (shared by all parsers). */
function findGeneColumn(header: readonly string[]): string | null {
  for (const candidate of GENE_COLUMN_PRIORITY) {
    if (header.includes(candidate)) return candidate;
  }
  return null;
}

/** Split a SOFT table row exactly like the shared text parser. */
function splitSoftRow(line: string): string[] {
  return line.split("\t").map(stripSoftField);
}

/** SOFT ``^PLATFORM`` mini-format fallback (no ``!platform_table_*`` markers). */
function parseSoftPlatformTable(lines: string[]): SoftPlatformTable {
  let platformIndex: number | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim().toLowerCase().startsWith("^platform")) {
      platformIndex = index;
      break;
    }
  }
  if (platformIndex === null) {
    return { probe_column: null, gene_column: null, rows: [], has_table: false };
  }
  let headerIndex: number | null = null;
  for (let index = platformIndex + 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === "") continue;
    if (line.startsWith("#") || line.startsWith("!")) continue;
    headerIndex = index;
    break;
  }
  if (headerIndex === null) {
    return { probe_column: null, gene_column: null, rows: [], has_table: false };
  }
  const header = lines[headerIndex].split("\t").map(stripSoftField);
  if (header.length === 0) {
    return { probe_column: null, gene_column: null, rows: [], has_table: true };
  }
  const geneColumn = findGeneColumn(header);
  const geneIndex = geneColumn !== null ? header.indexOf(geneColumn) : null;
  const rows: Array<[string, string]> = [];
  if (geneIndex !== null) {
    for (let index = headerIndex + 1; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (line === "") continue;
      if (line.startsWith("^") || line.startsWith("!")) break;
      const values = lines[index].split("\t").map(stripSoftField);
      if (values.length <= geneIndex) continue;
      const probe = values[0];
      const gene = values[geneIndex];
      if (probe !== "" && !MISSING_SENTINELS.has(gene)) {
        rows.push([probe, gene]);
      }
    }
  }
  return {
    probe_column: header[0],
    gene_column: geneColumn,
    rows,
    has_table: true,
  };
}

/** Python ``parse_platform_table_text`` (geo_annotation.py shared parser). */
export function parsePlatformTableText(text: string): SoftPlatformTable {
  const lines = text.split(/\r\n|\n|\r/);
  let begin: number | null = null;
  let end: number | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const marker = lines[index].trim().toLowerCase();
    if (marker === "!platform_table_begin") {
      begin = index;
    } else if (marker === "!platform_table_end" && begin !== null) {
      end = index;
      break;
    }
  }
  if (begin === null || end === null || end <= begin + 1) {
    return parseSoftPlatformTable(lines);
  }
  const header = lines[begin + 1].split("\t").map(stripSoftField);
  if (header.length === 0) {
    return { probe_column: null, gene_column: null, rows: [], has_table: true };
  }
  const geneColumn = findGeneColumn(header);
  const geneIndex = geneColumn !== null ? header.indexOf(geneColumn) : null;
  const rows: Array<[string, string]> = [];
  if (geneIndex !== null) {
    for (let index = begin + 2; index < end; index += 1) {
      const values = lines[index].split("\t").map(stripSoftField);
      if (values.length <= geneIndex) continue;
      const probe = values[0];
      const gene = values[geneIndex];
      if (probe !== "" && !MISSING_SENTINELS.has(gene)) {
        rows.push([probe, gene]);
      }
    }
  }
  return {
    probe_column: header[0],
    gene_column: geneColumn,
    rows,
    has_table: true,
  };
}

/** Python ``_read_table``: gzip or plain UTF-8, fail-closed (cooperative). */
async function readTable(annotationPath: string, signal?: AbortSignal | null): Promise<string> {
  throwIfAborted(signal);
  const raw = await readFile(annotationPath);
  try {
    return (await gunzip(raw)).toString("utf8");
  } catch {
    return raw.toString("utf8");
  }
}

export interface ParsedPlatformTable {
  mapping: Record<string, string>;
  target_namespace: TargetNamespace;
  status: ProbeMappingStatus;
  ambiguous_probes: ReadonlySet<string>;
  probe_column: string | null;
  gene_column: string | null;
}

/** Python ``parse_platform_table``. */
export async function parsePlatformTable(
  annotationPath: string,
  signal?: AbortSignal | null,
): Promise<ParsedPlatformTable> {
  const text = await readTable(annotationPath, signal);
  const table = parsePlatformTableText(text);
  if (!table.has_table || table.gene_column === null) {
    return {
      mapping: {},
      target_namespace: "gene_symbol",
      status: "no_gene_annotation",
      ambiguous_probes: new Set(),
      probe_column: table.probe_column,
      gene_column: table.gene_column,
    };
  }
  const targetNamespace =
    table.gene_column === "ENSEMBL_ID" ? "ensembl_gene" : "gene_symbol";
  const targets = new Map<string, Set<string>>();
  for (const [probe, gene] of table.rows) {
    const genes = targets.get(probe) ?? new Set<string>();
    genes.add(gene);
    targets.set(probe, genes);
  }
  const ambiguousProbes = new Set<string>();
  const mapping: Record<string, string> = {};
  for (const [probe, genes] of targets) {
    if (genes.size > 1) {
      ambiguousProbes.add(probe);
      continue;
    }
    const onlyGene = [...genes][0];
    mapping[probe] = onlyGene;
  }
  if (Object.keys(mapping).length === 0) {
    return {
      mapping: {},
      target_namespace: targetNamespace,
      status: "unmapped",
      ambiguous_probes: ambiguousProbes,
      probe_column: table.probe_column,
      gene_column: table.gene_column,
    };
  }
  return {
    mapping,
    target_namespace: targetNamespace,
    status: "mapped",
    ambiguous_probes: ambiguousProbes,
    probe_column: table.probe_column,
    gene_column: table.gene_column,
  };
}

/** Result of ingesting the annotation table into a probe index. */
export interface IngestedPlatformTable {
  probe_column: string | null;
  gene_column: string | null;
  target_namespace: TargetNamespace;
  table_status: ProbeMappingStatus;
}

/**
 * Detect the ``!platform_table_begin`` / ``!platform_table_end`` block bounds
 * (last begin, first end after it), mirroring ``parsePlatformTableText``.
 * Returns null when no valid marked block exists (130n-format / SOFT fallback
 * cases that must go through the full-memory parser).
 */
async function scanPlatformTableBounds(
  annotationPath: string,
  signal?: AbortSignal | null,
): Promise<{ beginLine: number; endLine: number } | null> {
  let beginLine: number | null = null;
  let endLine: number | null = null;
  for await (const { line, lineText } of delimitedRowsFromFileAsync(
    annotationPath,
    "\t",
    signal,
    { includeLineText: true },
  )) {
    const marker = lineText !== undefined ? lineText.trim().toLowerCase() : "";
    if (marker === "!platform_table_begin") {
      beginLine = line;
    } else if (marker === "!platform_table_end" && beginLine !== null) {
      endLine = line;
      break;
    }
  }
  if (beginLine === null || endLine === null || endLine <= beginLine + 1) {
    return null;
  }
  return { beginLine, endLine };
}

/**
 * Stream the annotation into ``index`` using the ``!platform_table_*`` block,
 * avoiding full-text materialization for large platform files. Returns null
 * when the file has no valid marked block (caller falls back to the reference
 * parser). Row splitting exactly mirrors ``parsePlatformTableText``.
 */
async function ingestPlatformTable(
  annotationPath: string,
  index: ProbeIndex,
  signal?: AbortSignal | null,
): Promise<IngestedPlatformTable | null> {
  const bounds = await scanPlatformTableBounds(annotationPath, signal);
  if (bounds === null) return null;
  const header: string[] = [];
  for await (const { line, lineText } of delimitedRowsFromFileAsync(
    annotationPath,
    "\t",
    signal,
    { includeLineText: true },
  )) {
    if (line !== bounds.beginLine + 1) continue;
    header.push(...splitSoftRow(lineText ?? ""));
    break;
  }
  const gene_column = findGeneColumn(header);
  const gene_index = gene_column !== null ? header.indexOf(gene_column) : null;
  const target_namespace: TargetNamespace =
    gene_column === "ENSEMBL_ID" ? "ensembl_gene" : "gene_symbol";
  let rowCount = 0;
  if (gene_index !== null) {
    for await (const { line, lineText } of delimitedRowsFromFileAsync(
      annotationPath,
      "\t",
      signal,
      { includeLineText: true },
    )) {
      if (line <= bounds.beginLine + 1) continue;
      if (line >= bounds.endLine) break;
      const values = splitSoftRow(lineText ?? "");
      if (values.length <= gene_index) continue;
      const probe = values[0];
      const gene = values[gene_index];
      if (probe !== "" && !MISSING_SENTINELS.has(gene)) {
        await index.put(probe, gene);
        rowCount += 1;
        if (rowCount % CHECKPOINT_STRIDE === 0) await checkpoint(signal);
      }
    }
  }
  const table_status: ProbeMappingStatus =
    gene_column === null ? "no_gene_annotation" : rowCount > 0 ? "mapped" : "unmapped";
  return {
    probe_column: header.length > 0 ? header[0] : null,
    gene_column,
    target_namespace,
    table_status,
  };
}

/**
 * Ingest the annotation into ``index``: the streaming path when a valid
 * marked block exists, otherwise the bounded-memory reference parse
 * (``readTable`` + ``parsePlatformTableText``). Both paths yield identical
 * probe → gene rows, so the index collapses to the same classification.
 */
async function ingestProbeIndex(
  annotationPath: string,
  index: ProbeIndex,
  signal?: AbortSignal | null,
): Promise<IngestedPlatformTable> {
  const streamed = await ingestPlatformTable(annotationPath, index, signal);
  if (streamed !== null) return streamed;
  const text = await readTable(annotationPath, signal);
  const table = parsePlatformTableText(text);
  const target_namespace: TargetNamespace =
    table.gene_column === "ENSEMBL_ID" ? "ensembl_gene" : "gene_symbol";
  let rowCount = 0;
  for (const [probe, gene] of table.rows) {
    await index.put(probe, gene);
    rowCount += 1;
  }
  const table_status: ProbeMappingStatus =
    table.gene_column === null ? "no_gene_annotation" : rowCount > 0 ? "mapped" : "unmapped";
  return {
    probe_column: table.probe_column,
    gene_column: table.gene_column,
    target_namespace,
    table_status,
  };
}

/** Python ``_distinct_probes``: declared ``geo_probe`` rows of the batch. */
async function distinctProbes(batchPath: string, signal?: AbortSignal | null): Promise<string[]> {
  let header: string[] | null = null;
  let namespaceIndex = -1;
  let probeIndex = -1;
  const probes = new Set<string>();
  let visited = 0;
  for await (const { values } of delimitedRowsFromFileAsync(batchPath, ",", signal)) {
    if (header === null) {
      header = values;
      namespaceIndex = header.indexOf("gene_id_namespace_declared");
      probeIndex = header.indexOf("gene_id_raw");
      continue;
    }
    const namespace = values[namespaceIndex] ?? "";
    if (namespace.trim() === "geo_probe") {
      const probe = (values[probeIndex] ?? "").trim();
      if (probe !== "") probes.add(probe);
    }
    visited += 1;
    if (visited % CHECKPOINT_STRIDE === 0) await checkpoint(signal);
  }
  return [...probes].sort();
}

/** Python ``_platform_annotation_status``. */
function platformAnnotationStatus(
  mappingStatus: ProbeMappingStatus,
  tableStatus: ProbeMappingStatus,
): AnnotationStatus {
  if (mappingStatus === "mapped" || mappingStatus === "partial") return "mapped";
  if (tableStatus === "no_gene_annotation") return "no_gene_annotation";
  return "unmapped";
}

/** Python ``_build_platform_record``. */
async function buildPlatformRecord(options: {
  platformId: string;
  sourceId: string;
  annotationPath: string;
  probeColumn: string | null;
  geneColumn: string | null;
  targetNamespace: TargetNamespace | null;
  annotationStatus: AnnotationStatus;
  annotationAsset: SourceAsset | null;
  signal?: AbortSignal | null;
}): Promise<PlatformRecord> {
  const { annotationStatus, annotationAsset, signal } = options;
  return {
    schema_version: "1.0",
    platform_id: options.platformId,
    source_id: options.sourceId,
    annotation_asset_id: annotationAsset?.asset_id ?? null,
    organism: null,
    annotation_status: annotationStatus,
    probe_id_field: options.probeColumn,
    gene_id_field:
      annotationStatus === "mapped" ? options.geneColumn : null,
    target_namespace:
      annotationStatus === "mapped" ? options.targetNamespace : null,
    mapping_source_url: null,
    annotation_sha256:
      annotationStatus === "not_attempted"
        ? null
        : await sha256FileStream(options.annotationPath, signal),
  };
}

export interface BuildProbeMappingOptions {
  annotationPath: string;
  batchPath: string;
  bindingId: string;
  platformId: string | null;
  annotationAsset?: SourceAsset | null;
  outputDir: string;
  mappingRuleId?: string;
  sourceId?: string | null;
  /**
   * When true, the result also carries the materialized full ``probe_to_gene``
   * Record (default). When false, the disk-backed ``probe_index`` is returned
   * without materializing the map, keeping peak memory flat.
   */
  materializeProbeMap?: boolean;
  /** Cooperative abort signal from the executor (M2 I-03/I-04). */
  signal?: AbortSignal | null;
}

/** Python ``build_probe_mapping``. */
export async function buildProbeMapping(
  options: BuildProbeMappingOptions,
): Promise<ProbeMappingResult> {
  const {
    annotationPath,
    batchPath,
    bindingId,
    platformId,
    annotationAsset = null,
    outputDir,
    mappingRuleId = PROBE_MAPPING_RULE_ID,
    sourceId = null,
    materializeProbeMap = true,
    signal,
  } = options;
  if (annotationAsset !== null) {
    const actual = await sha256FileStream(annotationPath, signal);
    if (annotationAsset.sha256 !== actual) {
      throw new ProbeMappingAssetMismatchError(
        `annotation asset ${annotationAsset.asset_id} sha256 does not ` +
          `match the parsed file (${annotationPath}): declared ` +
          `${annotationAsset.sha256}, actual ${actual}`,
      );
    }
  }
  const probeIndex = ProbeIndex.create(
    path.join(outputDir, `probe_index_${bindingId}`),
  );
  try {
    const {
      probe_column: probeColumn,
      gene_column: geneColumn,
      target_namespace: targetNamespace,
      table_status: tableStatus,
    } = await ingestProbeIndex(annotationPath, probeIndex, signal);
    const probes = await distinctProbes(batchPath, signal);
    const total = probes.length;
    const resolutions = await probeIndex.bulkResolve(probes);
    let mapped = 0;
    const ambiguousProbes = new Set<string>();
    for (let offset = 0; offset < resolutions.length; offset += 1) {
      if (resolutions[offset].kind === "mapped") mapped += 1;
      else if (resolutions[offset].kind === "ambiguous") {
        ambiguousProbes.add(probes[offset]);
      }
    }
    const ambiguousCount = ambiguousProbes.size;
    const unmapped = total - mapped;
    const coverage = total > 0 ? mapped / total : 0.0;
    let status: ProbeMappingStatus;
    if (total > 0 && mapped === total) {
      status = "mapped";
    } else if (total > 0 && mapped > 0) {
      status = "partial";
    } else if (
      tableStatus === "no_gene_annotation" ||
      tableStatus === "unmapped"
    ) {
      status = tableStatus;
    } else {
      status = "unmapped";
    }

    const detailPath = path.join(
      outputDir,
      "canonical",
      `${bindingId}_probe_mapping.csv`,
    );
    mkdirSync(path.dirname(detailPath), { recursive: true });
    const writer = new BufferedCsvWriter(detailPath, [...MAPPING_DETAIL_COLUMNS]);
    let visited = 0;
    for (let offset = 0; offset < probes.length; offset += 1) {
      const probe = probes[offset];
      const resolution = resolutions[offset];
      const gene = resolution.kind === "mapped" ? resolution.gene : "";
      const rowStatus = gene
        ? "mapped"
        : resolution.kind === "ambiguous"
          ? "ambiguous"
          : "unmapped";
      writer.writeRow([
        bindingId,
        platformId ?? "",
        probe,
        gene,
        gene ? targetNamespace : "",
        rowStatus,
        annotationAsset?.asset_id ?? "",
        gene ? mappingRuleId : "",
      ]);
      visited += 1;
      if (visited % CHECKPOINT_STRIDE === 0) await checkpoint(signal);
    }
    writer.flush();

    const summary: ProbeMappingSummary = {
      schema_version: "1.0",
      binding_id: bindingId,
      platform_id: platformId,
      source_namespace: "geo_probe",
      target_namespace: mapped > 0 ? targetNamespace : null,
      mapping_status: status,
      total_probe_count: total,
      mapped_probe_count: mapped,
      unmapped_probe_count: unmapped,
      ambiguous_probe_count: ambiguousCount,
      coverage_ratio: coverage,
      mapping_asset_id: annotationAsset?.asset_id ?? null,
      mapping_rule_id: mappingRuleId,
    };
    let platformRecord: PlatformRecord | null = null;
    if (platformId !== null) {
      platformRecord = await buildPlatformRecord({
        platformId,
        sourceId:
          sourceId ?? annotationAsset?.source_id ?? bindingId,
        annotationPath,
        probeColumn,
        geneColumn,
        targetNamespace: mapped > 0 ? targetNamespace : null,
        annotationStatus: platformAnnotationStatus(status, tableStatus),
        annotationAsset,
        signal,
      });
    }
    return {
      probe_to_gene: materializeProbeMap
        ? await probeIndex.materialize()
        : undefined,
      probe_index: probeIndex,
      target_namespace: targetNamespace,
      summary,
      detail_path: detailPath,
      platform_record: platformRecord,
    };
  } catch (error) {
    probeIndex.destroy();
    throw error;
  }
}
