/**
 * PDF table extraction (P5-08B, Python ``extract_tables.py`` parity).
 *
 * Tiering (docs/migration/phase5-pdf-spike.md §4.1):
 *
 * 1. pdfjs-dist — ruled-line grid clustering (pdfplumber ``lines`` strategy
 *    subset), then x/y position clustering for unruled tables.
 * 2. Raw-stream regex fallback when pdfjs cannot open the file (malformed
 *    xref / hand-crafted blobs), mirroring Python's no-library tier with the
 *    CJK-aware decoders.
 *
 * Scanned (image-only) PDFs are never silent successes: no text + images
 * yields an explicit warning pointing at ``extract_chart_data_vlm``.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveTaskLocalFile, toTaskRelative } from "../paths.js";
import { openPdf, readPdfBytes, type Line2D, type OpenPdf, type TextItemPosition } from "./pdfjs.js";
import { cleanHeader, detectDelimitedRows, extractTextViaRegex } from "./raw-regex.js";

/** Warning shown when the regex tier recovers data from an unparseable PDF. */
export const REGEX_FALLBACK_WARNING =
  "PDF 解析器无法打开该文件，已回退到正则提取原始流文本，表格检测精度有限。";

/** Warning for image-only PDFs (Python scanned-PDF parity, no OCR by design). */
export const SCANNED_PDF_WARNING =
  "该 PDF 未检测到文本层但包含页面图像（疑似扫描件或图片型 PDF），" +
  "无法提取文本表格。本项目不依赖 OCR；请改用 extract_chart_data_vlm 技能" +
  "（Qwen-VL 视觉模型）从该 PDF/页面图像中提取图表数据。";

export interface RawTable {
  header: string[];
  rows: string[][];
  page: number | null;
}

export interface RawExtraction {
  tables: RawTable[];
  warning: string;
}

export interface PdfTablesOptions {
  /** Absolute task root; outputs land in ``<taskRoot>/parsed/``. */
  taskRoot: string;
}

export interface PdfTablesSummaryTable {
  table_index: number;
  page: number | null;
  row_count: number;
  column_count: number;
  column_names: string[];
  saved_path: string;
}

/** Python error shape: only status / error / source_file. */
export interface PdfTablesError {
  status: "error";
  error: string;
  source_file: string;
}

export interface PdfTablesOk {
  status: "ok";
  source_file: string;
  outputs: string[];
  summary: {
    total_tables: number;
    tables: PdfTablesSummaryTable[];
    failed_count?: number;
  };
  warning?: string;
}

export type PdfTablesResult = PdfTablesOk | PdfTablesError;

const LINE_TOLERANCE = 1.5;

function isHorizontal(line: Line2D): boolean {
  return Math.abs(line.y1 - line.y0) <= LINE_TOLERANCE && Math.abs(line.x1 - line.x0) > LINE_TOLERANCE;
}

function isVertical(line: Line2D): boolean {
  return Math.abs(line.x1 - line.x0) <= LINE_TOLERANCE && Math.abs(line.y1 - line.y0) > LINE_TOLERANCE;
}

function cluster(values: readonly number[], tolerance: number): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const clusters: number[] = [];
  for (const value of sorted) {
    if (clusters.length === 0 || value - clusters[clusters.length - 1] > tolerance) {
      clusters.push(value);
    } else {
      // Merge into the running cluster (average keeps members centered).
      clusters[clusters.length - 1] = (clusters[clusters.length - 1] + value) / 2;
    }
  }
  return clusters;
}

