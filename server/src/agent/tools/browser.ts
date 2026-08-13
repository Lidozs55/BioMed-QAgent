/**
 * Browser fallback acquisition tools (P5-07; Python
 * ``skills/builtin/acquisition/browser.py`` parity).
 *
 * ``navigate_page`` renders a page through the crawler browser tier and
 * parses the title + visible body text with cheerio (Python BeautifulSoup
 * parity). ``download_from_page`` stages an immutable SourceAsset through the
 * sanctioned ``acquireSource`` path (pinned public-HTTP client with browser
 * headers and the crawler's per-host pacing) — the tool never writes
 * downloaded bytes itself.
 *
 * HTTP concerns (browser UA, Referer, rate limiting) are owned by the unified
 * crawler layer, mirroring the Python skill's delegation contract.
 */

import { stat } from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";

import type { BioMedAgentTool } from "../contracts.js";
import type { ContentCache } from "../../external/acquisition/content-cache.js";
import { acquireSource } from "../../external/acquisition/downloader.js";
import { taskWorkDirs } from "../../external/acquisition/workdir.js";
import type { PublicHttpClient } from "../../external/network/http-client.js";
import type { CrawlerFacade } from "../../external/crawler/index.js";
import { BROWSER_HEADERS, MAX_CRAWLER_DOWNLOAD_BYTES } from "../../external/crawler/index.js";
import { makeSourceId } from "../../external/sources/fallback.js";
import { DATA_LEVEL, DATABASE } from "../../dataset/contracts/enums.js";
import type { SourceRecord } from "../../dataset/contracts/source.js";
import type { ToolHooks } from "./tool-hooks.js";
import { noopHooks } from "./tool-hooks.js";

const MAX_BODY_CHARS = 5000;
const SOURCE = "browser_fallback";

/** Python ``_validate_download_filename`` parity. */
function validateDownloadFilename(filename: string): void {
  if (
    !filename ||
    path.basename(filename) !== filename ||
    filename === "." ||
    filename === ".." ||
    filename.includes("\\")
  ) {
    throw new Error("source asset filename is unsafe");
  }
}

/** Python ``_extract_title`` (BeautifulSoup → cheerio). */
function extractTitle(html: string): string {
  const $ = load(html);
  return $("title").first().text().trim();
}

