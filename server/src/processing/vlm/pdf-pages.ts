/**
 * Caption-guided full-page rendering for vector and composite PDFs (Gold6
 * vision repair, task 7). The exploratory chart tool uses this module after
 * its embedded-raster tier; the governed registered-paper route uses complete
 * page rasters directly so axes, legends, labels, and vector marks stay in one
 * image.
 *
 * pdfjs renders each candidate page through ``@napi-rs/canvas`` (the pdfjs
 * Node canvas backend, a direct dependency of ``@biomed/server``) at the
 * requested bounded DPI. Page candidates are bounded by
 * ``MAX_PDF_PAGES_PER_FILE``:
 * the text layer is scanned first and pages matching ``Fig``/``Figure``,
 * ``dose``, ``response``, or the extraction hint rank as caption candidates;
 * only when no candidate exists do the first pages render — never the
 * unbounded full paper.
 *
 * Locators carried into SourceLocator 2.0: the 1-based page number plus a
 * pixel bbox ``x0,top,x1,bottom`` in the rendered image. The bbox is detected
 * from the rendered pixels (drawing region) and falls back to the full-page
 * rectangle when nothing is drawn. Cancellation and render failures raise
 * ``ChartExtractionError`` — a typed extraction error, never a silent skip.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import { DEFAULT_RUNTIME_LIMITS } from "@biomed/contracts";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

import { PDFJS_STANDARD_FONTS_URL, readPdfBytes } from "../pdf/pdfjs.js";
import { ChartExtractionError } from "./chart-json.js";

/** Default maximum pages rendered from a single PDF (VLM cost cap). */
export const MAX_PDF_PAGES_PER_FILE = DEFAULT_RUNTIME_LIMITS.vlm_pdf_max_pages;

/** Default page rendering resolution, aligned with the governed Gold6 path. */
export const RENDER_DPI = DEFAULT_RUNTIME_LIMITS.vlm_render_dpi;

/** Bounded DPI range accepted by the in-process renderer. */
const MIN_RENDER_DPI = 72;
const MAX_RENDER_DPI = 300;
/** Per-page allocation/scan cap; checked before canvas creation. */
export const MAX_PDF_RENDER_PIXELS = 25_000_000;
/** Padding added around the detected drawing bbox (rendered pixels). */
const INK_PADDING_PX = 4;
/** Fewer drawn pixels than this counts as a blank page (full-page bbox). */
const MIN_INK_PIXELS = 16;
const CAPTION_TOKENS = ["fig", "dose", "response"] as const;

export interface RenderedPdfPage {
  path: string;
  /** 1-based page number in the source PDF. */
  pageIndex: number;
  /** Pixel bbox ``x0,top,x1,bottom`` in the rendered image (full-page rect when nothing is drawn). */
  bbox: string;
}

export interface PdfPageRendering {
  pages: RenderedPdfPage[];
  /** Bounded candidate pages beyond the cap (never rendered). */
  skippedPages: number;
  /** How candidates were chosen: caption tokens ranked, or first-pages fallback. */
  selection: "caption" | "first_pages";
}

export interface RenderPdfPagesOptions {
  /** Extraction hint; pages containing it rank as caption candidates. */
  hint?: string;
  /** Raster resolution. Defaults to RENDER_DPI and is bounded to protect memory. */
  dpi?: number;
  /** Run-snapshotted page budget. The hard range remains code-owned. */
  maxPages?: number;
  signal?: AbortSignal;
}

interface PageCandidate {
  pageNumber: number;
  score: number;
}

