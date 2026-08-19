/**
 * Browser acquisition tools (P5-07; Python
 * ``skills/builtin/acquisition/browser.py`` parity).
 *
 * ``navigate_page`` renders a page through the crawler browser tier and
 * parses the title + visible body text with cheerio (Python BeautifulSoup
 * parity). ``download_from_page`` downloads through the pinned public-HTTP
 * client (browser headers + the crawler's per-host pacing) and stages the
 * verified bytes into an immutable content-addressed SourceAsset with a
 * DownloadAttempt record.
 *
 * Deviation from the P5-D3 ``acquireSource`` note: Python's
 * ``download_from_page`` uses ``crawler_facade.download`` + the
 * ``SourceAssetWorkspace`` staging API, NOT ``acquire_source`` — because that
 * function enforces a curated HTTPS exact-host allowlist (NCBI/GDC/PDB/...),
 * which cannot validate arbitrary public download URLs. The Node port has no
 * staging workspace, so this tool performs the equivalent verified staging
 * itself (sha256-addressed atomic publication under ``source_assets/``,
 * content-cache blob publication, DownloadAttempt + SourceAsset records with
 * the exact downloader shapes). The transport is the same policy-pinned
 * ``PublicHttpClient`` the crawler download tier uses.
 *
 * HTTP concerns (browser UA, Referer, rate limiting) are owned by the unified
 * crawler layer, mirroring the Python skill's delegation contract.
 */