/** Python ``_extract_body_text`` (BeautifulSoup → cheerio). */
function extractBodyText(html: string): string {
  const $ = load(html);
  $("script, style, head, noscript").remove();
  return $.root().text().replace(/\s+/g, " ").trim();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface BrowserToolsOptions {
  /** Absolute task root (TaskWorkDir root) for acquired source assets. */
  taskRoot: string;
  cache: ContentCache;
  client: PublicHttpClient;
  crawler: CrawlerFacade;
  hooks?: ToolHooks;
}

export const NAVIGATE_PAGE_TOOL_NAME = "navigate_page";
export const DOWNLOAD_FROM_PAGE_TOOL_NAME = "download_from_page";

export function createBrowserTools(options: BrowserToolsOptions): {
  navigatePage: BioMedAgentTool;
  downloadFromPage: BioMedAgentTool;
} {
  const hooks = noopHooks(options.hooks);

  const navigatePage: BioMedAgentTool = {
    name: NAVIGATE_PAGE_TOOL_NAME,
    label: "Navigate web page",
    description:
      "Navigate with the guarded Playwright crawler (real browser headers, " +
      "2s rate limiting) and return page metadata and visible text. Extracts " +
      "the <title> and visible body text (up to 5000 characters). Use this as " +
      "a last-resort tool when API endpoints are unavailable.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Target HTTP(S) URL. Must resolve to a public address." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    execute: async (argumentsValue, signal) => {
      const record = argumentsValue as { url?: unknown };
      const url = typeof record.url === "string" ? record.url : "";
      try {
        const result = await options.crawler.browser(url, signal);
        if (!result.ok) {
          hooks.onQuery(url, SOURCE, "failed", 0);
          return {
            content: JSON.stringify({
              url,
              status_code: result.status_code,
              method_used: result.method_used,
              error: result.error ?? `HTTP ${result.status_code}`,
            }),
          };
        }
        const html = result.content;
        hooks.onQuery(url, SOURCE, "success", 1);
        return {
          content: JSON.stringify({
            url,
            status_code: result.status_code,
            method_used: result.method_used,
            title: extractTitle(html),
            body_text_preview: extractBodyText(html).slice(0, MAX_BODY_CHARS),
            content_type: result.headers["content-type"] ?? "",
          }),
        };
      } catch (error) {
        if (signal?.aborted === true) throw error;
        hooks.onQuery(url, SOURCE, "failed", 0);
        return {
          content: JSON.stringify({ url, error: errorText(error) }),
        };
      }
    },
  };

  const downloadFromPage: BioMedAgentTool = {
    name: DOWNLOAD_FROM_PAGE_TOOL_NAME,
    label: "Download file from page",
    description:
      "Download a file through the sanctioned acquisition path into immutable " +
      "source assets (bounded 4 GiB, pinned public-HTTP transport, browser " +
      "headers, per-host rate limiting). Use this as a last-resort download " +
      "tool when API endpoints fail.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "File URL. Must resolve to a public address." },
        filename: { type: "string", description: "Safe destination filename (basename only)." },
      },
      required: ["url", "filename"],
      additionalProperties: false,
    },
    execute: async (argumentsValue, signal) => {
      const record = argumentsValue as { url?: unknown; filename?: unknown };
      const url = typeof record.url === "string" ? record.url : "";
      const filename = typeof record.filename === "string" ? record.filename : "";
      try {
        validateDownloadFilename(filename);
        const dirs = taskWorkDirs(options.taskRoot);
        const legacyDestination = path.join(dirs.sourceAssets, filename);
        try {
          const existing = await stat(legacyDestination);
          if (existing.isFile()) {
            throw new Error(`source asset already exists: ${filename}`);
          }
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("source asset already exists")) {
            throw error;
          }
          // ENOENT: the legacy flat destination does not exist yet — proceed.
        }
        const retrievedAt = new Date().toISOString();
        const sourceId = makeSourceId(DATABASE.BROWSER, filename, url);
        const source: SourceRecord = {
          schema_version: "1.0",
          source_id: sourceId,
          database: DATABASE.BROWSER,
          accession: filename,
          url,
          title: `Browser download ${filename}`,
          retrieved_at: retrievedAt,
        };
        await options.crawler.pace(url);
        const result = await acquireSource({
          source,
          filename,
          workdirRoot: options.taskRoot,
          cache: options.cache,
          client: options.client,
          dataLevel: DATA_LEVEL.METADATA,
          maxBytes: MAX_CRAWLER_DOWNLOAD_BYTES,
          requestHeaders: { ...BROWSER_HEADERS },
          accept: BROWSER_HEADERS["Accept"],
          signal,
        });
        if (result.attempt.status === "failed" || result.asset === null) {
          hooks.onQuery(filename, SOURCE, "failed", 0);
          return {
            content: JSON.stringify({
              source: SOURCE,
              accession: filename,
              source_url: url,
              local_files: [],
              error: result.attempt.error_message ?? result.attempt.error_code ?? "download failed",
            }),
          };
        }
        const asset = result.asset;
        const localPath = path.join(dirs.root, ...asset.relative_path.split("/"));
        hooks.onQuery(filename, SOURCE, "success", 1);
        return {
          content: JSON.stringify({
            source: SOURCE,
            source_url: url,
            local_files: [localPath],
            mime_type: asset.media_type,
            bytes_received: result.attempt.bytes_received,
            retrieved_at: result.attempt.finished_at,
            source_asset: asset,
            download_attempt: result.attempt,
          }),
        };
      } catch (error) {
        if (signal?.aborted === true) throw error;
        hooks.onQuery(filename, SOURCE, "failed", 0);
        return {
          content: JSON.stringify({
            source: SOURCE,
            accession: filename,
            source_url: url,
            error: errorText(error),
          }),
        };
      }
    },
  };

  return { navigatePage, downloadFromPage };
}
