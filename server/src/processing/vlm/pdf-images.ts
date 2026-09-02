/**
 * PDF embedded-image extraction for VLM L1 input (Python
 * ``_extract_pdf_images`` parity with the pdfjs backend).
 *
 * pdfjs exposes raster XObjects through the operator list
 * (``paintImageXObject``) and ``page.objs.get(name)`` RGBA data; pngjs
 * encodes them as PNG into ``download_tmp`` with Python's naming rule
 * ``<pdf_stem>_p<page>_img<idx>.png``. At most ``MAX_PDF_IMAGES_PER_FILE``
 * images are extracted per file (VLM cost cap, Python parity); the rest are
 * counted as skipped.
 *
 * Spike degradation D1/D2 (docs/migration/phase5-pdf-spike.md §4.2) was "no
 * page rasterization — no Canvas 2D backend is installed". Since Gold6 task 7
 * a caption-guided page-rendering fallback tier exists
 * (``pdf-pages.ts``, ``@napi-rs/canvas``): this module remains the FIRST tier
 * (embedded raster extraction only), and the page renderer only runs when this
 * tier finds nothing usable. The bbox is still the clip-path approximation
 * when a simple axis-aligned rect exists.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { DEFAULT_RUNTIME_LIMITS } from "@biomed/contracts";
import { PNG } from "pngjs";

import { openPdf, readPdfBytes } from "../pdf/pdfjs.js";
import { ChartExtractionError } from "./chart-json.js";

/** Default maximum embedded images extracted from one PDF. */
export const MAX_PDF_IMAGES_PER_FILE = DEFAULT_RUNTIME_LIMITS.vlm_pdf_max_images;

/** Minimal page-raster descriptor shared by both PDF raster tiers. */
export interface PdfPageRaster {
  path: string;
  /** 1-based page index. */
  pageIndex: number;
  /**
   * Bbox ``x0,top,x1,bottom`` ("" when unknown). Embedded rasters carry the
   * clip-rect approximation in PDF points; rendered pages carry detected
   * pixel coordinates of the rendered image.
   */
  bbox: string;
}

export type ExtractedPdfImage = PdfPageRaster;

export interface PdfImageExtraction {
  images: ExtractedPdfImage[];
  skippedExtra: number;
}

/**
 * Extract embedded raster images from a PDF into ``destDir``.
 * Throws ``ChartExtractionError`` when the PDF cannot be opened.
 */
export async function extractPdfImages(
  pdfPath: string,
  destDir: string,
  maxImages = MAX_PDF_IMAGES_PER_FILE,
): Promise<PdfImageExtraction> {
  if (!Number.isSafeInteger(maxImages) || maxImages < 1 || maxImages > 100) {
    throw new ChartExtractionError("PDF maxImages must be an integer between 1 and 100");
  }
  await mkdir(destDir, { recursive: true });
  const stem = path.basename(pdfPath, path.extname(pdfPath));

  let opened: Awaited<ReturnType<typeof openPdf>>;
  try {
    opened = await openPdf(await readPdfBytes(pdfPath));
  } catch (error) {
    throw new ChartExtractionError(
      `pdfjs unavailable or failed to open ${pdfPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const extracted: ExtractedPdfImage[] = [];
  let skippedExtra = 0;
  try {
    for (let pageIndex = 1; pageIndex <= opened.numPages; pageIndex += 1) {
      const page = await opened.page(pageIndex);
      for (const [imageIndex, image] of page.images.entries()) {
        if (extracted.length >= maxImages) {
          skippedExtra += 1;
          continue;
        }
        try {
          const raster = await opened.getImage(pageIndex, image.name);
          if (raster.width <= 0 || raster.height <= 0) {
            throw new Error(`invalid image dimensions ${raster.width}x${raster.height}`);
          }
          const png = new PNG({ width: raster.width, height: raster.height });
          // pdfjs yields RGBA (4 bytes/px) for every image kind; the PNG
          // colorType 6 buffer is the same layout, so a straight copy works.
          const expected = raster.width * raster.height * 4;
          if (raster.data.length !== expected) {
            throw new Error(`unexpected raster data length ${raster.data.length} (expected ${expected})`);
          }
          png.data.set(raster.data);
          const buffer = PNG.sync.write(png, { colorType: 6 });
          const outPath = path.join(destDir, `${stem}_p${pageIndex}_img${imageIndex + 1}.png`);
          await writeFile(outPath, buffer);
          const bbox = image.clipRect === null ? "" : image.clipRect.map((coordinate) => Math.round(coordinate)).join(",");
          extracted.push({ path: outPath, pageIndex, bbox });
        } catch (error) {
          // Per-image failure is logged and skipped (Python parity).
          console.warn(
            `failed to extract image p${pageIndex} img${imageIndex + 1} from ${pdfPath}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  } catch (error) {
    throw new ChartExtractionError(
      `pdfjs failed to read ${pdfPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await opened.close();
  }

  if (skippedExtra > 0) {
    console.warn(
      `PDF ${pdfPath} had ${skippedExtra} additional images beyond the ${maxImages} cap; skipped`,
    );
  }
  return { images: extracted, skippedExtra };
}
