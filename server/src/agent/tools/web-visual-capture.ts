/**
 * Web visual capture tools (P5-07; Python
 * ``skills/builtin/acquisition/web_visual_capture.py`` parity).
 *
 * Screenshots are generated locally by the guarded Playwright pool (real
 * browser headers, stealth, per-host rate limiting) — they are NOT fetched
 * over HTTP, so the sanctioned ``acquireSource`` download path does not apply
 * (Python parity: the skill stages Playwright bytes through its workspace
 * instead of calling ``acquire_source``). The Node port writes the PNG and a
 * provenance meta file under ``source_assets/figures/`` atomically (temp +
 * rename), recording source URL, final URL, capture timestamp, SHA-256,
 * viewport, selector/section, label, and source id.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { BioMedAgentTool } from "../contracts.js";
import type { CrawlerFacade } from "../../external/crawler/index.js";
import { BROWSER_HEADERS } from "../../external/crawler/index.js";
import { makeSourceId } from "../../external/sources/fallback.js";
import { DATABASE } from "../../dataset/contracts/enums.js";
import type { ToolHooks } from "./tool-hooks.js";
import { noopHooks } from "./tool-hooks.js";

const SOURCE = "web_visual_capture";
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
const MAX_VIEWPORT_WIDTH = 1920;
const MAX_VIEWPORT_HEIGHT = 1080;
const SAFE_LABEL_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Python ``_validate_label`` parity: safe filename/log characters only. */
function validateLabel(label: string | null): string | null {
  if (label === null) return null;
  if (!SAFE_LABEL_PATTERN.test(label)) {
    throw new Error(
      "label must be 1-64 chars of [A-Za-z0-9_-] only; path separators and '..' are forbidden",
    );
  }
  return label;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface WebVisualCaptureOptions {
  /** Absolute task root (TaskWorkDir root) for captured figures. */
  taskRoot: string;
  crawler: CrawlerFacade;
  hooks?: ToolHooks;
}

export const CAPTURE_WEB_PAGE_TOOL_NAME = "capture_web_page";
export const CAPTURE_PAGE_SECTION_TOOL_NAME = "capture_page_section";

export interface CaptureRequest {
  url: string;
  fullPage: boolean;
  viewportWidth: number;
  viewportHeight: number;
  waitUntil: "load" | "domcontentloaded" | "networkidle" | "commit";
  selector: string | null;
  label: string | null;
}

export function createWebVisualCaptureTools(options: WebVisualCaptureOptions): {
  captureWebPage: BioMedAgentTool;
  capturePageSection: BioMedAgentTool;
} {
  const hooks = noopHooks(options.hooks);

  async function doCapture(request: CaptureRequest, signal?: AbortSignal): Promise<string> {
    const { url } = request;
    let validatedLabel: string | null;
    try {
      validatedLabel = validateLabel(request.label);
    } catch (error) {
      hooks.onQuery(url, SOURCE, "failed", 0);
      return JSON.stringify({ source: SOURCE, url, error: errorText(error) });
    }

    try {
      const viewportWidth = Math.max(1, Math.min(request.viewportWidth, MAX_VIEWPORT_WIDTH));
      const viewportHeight = Math.max(1, Math.min(request.viewportHeight, MAX_VIEWPORT_HEIGHT));
      const capturedAt = new Date().toISOString();
      const accession = validatedLabel ?? `capture_${randomUUID()}`;
      const sourceId = makeSourceId(DATABASE.BROWSER, accession, url);

      const result = await options.crawler.screenshot(url, {
        fullPage: request.fullPage,
        selector: request.selector,
        viewportWidth,
        viewportHeight,
        waitUntil: request.waitUntil,
        extraHeaders: { ...BROWSER_HEADERS },
        signal,
      });

      if (result.status_code < 200 || result.status_code >= 300) {
        hooks.onQuery(url, SOURCE, "failed", 0);
        hooks.onProgress(SOURCE, "warning", {
          message: `capture failed for ${url}: HTTP ${result.status_code}`,
        });
        return JSON.stringify({
          source: SOURCE,
          url,
          status_code: result.status_code,
          error: `HTTP ${result.status_code}`,
          viewport: { width: viewportWidth, height: viewportHeight },
        });
      }

      const sha256 = createHash("sha256").update(result.buffer).digest("hex");
      const sizeBytes = result.buffer.byteLength;
      const figuresDir = path.join(options.taskRoot, "source_assets", "figures");
      await mkdir(figuresDir, { recursive: true });
      const pngPath = path.join(figuresDir, `${accession}.png`);
      const metaPath = path.join(figuresDir, `${accession}.meta.json`);
      const temporary = path.join(figuresDir, `.${accession}.${randomUUID()}.tmp`);
      await writeFile(temporary, result.buffer);
      await rename(temporary, pngPath);
      const meta = {
        source_url: url,
        final_url: result.url,
        captured_at: capturedAt,
        sha256,
        size_bytes: sizeBytes,
        viewport: { width: viewportWidth, height: viewportHeight },
        full_page: request.fullPage,
        selector: request.selector,
        label: validatedLabel,
        source_id: sourceId,
      };
      await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");

      if (sizeBytes > MAX_SCREENSHOT_BYTES) {
        hooks.onProgress(SOURCE, "warning", {
          message: `screenshot oversize: ${sizeBytes} bytes (> ${MAX_SCREENSHOT_BYTES}) for ${url}`,
        });
      }
      hooks.onQuery(url, SOURCE, "success", 1);
      hooks.onProgress("acquisition", "captured_screenshot", {
        source: SOURCE,
        url,
        label: validatedLabel,
        sha256,
        size_bytes: sizeBytes,
        viewport: { width: viewportWidth, height: viewportHeight },
        full_page: request.fullPage,
        selector: request.selector,
      });

      return JSON.stringify({
        source: SOURCE,
        url,
        status_code: result.status_code,
        local_files: [pngPath],
        meta_file: metaPath,
        sha256,
        size_bytes: sizeBytes,
        viewport: { width: viewportWidth, height: viewportHeight },
        full_page: request.fullPage,
        selector: request.selector,
        label: validatedLabel,
        captured_at: capturedAt,
        source_id: sourceId,
      });
    } catch (error) {
      if (signal?.aborted === true) throw error;
      hooks.onQuery(url, SOURCE, "failed", 0);
      hooks.onProgress(SOURCE, "warning", {
        message: `capture raised for ${url}: ${errorText(error)}`,
      });
      return JSON.stringify({ source: SOURCE, url, error: errorText(error) });
    }
  }

  function waitUntil(value: unknown): CaptureRequest["waitUntil"] {
    return value === "load" || value === "domcontentloaded" || value === "commit" ? value : "networkidle";
  }

  const captureWebPage: BioMedAgentTool = {
    name: CAPTURE_WEB_PAGE_TOOL_NAME,
    label: "Capture web page screenshot",
    description:
      "Capture a full-page screenshot of a biomedical web page. Saves a PNG to " +
      "source_assets/figures/ with a provenance meta file (source URL, final " +
      "URL, SHA-256, viewport, label, source id). Uses real browser headers, " +
      "stealth, and 2s rate limiting; viewport clamped to 1920x1080. Use for " +
      "visual evidence or chart-extraction input when API acquisition failed.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Target HTTP(S) URL. Must resolve to a public address." },
        full_page: { type: "boolean", description: "Capture the full scrollable page (default true)." },
        viewport_width: { type: "number", description: "Viewport width (clamped to 1920)." },
        viewport_height: { type: "number", description: "Viewport height (clamped to 1080)." },
        wait_until: { type: "string", description: "Playwright wait strategy (default networkidle)." },
        label: { type: "string", description: "Optional safe label ([A-Za-z0-9_-]{1,64})." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    execute: async (argumentsValue, signal) => {
      const record = argumentsValue as Record<string, unknown>;
      const url = typeof record["url"] === "string" ? record["url"] : "";
      return {
        content: await doCapture(
          {
            url,
            fullPage: record["full_page"] !== false,
            viewportWidth: typeof record["viewport_width"] === "number" ? record["viewport_width"] : 1920,
            viewportHeight: typeof record["viewport_height"] === "number" ? record["viewport_height"] : 1080,
            waitUntil: waitUntil(record["wait_until"]),
            selector: null,
            label: typeof record["label"] === "string" ? record["label"] : null,
          },
          signal,
        ),
      };
    },
  };

  const capturePageSection: BioMedAgentTool = {
    name: CAPTURE_PAGE_SECTION_TOOL_NAME,
    label: "Capture page section screenshot",
    description:
      "Capture a screenshot of one DOM element (CSS selector) on a biomedical " +
      "web page — useful for figure/table regions. Same provenance meta file as " +
      "capture_web_page (full_page false). The first matching element is captured.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Target HTTP(S) URL. Must resolve to a public address." },
        selector: { type: "string", description: "CSS selector identifying the element to capture." },
        viewport_width: { type: "number", description: "Viewport width (clamped to 1920)." },
        viewport_height: { type: "number", description: "Viewport height (clamped to 1080)." },
        wait_until: { type: "string", description: "Playwright wait strategy (default networkidle)." },
        label: { type: "string", description: "Optional safe label ([A-Za-z0-9_-]{1,64})." },
      },
      required: ["url", "selector"],
      additionalProperties: false,
    },
    execute: async (argumentsValue, signal) => {
      const record = argumentsValue as Record<string, unknown>;
      const url = typeof record["url"] === "string" ? record["url"] : "";
      const selector = typeof record["selector"] === "string" ? record["selector"] : "";
      return {
        content: await doCapture(
          {
            url,
            fullPage: false,
            viewportWidth: typeof record["viewport_width"] === "number" ? record["viewport_width"] : 1920,
            viewportHeight: typeof record["viewport_height"] === "number" ? record["viewport_height"] : 1080,
            waitUntil: waitUntil(record["wait_until"]),
            selector,
            label: typeof record["label"] === "string" ? record["label"] : null,
          },
          signal,
        ),
      };
    },
  };

  return { captureWebPage, capturePageSection };
}