import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { copyFile, link, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";

import type { BioMedAgentTool } from "../contracts.js";
import type { ContentCache } from "../../external/acquisition/content-cache.js";
import { canonicalRequestHash } from "../../external/acquisition/content-cache.js";
import { ensureAcquisitionDirs, sourceAssetPath, taskWorkDirs, assertSafeFilename } from "../../external/acquisition/workdir.js";
import type { PublicHttpClient } from "../../external/network/http-client.js";
import type { CrawlerFacade } from "../../external/crawler/index.js";
import { BROWSER_HEADERS, MAX_CRAWLER_DOWNLOAD_BYTES } from "../../external/crawler/index.js";
import { makeSourceId } from "../../external/sources/fallback.js";
import { DATA_LEVEL, DATABASE } from "../../dataset/contracts/enums.js";
import type { DownloadAttempt, SourceAsset } from "../../dataset/contracts/source.js";
import { assetIdFromSha256 } from "../../dataset/adapters/identity.js";
import type { ToolHooks } from "./tool-hooks.js";
import { noopHooks } from "./tool-hooks.js";
import { errorMessage } from "./result.js";

const MAX_BODY_CHARS = 5000;
const SOURCE = "browser";

/** Python ``_validate_download_filename`` parity. */
function validateDownloadFilename(filename: string): void {
  assertSafeFilename(filename, "source asset filename is unsafe");
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

/** Downloader ``sha256File`` parity: streaming checksum of one local file. */
async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

/** Publish the verified part file into the content cache (atomic temp+rename). */
async function publishCacheBlob(partPath: string, blobPath: string, checksum: string): Promise<void> {
  await mkdir(path.dirname(blobPath), { recursive: true });
  const temporary = `${blobPath}.${randomUUID()}.tmp`;
  try {
    await copyFile(partPath, temporary);
    if ((await sha256File(temporary)) !== checksum) {
      throw new Error("published cache checksum mismatch");
    }
    await rename(temporary, blobPath);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export interface BrowserToolsOptions {
  /** Absolute task root (TaskWorkDir root) for acquired source assets. */
  taskRoot: string;
  cache: ContentCache;
  client: PublicHttpClient;
  crawler: CrawlerFacade;
  hooks?: ToolHooks;
  maxDownloadBytes?: number;
  downloadTimeoutMs?: number;
  /** Global cache registrar (raw downloads → data/cache). */
  registrar?: import("../../persistence/cache-registrar.js").CacheRegistrar | null;
  /** Task id used as cache provenance. */
  taskId?: string | (() => string);
}

export const NAVIGATE_PAGE_TOOL_NAME = "navigate_page";
export const DOWNLOAD_FROM_PAGE_TOOL_NAME = "download_from_page";

export function createBrowserTools(options: BrowserToolsOptions): BioMedAgentTool[] & {
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
      "the <title> and visible body text (up to 5000 characters). Use for " +
      "direct web navigation and reading page content on any public URL.",
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
      hooks.onQueryStarted(url, SOURCE);
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
          content: JSON.stringify({ url, error: errorMessage(error) }),
        };
      }
    },
  };

  const downloadFromPage: BioMedAgentTool = {
    name: DOWNLOAD_FROM_PAGE_TOOL_NAME,
    label: "Download file from page",
    description:
      "Download a file through the pinned public-HTTP transport into immutable " +
      "source assets (bounded 4 GiB, address-pinned transport, browser " +
      "headers, per-host rate limiting). Use directly for any known public " +
      "file URL that needs verified acquisition.",
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
      hooks.onQueryStarted(filename, SOURCE);
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

        const sourceId = makeSourceId(DATABASE.BROWSER, filename, url);
        const attemptId = `download_attempt_${randomUUID()}`;
        const startedAt = new Date().toISOString();
        await options.crawler.pace(url);
        const response = await options.client.request(url, {
          headers: { ...BROWSER_HEADERS },
          signal,
          timeoutMs: options.downloadTimeoutMs,
        });
        if (response.status < 200 || response.status >= 300) {
          await response.discard();
          hooks.onQuery(filename, SOURCE, "failed", 0);
          return {
            content: JSON.stringify({
              source: SOURCE,
              accession: filename,
              source_url: url,
              local_files: [],
              error: `HTTP ${response.status}`,
            }),
          };
        }
        const mediaType = (response.headers["content-type"] ?? "application/octet-stream")
          .split(";", 1)[0]
          .trim()
          .toLowerCase();

        await ensureAcquisitionDirs(dirs);
        const partPath = path.join(dirs.downloadTmp, `${attemptId}.part`);
        const hash = createHash("sha256");
        let bytesReceived = 0;
        const target = createWriteStream(partPath, { flags: "wx" });
        try {
          for await (const chunk of response.body) {
            if (signal?.aborted === true) {
              throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
            }
            bytesReceived += chunk.length;
            const maxDownloadBytes = options.maxDownloadBytes ?? MAX_CRAWLER_DOWNLOAD_BYTES;
            if (bytesReceived > maxDownloadBytes) {
              throw new Error(`browser download exceeded ${maxDownloadBytes} byte limit`);
            }
            hash.update(chunk);
            await new Promise<void>((resolveWrite, rejectWrite) => {
              target.write(chunk, (error) => (error ? rejectWrite(error) : resolveWrite()));
            });
          }
          await new Promise<void>((resolveEnd, rejectEnd) => {
            target.end(() => resolveEnd());
            target.on("error", (error: Error) => rejectEnd(error));
          });
        } catch (error) {
          await unlink(partPath).catch(() => undefined);
          throw error;
        } finally {
          target.destroy();
        }
        if (bytesReceived === 0) {
          await unlink(partPath).catch(() => undefined);
          throw new Error("download was empty");
        }
        const checksum = hash.digest("hex");
        const assetId = assetIdFromSha256(checksum);
        const finishedAt = new Date().toISOString();

        // Content-cache blob publication (download parity) before the task
        // asset publication.
        const blobPath = options.cache.blobPath(checksum);
        const cached = await stat(blobPath).catch(() => null);
        if (cached === null || !cached.isFile()) {
          await publishCacheBlob(partPath, blobPath, checksum);
        }
        const destination = sourceAssetPath(dirs, assetId, filename);
        await mkdir(path.dirname(destination), { recursive: true });
        const existing = await stat(destination).catch(() => null);
        if (existing !== null && existing.isFile()) {
          if ((await sha256File(destination)) !== checksum) {
            throw new Error("existing task asset differs");
          }
          await unlink(partPath).catch(() => undefined);
        } else {
          try {
            await link(partPath, destination);
          } catch {
            await copyFile(partPath, destination);
          }
          await unlink(partPath).catch(() => undefined);
          if ((await sha256File(destination)) !== checksum) {
            throw new Error("task asset checksum mismatch");
          }
        }
        await options.cache.writeMetadata(
          canonicalRequestHash(DATABASE.BROWSER, filename, url),
          { sha256: checksum, size_bytes: String(bytesReceived), media_type: mediaType },
        );
        options.registrar?.register("browser", {
          filename,
          filePath: destination,
          sha256: checksum,
          sizeBytes: bytesReceived,
          mediaType,
          sourceUrl: url,
          sourceDatabase: DATABASE.BROWSER,
        }, options.taskId);

        const attempt: DownloadAttempt = {
          schema_version: "1.0",
          attempt_id: attemptId,
          source_id: sourceId,
          url,
          status: "succeeded",
          bytes_received: bytesReceived,
          error_code: null,
          error_message: null,
          started_at: startedAt,
          finished_at: finishedAt,
        };
        const asset: SourceAsset = {
          schema_version: "1.0",
          asset_id: assetId,
          kind: "source",
          relative_path: path.relative(dirs.root, destination).split(path.sep).join("/"),
          sha256: checksum,
          size_bytes: bytesReceived,
          media_type: mediaType,
          generated_by_step_id: null,
          source_id: sourceId,
          successful_attempt_id: attemptId,
          derived_from_asset_id: null,
          data_level: DATA_LEVEL.METADATA,
        };
        hooks.onQuery(filename, SOURCE, "success", 1);
        return {
          content: JSON.stringify({
            source: SOURCE,
            source_url: url,
            local_files: [destination],
            mime_type: mediaType,
            bytes_received: bytesReceived,
            retrieved_at: finishedAt,
            source_asset: asset,
            download_attempt: attempt,
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
            error: errorMessage(error),
          }),
        };
      }
    },
  };

  return Object.assign([navigatePage, downloadFromPage], { navigatePage, downloadFromPage });
}
