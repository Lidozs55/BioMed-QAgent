/**
 * pdfjs-dist adapter for the processing tier (P5-08 spike conclusion, see
 * docs/migration/phase5-pdf-spike.md).
 *
 * Uses the ``legacy`` build (the standard build needs browser globals like
 * ``DOMMatrix``). In Node the fake worker is auto-configured by pdfjs
 * (``workerSrc`` defaults to ``./pdf.worker.mjs`` next to ``pdf.mjs``), so no
 * worker plumbing is needed here.
 *
 * Exposes exactly what the tables / metadata / VLM-image extractors need:
 * per-page text items with positions, stroked ruled-line coordinates (for
 * grid-based table detection), embedded raster images (RGBA), and a clip-path
 * approximation of each image's bbox (spike degradation D2).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Directory holding pdf.js standard font data (silences the font warning). */
const STANDARD_FONTS_URL = pathToFileURL(
  path.resolve(MODULE_DIR, "..", "..", "..", "node_modules", "pdfjs-dist", "standard_fonts"),
).href + "/";

export interface TextItemPosition {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Line2D {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PdfImage {
  /** RGBA pixel data (4 bytes per pixel). */
  data: Uint8Array;
  width: number;
  height: number;
}

export interface PageImage {
  /** Unique image name inside the page (``img_p<page>_<n>``). */
  name: string;
  /** Clip-path rectangle ``[x0, y0, x1, y1]`` in PDF points, or null. */
  clipRect: readonly [number, number, number, number] | null;
}

export interface PageExtract {
  pageNumber: number;
  /** Non-whitespace text items in reading order. */
  items: readonly TextItemPosition[];
  /** Stroked path segments (candidate table rules). */
  lines: readonly Line2D[];
  /** Paint-image operator targets (deduplicated by name). */
  images: readonly PageImage[];
}

export interface OpenPdf {
  numPages: number;
  page(pageNumber: number): Promise<PageExtract>;
  getImage(pageNumber: number, name: string): Promise<PdfImage>;
  /** Release worker resources (loading task destroy). */
  close(): Promise<void>;
}

interface InternalPageExtract {
  items: readonly TextItemPosition[];
  lines: readonly Line2D[];
  images: readonly PageImage[];
}

function isTextItem(value: unknown): value is {
  str: string;
  transform: number[];
  width: number;
  height: number;
} {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.str === "string" &&
    Array.isArray(record.transform) &&
    typeof record.width === "number" &&
    typeof record.height === "number"
  );
}

function pathOpsToLines(ops: readonly Record<number, number>[]): Line2D[] {
  const lines: Line2D[] = [];
  let cursor: { x: number; y: number } | null = null;
  let start: { x: number; y: number } | null = null;
  for (const op of ops) {
    const code = op[0];
    if (code === 0) {
      // moveTo
      cursor = { x: op[1], y: op[2] };
      if (start === null) start = cursor;
    } else if (code === 1 && cursor !== null) {
      // lineTo
      lines.push({ x0: cursor.x, y0: cursor.y, x1: op[1], y1: op[2] });
      cursor = { x: op[1], y: op[2] };
    }
    // curveTo / rect variants are ignored: ruled tables use line segments.
  }
  return lines;
}

function clipRectFromPath(
  ops: readonly Record<number, number>[],
  closeInfo: Record<number, number> | null,
): readonly [number, number, number, number] | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const op of ops) {
    if (op[0] === 0 || op[0] === 1) {
      xs.push(op[1]);
      ys.push(op[2]);
    }
  }
  if (closeInfo !== null && closeInfo[0] !== undefined && closeInfo[1] !== undefined) {
    xs.push(closeInfo[0]);
    ys.push(closeInfo[1]);
  }
  if (xs.length < 3) return null;
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  // A simple axis-aligned rectangle has exactly two distinct coordinates.
  const uniqueX = new Set(xs.map((v) => Math.round(v * 100)));
  const uniqueY = new Set(ys.map((v) => Math.round(v * 100)));
  if (uniqueX.size !== 2 || uniqueY.size !== 2) return null;
  return [minX, minY, maxX, maxY];
}

/** Whether an operator ends a path without painting it (clip / n / fill-only). */
function isStrokedPaint(opCode: number | undefined): boolean {
  return (
    opCode === pdfjs.OPS.stroke ||
    opCode === pdfjs.OPS.closeStroke ||
    opCode === pdfjs.OPS.fillStroke ||
    opCode === pdfjs.OPS.eoFillStroke ||
    opCode === pdfjs.OPS.closeFillStroke ||
    opCode === pdfjs.OPS.closeEOFillStroke
  );
}