interface GridTable {
  rowYs: number[];
  colXs: number[];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * Find ruled-line grids (pdfplumber ``lines`` strategy subset): horizontal and
 * vertical stroked segments that intersect form one table; each grid needs
 * >= 2 row rules and >= 2 column rules.
 */
function findGrids(lines: readonly Line2D[]): GridTable[] {
  const hLines = lines
    .filter(isHorizontal)
    .map((line) => ({ y: line.y0, minX: Math.min(line.x0, line.x1), maxX: Math.max(line.x0, line.x1) }));
  const vLines = lines
    .filter(isVertical)
    .map((line) => ({ x: line.x0, minY: Math.min(line.y0, line.y1), maxY: Math.max(line.y0, line.y1) }));
  if (hLines.length < 2 || vLines.length < 2) return [];

  const rowYs = cluster(hLines.map((h) => h.y), LINE_TOLERANCE);
  const colXs = cluster(vLines.map((v) => v.x), LINE_TOLERANCE);
  if (rowYs.length < 2 || colXs.length < 2) return [];

  // Union-find: a horizontal and a vertical rule belong to the same table
  // when their spans intersect.
  const count = rowYs.length + colXs.length;
  const parent = Array.from({ length: count }, (_, index) => index);
  const find = (node: number): number => {
    let root = node;
    while (parent[root] !== root) root = parent[root];
    while (parent[node] !== node) {
      const next = parent[node];
      parent[node] = root;
      node = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };

  for (const h of hLines) {
    for (const v of vLines) {
      if (v.x >= h.minX - LINE_TOLERANCE && v.x <= h.maxX + LINE_TOLERANCE &&
          h.y >= v.minY - LINE_TOLERANCE && h.y <= v.maxY + LINE_TOLERANCE) {
        // Connect the closest clustered coordinates.
        const hIndex = nearest(rowYs, h.y);
        const vIndex = nearest(colXs, v.x);
        union(hIndex, rowYs.length + vIndex);
      }
    }
  }

  const groups = new Map<number, { hs: Set<number>; vs: Set<number> }>();
  for (let i = 0; i < rowYs.length; i += 1) {
    const root = find(i);
    const group = groups.get(root) ?? { hs: new Set<number>(), vs: new Set<number>() };
    group.hs.add(i);
    groups.set(root, group);
  }
  for (let i = 0; i < colXs.length; i += 1) {
    const root = find(rowYs.length + i);
    const group = groups.get(root) ?? { hs: new Set<number>(), vs: new Set<number>() };
    group.vs.add(i);
    groups.set(root, group);
  }

  const grids: GridTable[] = [];
  for (const group of groups.values()) {
    if (group.hs.size < 2 || group.vs.size < 2) continue;
    const ys = [...group.hs].map((i) => rowYs[i]).sort((a, b) => a - b);
    const xs = [...group.vs].map((i) => colXs[i]).sort((a, b) => a - b);
    grids.push({
      rowYs: ys,
      colXs: xs,
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
    });
  }
  return grids;
}

function nearest(sorted: readonly number[], value: number): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < sorted.length; i += 1) {
    const distance = Math.abs(sorted[i] - value);
    if (distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  }
  return best;
}

function tableFromGrid(grid: GridTable, items: readonly TextItemPosition[], page: number): RawTable | null {
  // Rows top-down: interval (ys[i], ys[i+1]) with i counting from the bottom.
  const ys = grid.rowYs;
  const xs = grid.colXs;
  const cellTexts: string[][] = Array.from({ length: ys.length - 1 }, () =>
    Array.from({ length: xs.length - 1 }, () => ""),
  );
  for (const item of items) {
    if (item.x < grid.minX - 1 || item.x > grid.maxX + 1 || item.y < grid.minY - 1 || item.y > grid.maxY + 1) {
      continue;
    }
    const col = columnIndex(xs, item.x);
    const row = rowIndex(ys, item.y);
    if (col < 0 || row < 0) continue;
    if (cellTexts[row][col] !== "") cellTexts[row][col] += " ";
    cellTexts[row][col] += item.str;
  }
  if (cellTexts.length === 0) return null;
  const header = cellTexts[0].map((cell, index) => cleanHeader(cell === "" ? `col_${index}` : cell));
  const rows = cellTexts.slice(1).map((row) => {
    const trimmed = row.map((cell) => cell.trim());
    while (trimmed.length < header.length) trimmed.push("");
    return trimmed.slice(0, header.length);
  });
  return { header, rows, page };
}

function columnIndex(xs: readonly number[], x: number): number {
  for (let i = 0; i < xs.length - 1; i += 1) {
    if (x >= xs[i] - 1 && x <= xs[i + 1] + 1) return i;
  }
  return -1;
}

function rowIndex(ys: readonly number[], y: number): number {
  // ys ascending; the topmost row is the interval (ys[n-2], ys[n-1]).
  for (let i = ys.length - 2; i >= 0; i -= 1) {
    if (y >= ys[i] - 1 && y <= ys[i + 1] + 1) return ys.length - 2 - i;
  }
  return -1;
}

/**
 * Position clustering for unruled tables: rows of >= 2 items with consistent
 * column counts (Python ``_detect_delimited_rows`` heuristic applied to
 * positioned text items).
 */
function tableFromPositions(items: readonly TextItemPosition[], page: number): RawTable | null {
  const sorted = [...items].sort((a, b) => (b.y - a.y !== 0 ? b.y - a.y : a.x - b.x));
  const lines: TextItemPosition[][] = [];
  for (const item of sorted) {
    const last = lines[lines.length - 1];
    if (last !== undefined && Math.abs(last[0].y - item.y) <= 3) {
      last.push(item);
    } else {
      lines.push([item]);
    }
  }
  const candidate = lines.filter((line) => line.length >= 2);
  if (candidate.length < 2) return null;

  const colCounts = candidate.map((line) => line.length);
  const filtered =
    colCounts.length >= 3
      ? candidate.filter(
          (line) =>
            line.length === modeOf(colCounts) ||
            (modeOf(colCounts) - 1 <= line.length && line.length <= modeOf(colCounts) + 1),
        )
      : candidate;
  if (filtered.length < 2) return null;

  const headerCells = filtered[0].map((item) => item.str);
  const header = headerCells.map((cell, index) => cleanHeader(cell === "" ? `col_${index}` : cell));
  const rows = filtered.slice(1).map((line) => {
    const cells = line.map((item) => item.str.trim());
    while (cells.length < header.length) cells.push("");
    return cells.slice(0, header.length);
  });
  return { header, rows, page };
}

function modeOf(values: readonly number[]): number {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best = values[0];
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Extract tables from a PDF through the pdfjs tier with regex fallback.
 * Returns the table list plus a warning ("" when clean). Throws when both
 * tiers produce nothing from an unopenable file (malformed → error shape).
 */
export async function extractTablesRaw(filePath: string): Promise<RawExtraction> {
  let opened: OpenPdf | null = null;
  let openError: unknown = null;
  try {
    opened = await openPdf(await readPdfBytes(filePath));
  } catch (error) {
    openError = error;
  }

  if (opened !== null) {
    try {
      const tables: RawTable[] = [];
      let totalTextLength = 0;
      let hasImages = false;
      for (let pageNumber = 1; pageNumber <= opened.numPages; pageNumber += 1) {
        const page = await opened.page(pageNumber);
        totalTextLength += page.items.reduce((sum, item) => sum + item.str.length, 0);
        if (page.images.length > 0) hasImages = true;
        const grids = findGrids(page.lines);
        const consumed = new Set<TextItemPosition>();
        for (const grid of grids) {
          const table = tableFromGrid(grid, page.items, pageNumber);
          if (table !== null) {
            for (const item of page.items) {
              if (item.x >= grid.minX - 1 && item.x <= grid.maxX + 1 && item.y >= grid.minY - 1 && item.y <= grid.maxY + 1) {
                consumed.add(item);
              }
            }
            tables.push(table);
          }
        }
        const remaining = page.items.filter((item) => !consumed.has(item));
        const positioned = tableFromPositions(remaining, pageNumber);
        if (positioned !== null) tables.push(positioned);
      }
      if (tables.length === 0 && totalTextLength === 0 && hasImages) {
        return { tables, warning: SCANNED_PDF_WARNING };
      }
      return { tables, warning: "" };
    } finally {
      await opened.close();
    }
  }

  // ── regex fallback tier (Python no-library parity) ───────────────────
  const text = extractTextViaRegex(filePath);
  const rows = detectDelimitedRows(text);
  if (rows.length === 0) {
    const message = openError instanceof Error ? openError.message : String(openError);
    throw new Error(`PDF 解析失败: ${message}`);
  }
  const header = rows[0].map(cleanHeader);
  const data = rows.slice(1).map((row) => {
    const padded = [...row];
    while (padded.length < header.length) padded.push("");
    return padded.slice(0, header.length);
  });
  return {
    tables: [{ header, rows: data, page: null }],
    warning: REGEX_FALLBACK_WARNING,
  };
}

/**
 * ``extract_pdf_tables`` tool implementation. Writes one CSV per table to
 * ``<taskRoot>/parsed/<stem>_table_<N>.csv`` (utf-8-sig + CRLF, Python
 * ``csv.writer`` parity) and returns the P5-08B contract JSON object.
 */
export async function extractPdfTables(filePath: string, options: PdfTablesOptions): Promise<PdfTablesResult> {
  const { taskRoot } = options;

  let resolved: string;
  try {
    resolved = await resolveTaskLocalFile(filePath, taskRoot);
  } catch (error) {
    const isMissing = error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
    return {
      status: "error",
      error: isMissing
        ? `文件不存在: ${filePath}`
        : error instanceof Error
          ? error.message
          : String(error),
      source_file: filePath,
    };
  }

  const extension = path.extname(resolved).toLowerCase();
  if (!extension.endsWith("pdf")) {
    return {
      status: "error",
      error: `不支持的文件类型: ${extension}（需要 .pdf）`,
      source_file: filePath,
    };
  }

  let extraction: RawExtraction;
  try {
    extraction = await extractTablesRaw(resolved);
  } catch (error) {
    return {
      status: "error",
      error: `表格提取失败: ${error instanceof Error ? error.message : String(error)}`,
      source_file: filePath,
    };
  }

  const { tables, warning } = extraction;
  const sourceName = path.basename(resolved);

  if (tables.length === 0) {
    const result: PdfTablesOk = {
      status: "ok",
      source_file: sourceName,
      outputs: [],
      summary: { total_tables: 0, tables: [] },
    };
    if (warning !== "") result.warning = warning;
    return result;
  }

  const parsedDir = path.join(taskRoot, "parsed");
  await mkdir(parsedDir, { recursive: true });
  const stem = path.basename(resolved, path.extname(resolved));

  const outputs: string[] = [];
  const tableMeta: PdfTablesSummaryTable[] = [];
  let failedCount = 0;

  for (const [index, table] of tables.entries()) {
    const tableIndex = index + 1;
    const csvName = `${stem}_table_${tableIndex}.csv`;
    const csvPath = path.join(parsedDir, csvName);
    const header = table.header.length > 0
      ? table.header
      : Array.from({ length: table.rows[0]?.length ?? 1 }, (_, j) => `col_${j}`);
    const sanitized = table.rows.map((row) => {
      const cells = row.map((cell) => cell.trim());
      while (cells.length < header.length) cells.push("");
      return cells.slice(0, header.length);
    });

    try {
      await writeCsv(csvPath, header, sanitized);
    } catch {
      failedCount += 1;
      continue;
    }
    outputs.push(toTaskRelative(csvPath, taskRoot));
    tableMeta.push({
      table_index: tableIndex,
      page: table.page,
      row_count: sanitized.length,
      column_count: header.length,
      column_names: header,
      saved_path: toTaskRelative(csvPath, taskRoot),
    });
  }

  const result: PdfTablesOk = {
    status: "ok",
    source_file: sourceName,
    outputs,
    summary: {
      total_tables: tables.length,
      tables: tableMeta,
      failed_count: failedCount,
    },
  };
  if (warning !== "") result.warning = warning;
  return result;
}

/** CSV write with utf-8-sig BOM and CRLF line endings (Python csv parity). */
export async function writeCsv(csvPath: string, header: readonly string[], rows: readonly string[][]): Promise<void> {
  const escape = (cell: string): string => {
    if (/[",\r\n]/.test(cell)) {
      return `"${cell.replace(/"/g, '""')}"`;
    }
    return cell;
  };
  const lines = [header.map(escape).join(","), ...rows.map((row) => row.map(escape).join(","))];
  const content = "\ufeff" + lines.join("\r\n") + "\r\n";
  await writeFile(csvPath, content, "utf8");
}