function extractionError(message: string): ChartExtractionError {
  return new ChartExtractionError(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfCancelled(pdfPath: string, signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw extractionError(`page rendering cancelled for ${pdfPath}`);
  }
}

/** Caption-guided score: explicit figure captions outrank topic tokens. */
function captionScore(text: string, hint: string): number {
  let score = 0;
  const lowered = text.toLowerCase();
  if (/\bfig(?:ure)?\s*\d*\b/.test(lowered)) score += 2;
  for (const token of CAPTION_TOKENS) {
    if (lowered.includes(token)) score += 1;
  }
  const hintToken = hint.trim().toLowerCase();
  if (hintToken !== "" && lowered.includes(hintToken)) score += 1;
  return score;
}

/**
 * Detect the drawn region from rendered pixels; a near-blank page falls back
 * to the full-page rectangle. Coordinates are image pixels (top-left origin).
 */
function detectInkBbox(ctx: SKRSContext2D, width: number, height: number): string {
  const image = ctx.getImageData(0, 0, width, height);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let inkPixels = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const alpha = image.data[offset + 3];
      const red = image.data[offset];
      const green = image.data[offset + 1];
      const blue = image.data[offset + 2];
      if (alpha > 0 && (red < 250 || green < 250 || blue < 250)) {
        inkPixels += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (inkPixels < MIN_INK_PIXELS || maxX < 0) {
    return `0,0,${width},${height}`;
  }
  const x0 = Math.max(0, minX - INK_PADDING_PX);
  const y0 = Math.max(0, minY - INK_PADDING_PX);
  const x1 = Math.min(width, maxX + 1 + INK_PADDING_PX);
  const y1 = Math.min(height, maxY + 1 + INK_PADDING_PX);
  return `${x0},${y0},${x1},${y1}`;
}

/**
 * Read a PDF path, then render its bounded caption-guided candidate pages.
 * Governed registered-asset callers use ``renderPdfPagesFromBytes`` instead so
 * the rasterizer consumes the exact bytes that passed digest verification.
 */
export async function renderPdfPages(
  pdfPath: string,
  destDir: string,
  options: RenderPdfPagesOptions = {},
): Promise<PdfPageRendering> {
  throwIfCancelled(pdfPath, options.signal);
  let bytes: Uint8Array;
  try {
    bytes = await readPdfBytes(pdfPath);
  } catch (error) {
    throw extractionError(`could not read ${pdfPath} for page rendering: ${errorMessage(error)}`);
  }
  return renderPdfPagesFromBytes(bytes, pdfPath, destDir, options);
}

/**
 * Render already verified PDF bytes into bounded full-page PNG rasters. The
 * input is copied before pdfjs receives it because pdfjs may transfer/detach
 * its Uint8Array while loading the document.
 */
export async function renderPdfPagesFromBytes(
  verifiedBytes: Uint8Array,
  sourceLabel: string,
  destDir: string,
  options: RenderPdfPagesOptions = {},
): Promise<PdfPageRendering> {
  const {
    signal,
    hint = "",
    dpi = RENDER_DPI,
    maxPages = MAX_PDF_PAGES_PER_FILE,
  } = options;
  throwIfCancelled(sourceLabel, signal);
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100) {
    throw extractionError("page rendering maxPages must be an integer between 1 and 100");
  }
  if (!Number.isInteger(dpi) || dpi < MIN_RENDER_DPI || dpi > MAX_RENDER_DPI) {
    throw extractionError(
      `page rendering DPI must be an integer between ${MIN_RENDER_DPI} and ${MAX_RENDER_DPI}`,
    );
  }
  const renderScale = dpi / 72;
  const bytes = Uint8Array.from(verifiedBytes);
  let doc: pdfjs.PDFDocumentProxy;
  const loadingTask = pdfjs.getDocument({
    data: bytes,
    useSystemFonts: true,
    standardFontDataUrl: PDFJS_STANDARD_FONTS_URL,
  });
  try {
    try {
      doc = await loadingTask.promise;
    } catch (error) {
      throw extractionError(`pdfjs could not open ${sourceLabel} for page rendering: ${errorMessage(error)}`);
    }

    // -- 1. Scan the text layer and rank caption candidates.
    const candidates: PageCandidate[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      throwIfCancelled(sourceLabel, signal);
      const page = await doc.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const text = textContent.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ");
      const score = captionScore(text, hint);
      if (score > 0) candidates.push({ pageNumber, score });
    }
    candidates.sort((a, b) => b.score - a.score || a.pageNumber - b.pageNumber);
    const selection: PdfPageRendering["selection"] = candidates.length > 0 ? "caption" : "first_pages";
    const chosen: PageCandidate[] =
      selection === "caption"
        ? candidates.slice(0, maxPages)
        : Array.from({ length: Math.min(doc.numPages, maxPages) }, (_, index) => ({
            pageNumber: index + 1,
            score: 0,
          }));
    const skippedPages =
      selection === "caption"
        ? candidates.length - chosen.length
        : Math.max(0, doc.numPages - chosen.length);

    // -- 2. Render the bounded candidate set at the admitted DPI.
    await mkdir(destDir, { recursive: true });
    const stem = path.basename(sourceLabel, path.extname(sourceLabel));
    const pages: RenderedPdfPage[] = [];
    for (const candidate of chosen) {
      throwIfCancelled(sourceLabel, signal);
      const page = await doc.getPage(candidate.pageNumber);
      const viewport = page.getViewport({ scale: renderScale });
      const width = Math.ceil(viewport.width);
      const height = Math.ceil(viewport.height);
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
        throw extractionError(
          `pdfjs produced invalid page dimensions for page ${candidate.pageNumber} of ${sourceLabel}`,
        );
      }
      if (width * height > MAX_PDF_RENDER_PIXELS) {
        throw extractionError(
          `page ${candidate.pageNumber} of ${sourceLabel} exceeded the ${MAX_PDF_RENDER_PIXELS} pixel rendering limit ` +
            `at ${dpi} DPI (${width}x${height})`,
        );
      }
      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext("2d");
      try {
        await page.render({ canvas: null, canvasContext: ctx, viewport }).promise;
      } catch (error) {
        throw extractionError(
          `pdfjs failed to render page ${candidate.pageNumber} of ${sourceLabel}: ${errorMessage(error)}`,
        );
      }
      const bbox = detectInkBbox(ctx, canvas.width, canvas.height);
      const outPath = path.join(destDir, `${stem}_p${candidate.pageNumber}.png`);
      await writeFile(outPath, await canvas.encode("png"));
      pages.push({ path: outPath, pageIndex: candidate.pageNumber, bbox });
    }
    return { pages, skippedPages, selection };
  } finally {
    try {
      await loadingTask.destroy();
    } catch {
      // Already destroyed / transport never started — nothing to release.
    }
  }
}