async function extractPage(page: pdfjs.PDFPageProxy): Promise<InternalPageExtract> {
  const [textContent, operatorList] = await Promise.all([
    page.getTextContent(),
    page.getOperatorList(),
  ]);

  const items: TextItemPosition[] = [];
  for (const item of textContent.items) {
    if (!isTextItem(item)) continue;
    if (item.str.trim() === "") continue;
    items.push({
      str: item.str,
      x: item.transform[4],
      y: item.transform[5],
      width: item.width,
      height: item.height,
    });
  }

  // Walk the operator list: constructPath ops accumulate segments; only
  // paths followed by a stroked paint belong to ruled table lines. Clip
  // paths (``re W n``) are tracked for image bbox approximation (spike D2).
  const lines: Line2D[] = [];
  const images: PageImage[] = [];
  let pendingPath: readonly Record<number, number>[] | null = null;
  let clipPending = false;
  let currentClip: readonly [number, number, number, number] | null = null;

  const fnArray = operatorList.fnArray;
  const argsArray = operatorList.argsArray;
  for (let i = 0; i < fnArray.length; i += 1) {
    const fn = fnArray[i];
    const args = argsArray[i] as unknown[] | undefined;
    if (fn === pdfjs.OPS.constructPath) {
      const ops = Array.isArray(args?.[0]) ? (args[0] as Record<number, number>[]) : [];
      const closeInfo = (args?.[1] as Record<number, number> | null) ?? null;
      if (clipPending) {
        // This constructPath is the clip path itself (``re W n`` pattern);
        // a simple axis-aligned rect approximates the image bbox (spike D2).
        currentClip = clipRectFromPath(ops, closeInfo) ?? currentClip;
        clipPending = false;
        pendingPath = null;
      } else {
        pendingPath = ops;
      }
      continue;
    }
    if (fn === pdfjs.OPS.clip || fn === pdfjs.OPS.eoClip) {
      clipPending = true;
      continue;
    }
    if (isStrokedPaint(fn) && pendingPath !== null) {
      lines.push(...pathOpsToLines(pendingPath));
      pendingPath = null;
      continue;
    }
    if (fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintInlineImageXObject) {
      const name = args?.[0];
      if (typeof name === "string") {
        images.push({ name, clipRect: currentClip });
      }
      currentClip = null;
      pendingPath = null;
      continue;
    }
    if (
      fn === pdfjs.OPS.endPath ||
      fn === pdfjs.OPS.fill ||
      fn === pdfjs.OPS.eoFill
    ) {
      pendingPath = null;
      continue;
    }
  }

  return { items, lines, images };
}

/**
 * Open a PDF with pdfjs (``Uint8Array`` data, standard font data wired up).
 * Throws pdfjs ``InvalidPDFException`` / ``PasswordException`` on failure —
 * callers fall back to the raw-stream regex tier.
 */
export async function openPdf(bytes: Uint8Array): Promise<OpenPdf> {
  const loadingTask = pdfjs.getDocument({
    data: bytes,
    useSystemFonts: true,
    standardFontDataUrl: STANDARD_FONTS_URL,
  });
  const doc = await loadingTask.promise;
  const cache = new Map<number, Promise<InternalPageExtract>>();

  const getExtract = (pageNumber: number): Promise<InternalPageExtract> => {
    const existing = cache.get(pageNumber);
    if (existing !== undefined) return existing;
    const pending = doc.getPage(pageNumber).then((page) => extractPage(page));
    cache.set(pageNumber, pending);
    return pending;
  };

  return {
    numPages: doc.numPages,
    page: async (pageNumber) => {
      const extract = await getExtract(pageNumber);
      return {
        pageNumber,
        items: extract.items,
        lines: extract.lines,
        images: extract.images,
      };
    },
    getImage: async (pageNumber, name) => {
      const page = await doc.getPage(pageNumber);
      const image = await page.objs.get(name);
      const data = image?.data;
      if (!(data instanceof Uint8Array) || typeof image.width !== "number" || typeof image.height !== "number") {
        throw new Error(`image object ${name} has no raster data`);
      }
      return { data, width: image.width, height: image.height };
    },
    close: async () => {
      try {
        await loadingTask.destroy();
      } catch {
        // Already destroyed / transport never started — nothing to release.
      }
    },
  };
}

/** Read a file and return its bytes. */
export async function readPdfBytes(filePath: string): Promise<Uint8Array> {
  const buffer = await readFile(filePath);
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}
