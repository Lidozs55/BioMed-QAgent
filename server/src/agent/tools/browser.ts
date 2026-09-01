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
import {
  BROWSER_ACQUISITION_POLICY_REVISION,
  BROWSER_ACQUISITION_PROVIDER_ID,
  BROWSER_ACQUISITION_PROVIDER_IMPLEMENTATION_DIGEST,
  type BrowserAcquisitionEvidence,
} from "@biomed/contracts";
import type { ContentCache } from "../../external/acquisition/content-cache.js";
import { canonicalRequestHash } from "../../external/acquisition/content-cache.js";
import { ensureAcquisitionDirs, sourceAssetPath, taskWorkDirs, assertSafeFilename } from "../../external/acquisition/workdir.js";
import type { PublicHttpClient } from "../../external/network/http-client.js";
import type { CrawlerFacade } from "../../external/crawler/index.js";
import { BROWSER_HEADERS, MAX_CRAWLER_DOWNLOAD_BYTES } from "../../external/crawler/index.js";
import { MAX_BROWSER_CONTENT_BYTES } from "../../external/browser/index.js";
import { makeSourceId } from "../../external/sources/fallback.js";
import { DATA_LEVEL, DATABASE } from "../../dataset/contracts/enums.js";
import type { DownloadAttempt, SourceAsset } from "../../dataset/contracts/source.js";
import { assetIdFromSha256, canonicalDigest } from "../../dataset/adapters/identity.js";
import type { ToolHooks } from "./tool-hooks.js";
import type { BrowserAcquisitionEvidenceStore } from "../../runtime/browser-acquisition-store.js";
import { BrowserAcquisitionProposalStore } from "../../runtime/browser-acquisition-proposal-store.js";
import type { DatasetHILGate } from "../../dataset/review/hil-policy.js";
import type { BrowserFormalizationService, BrowserParserRecipeResolver } from "../../dataset/acquisition/browser-formalization.js";
import { computeHILEvidenceDigest } from "../../dataset/contracts/hil-evidence.js";
import { noopHooks } from "./tool-hooks.js";
import { errorMessage } from "./result.js";

const MAX_BODY_CHARS = 5000;
/** Hard ceiling for one navigate_page body-text window; longer pages are read through `offset` windows. */
const MAX_BODY_CHARS_LIMIT = 20000;
/** Bounded link list so download entries on list pages are discoverable without reading the full body. */
const MAX_PAGE_LINKS = 50;
const MAX_LINK_TEXT_CHARS = 120;
const SKIP_LINK_PATTERN = /^(?:javascript|mailto|tel|data):/i;
const SOURCE = "browser";
const BROWSER_PROVIDER_IMPLEMENTATION_DIGEST = BROWSER_ACQUISITION_PROVIDER_IMPLEMENTATION_DIGEST;
const HOST_FAIL_FAST_THRESHOLD = 2;

/** Python ``_validate_download_filename`` parity. */
function validateDownloadFilename(filename: string): void {
  assertSafeFilename(filename, "source asset filename is unsafe");
}

function urlHostname(value: string): string | null {
  try {
    return new URL(value).hostname || null;
  } catch {
    return null;
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

/**
 * Node-side addition beyond Python parity: absolute-resolved, deduplicated
 * in-document links in document order (fragment-only, scheme-less-empty and
 * non-http(s) navigation links are dropped) so the Agent can discover download
 * entries from list pages that exceed the body-text window.
 */
function extractLinks(html: string, baseUrl: string): { links: Array<{ href: string; text: string }>; total: number } {
  const $ = load(html);
  const links: Array<{ href: string; text: string }> = [];
  const seen = new Set<string>();
  let total = 0;
  for (const element of $("a[href]").toArray()) {
    const raw = ($(element).attr("href") ?? "").trim();
    if (raw === "" || raw.startsWith("#") || SKIP_LINK_PATTERN.test(raw)) continue;
    let absolute: string;
    try {
      absolute = new URL(raw, baseUrl).toString();
    } catch {
      continue;
    }
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    total += 1;
    if (links.length < MAX_PAGE_LINKS) {
      links.push({
        href: absolute,
        text: $(element).text().replace(/\s+/g, " ").trim().slice(0, MAX_LINK_TEXT_CHARS),
      });
    }
  }
  return { links, total };
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
  /**
   * Task-owned source-asset registry. When present, successful downloads are
   * registered here right after publication so ``preview_core_asset`` can
   * immediately resolve them (model-blockers I3: downloads reached only the
   * global cache, so preview reported "registered asset was not found").
   */
  sourceAssetRegistry?: import("../../runtime/source-assets/registry.js").SourceAssetRegistry | null;
  /** Run id used to bind browser evidence to one durable run. */
  runId?: string | (() => string);
  evidenceStore?: BrowserAcquisitionEvidenceStore;
  proposalStore?: BrowserAcquisitionProposalStore;
  formalizationHIL?: DatasetHILGate;
  formalizationService?: BrowserFormalizationService;
  recipeRegistry?: BrowserParserRecipeResolver & { list(): string[] };
}

export const NAVIGATE_PAGE_TOOL_NAME = "navigate_page";
export const DOWNLOAD_FROM_PAGE_TOOL_NAME = "download_from_page";
export const PROPOSE_BROWSER_FORMALIZATION_TOOL_NAME = "propose_browser_evidence_acceptance";

export function createBrowserTools(options: BrowserToolsOptions): BioMedAgentTool[] & {
  navigatePage: BioMedAgentTool;
  downloadFromPage: BioMedAgentTool;
  proposeFormalization: BioMedAgentTool;
} {
  const hooks = noopHooks(options.hooks);
  const hostFailureCounts = new Map<string, number>();

  const publishBrowserAcquisition = async (input: {
    requestedUrl: string;
    finalUrl: string;
    redirectChain: BrowserAcquisitionEvidence["redirect_chain"];
    status: number;
    mediaType: string;
    filename: string;
    body: AsyncIterable<Buffer>;
    startedAt: string;
    attemptId: string;
    maxBytes: number;
    signal?: AbortSignal;
  }) => {
    validateDownloadFilename(input.filename);
    const dirs = taskWorkDirs(options.taskRoot);
    await ensureAcquisitionDirs(dirs);
    const sourceId = makeSourceId(DATABASE.BROWSER, input.filename, input.requestedUrl);
    const partPath = path.join(dirs.downloadTmp, `${input.attemptId}.part`);
    const hash = createHash("sha256");
    let bytesReceived = 0;
    const target = createWriteStream(partPath, { flags: "wx" });
    try {
      try {
        for await (const chunk of input.body) {
          if (input.signal?.aborted === true) {
            throw input.signal.reason instanceof Error ? input.signal.reason : new Error("aborted");
          }
          bytesReceived += chunk.length;
          if (bytesReceived > input.maxBytes) {
            throw new Error(`browser acquisition exceeded ${input.maxBytes} byte limit`);
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
      } finally {
        target.destroy();
      }
      if (bytesReceived === 0) throw new Error("download was empty");

      const checksum = hash.digest("hex");
      const assetId = assetIdFromSha256(checksum);
      const finishedAt = new Date().toISOString();
      const blobPath = options.cache.blobPath(checksum);
      const cached = await stat(blobPath).catch(() => null);
      if (cached === null || !cached.isFile()) {
        await publishCacheBlob(partPath, blobPath, checksum);
      }

      const destination = sourceAssetPath(dirs, assetId, input.filename);
      await mkdir(path.dirname(destination), { recursive: true });
      const existing = await stat(destination).catch(() => null);
      if (existing !== null && existing.isFile()) {
        if ((await sha256File(destination)) !== checksum) {
          throw new Error("existing task asset differs");
        }
      } else {
        try {
          await link(partPath, destination);
        } catch {
          await copyFile(partPath, destination);
        }
        if ((await sha256File(destination)) !== checksum) {
          throw new Error("task asset checksum mismatch");
        }
      }

      await options.cache.writeMetadata(
        canonicalRequestHash(DATABASE.BROWSER, input.filename, input.requestedUrl),
        { sha256: checksum, size_bytes: String(bytesReceived), media_type: input.mediaType },
      );
      options.registrar?.register("browser", {
        filename: input.filename,
        filePath: destination,
        sha256: checksum,
        sizeBytes: bytesReceived,
        mediaType: input.mediaType,
        sourceUrl: input.requestedUrl,
        sourceDatabase: DATABASE.BROWSER,
      }, options.taskId);

      const attempt: DownloadAttempt = {
        schema_version: "1.0",
        attempt_id: input.attemptId,
        source_id: sourceId,
        url: input.requestedUrl,
        status: "succeeded",
        bytes_received: bytesReceived,
        error_code: null,
        error_message: null,
        started_at: input.startedAt,
        finished_at: finishedAt,
      };
      const asset: SourceAsset = {
        schema_version: "1.0",
        asset_id: assetId,
        kind: "source",
        relative_path: path.relative(dirs.root, destination).split(path.sep).join("/"),
        sha256: checksum,
        size_bytes: bytesReceived,
        media_type: input.mediaType,
        generated_by_step_id: null,
        source_id: sourceId,
        successful_attempt_id: input.attemptId,
        derived_from_asset_id: null,
        data_level: DATA_LEVEL.METADATA,
      };
      const registrationReceipt = options.sourceAssetRegistry === undefined || options.sourceAssetRegistry === null
        ? null
        : await options.sourceAssetRegistry.register({
            sourceId,
            relativePath: asset.relative_path,
            mediaType: input.mediaType,
          });
      const taskId = typeof options.taskId === "function" ? options.taskId() : options.taskId ?? "unknown_task";
      const runId = typeof options.runId === "function" ? options.runId() : options.runId ?? null;
      const evidence: BrowserAcquisitionEvidence = {
        schema_version: "1.0",
        evidence_id: `browser_evidence_${canonicalDigest({
          taskId,
          runId,
          attemptId: input.attemptId,
          checksum,
          requestedUrl: input.requestedUrl,
          finalUrl: input.finalUrl,
        }).slice(0, 32)}`,
        task_id: taskId,
        run_id: runId,
        requested_url: input.requestedUrl,
        final_url: input.finalUrl,
        redirect_chain: input.redirectChain,
        status: input.status,
        media_type: input.mediaType,
        retrieved_at: finishedAt,
        bytes_received: bytesReceived,
        sha256: checksum,
        browser_policy_revision: BROWSER_ACQUISITION_POLICY_REVISION,
        source_asset_id: asset.asset_id,
        source_id: asset.source_id,
        relative_path: asset.relative_path,
        download_attempt_id: attempt.attempt_id,
        provider_id: BROWSER_ACQUISITION_PROVIDER_ID,
        provider_implementation_digest: BROWSER_PROVIDER_IMPLEMENTATION_DIGEST,
      };
      const persistedEvidence = options.evidenceStore === undefined
        ? null
        : await options.evidenceStore.put(evidence);
      return {
        destination,
        bytesReceived,
        finishedAt,
        asset,
        registrationReceipt,
        attempt,
        evidence,
        evidenceDigest: persistedEvidence?.evidenceDigest ?? canonicalDigest(evidence),
      };
    } finally {
      target.destroy();
      await unlink(partPath).catch(() => undefined);
    }
  };

  const navigatePage: BioMedAgentTool = {
    name: NAVIGATE_PAGE_TOOL_NAME,
    label: "Navigate web page",
    description:
      "Navigate with the guarded Playwright crawler (real browser headers, " +
      "2s rate limiting) and return page metadata, cleaned visible text, and links. " +
      "Extracts the <title>, a visible body-text window (default 5000 " +
      "characters, up to 20000 via max_chars; page through longer text with " +
      "offset), and up to 50 deduplicated absolute links with anchor text " +
      "(links_total counts the rest). Set archive_html=true to persist the " +
      "complete rendered DOM HTML as a verified SourceAsset; the HTML is not " +
      "inlined into the tool response. Use for direct web navigation and page " +
      "content on any public URL.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Target HTTP(S) URL. Must resolve to a public address." },
        max_chars: {
          type: "integer",
          default: 5000,
          description: "Body-text window length to return (default 5000, max 20000).",
        },
        offset: {
          type: "integer",
          default: 0,
          description:
            "Start position in the extracted body text (default 0). Use with " +
            "body_text_truncated/body_text_total_chars to read long pages in windows.",
        },
        archive_html: {
          type: "boolean",
          default: false,
          description:
            "Persist the complete rendered DOM HTML as a verified SourceAsset. " +
            "The response still contains cleaned text and asset metadata, not inline HTML.",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
    execute: async (argumentsValue, signal) => {
      const record = argumentsValue as { url?: unknown; max_chars?: unknown; offset?: unknown; archive_html?: unknown };
      const url = typeof record.url === "string" ? record.url : "";
      const archiveHtml = record.archive_html === true;
      const maxChars =
        typeof record.max_chars === "number" && Number.isInteger(record.max_chars) && record.max_chars > 0
          ? Math.min(record.max_chars, MAX_BODY_CHARS_LIMIT)
          : MAX_BODY_CHARS;
      const offset =
        typeof record.offset === "number" && Number.isInteger(record.offset) && record.offset > 0
          ? record.offset
          : 0;
      hooks.onQueryStarted(url, SOURCE);
      const startedAt = new Date().toISOString();
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
            isError: true,
          };
        }
        const html = result.content;
        const finalUrl = result.url || url;
        const bodyText = extractBodyText(html);
        const { links, total: linksTotal } = extractLinks(html, finalUrl);
        const page = {
          url,
          final_url: finalUrl,
          redirect_chain: result.redirect_chain ?? [],
          status_code: result.status_code,
          method_used: result.method_used,
          title: extractTitle(html),
          body_text_preview: bodyText.slice(offset, offset + maxChars),
          body_text_offset: offset,
          body_text_total_chars: bodyText.length,
          body_text_truncated: offset + maxChars < bodyText.length,
          links,
          links_total: linksTotal,
          content_type: result.headers["content-type"] ?? "",
          html_archived: archiveHtml,
        };
        if (!archiveHtml) {
          hooks.onQuery(url, SOURCE, "success", 1);
          return { content: JSON.stringify(page) };
        }

        const htmlBytes = Buffer.from(html, "utf8");
        const filename = `rendered-page-${createHash("sha256").update(finalUrl, "utf8").digest("hex").slice(0, 16)}.html`;
        const attemptId = `download_attempt_${randomUUID()}`;
        const published = await publishBrowserAcquisition({
          requestedUrl: url,
          finalUrl,
          redirectChain: result.redirect_chain ?? [],
          status: result.status_code,
          mediaType: "text/html",
          filename,
          body: (async function* renderedHtml(): AsyncIterable<Buffer> {
            yield htmlBytes;
          })(),
          startedAt,
          attemptId,
          maxBytes: MAX_BROWSER_CONTENT_BYTES,
          signal,
        });
        hooks.onQuery(url, SOURCE, "success", 1);
        return {
          content: JSON.stringify({
            ...page,
            source: SOURCE,
            source_url: url,
            local_files: [published.destination],
            mime_type: "text/html",
            bytes_received: published.bytesReceived,
            retrieved_at: published.finishedAt,
            source_asset: published.asset,
            source_asset_registration_receipt: published.registrationReceipt,
            download_attempt: published.attempt,
            browser_acquisition_evidence: published.evidence,
            browser_evidence_digest: published.evidenceDigest,
            formal_status: "preparation_only",
          }),
        };
      } catch (error) {
        if (signal?.aborted === true) throw error;
        hooks.onQuery(url, SOURCE, "failed", 0);
        return {
          content: JSON.stringify({ url, error: errorMessage(error) }),
          isError: true,
        };
      }
    },
  };

  const proposeFormalization: BioMedAgentTool = {
    name: PROPOSE_BROWSER_FORMALIZATION_TOOL_NAME,
    label: "Request browser evidence acceptance",
    description: "Request one Core-owned review for the complete browser evidence and binding. recipe_id must be a Core-promoted browser.registered.* recipe; unknown recipes fail before HIL. Acceptance authorizes the deterministic Core pipeline, not arbitrary code or data changes.",
    parameters: {
      type: "object",
      properties: {
        evidence_id: { type: "string" },
        recipe_id: { type: "string" },
        recipe_version: { type: "string" },
        binding_id: { type: "string" },
        family_id: { type: "string" },
        schema_ref: { type: "string" },
        table_id: { type: "string" },
        input_role: { type: "string" },
        intended_role: { type: "string", enum: ["source", "mapping", "metadata", "carrier"] },
      },
      required: ["evidence_id", "recipe_id", "recipe_version", "binding_id", "family_id", "schema_ref", "table_id", "input_role", "intended_role"],
      additionalProperties: false,
    },
    execute: async (argumentsValue, signal) => {
      if (options.evidenceStore === undefined || options.proposalStore === undefined || options.formalizationHIL === undefined || options.formalizationService === undefined || options.recipeRegistry === undefined) {
        throw new Error("browser formalization is unavailable without Core evidence/proposal/HIL/recipe services");
      }
      const record = argumentsValue as Record<string, unknown>;
      const evidenceId = typeof record.evidence_id === "string" ? record.evidence_id : "";
      const recipeId = typeof record.recipe_id === "string" ? record.recipe_id : "";
      const recipeVersion = typeof record.recipe_version === "string" ? record.recipe_version : "";
      const bindingId = typeof record.binding_id === "string" ? record.binding_id : "";
      const familyId = typeof record.family_id === "string" ? record.family_id : "";
      const schemaRef = typeof record.schema_ref === "string" ? record.schema_ref : "";
      const tableId = typeof record.table_id === "string" ? record.table_id : "";
      const inputRole = typeof record.input_role === "string" ? record.input_role : "";
      const intendedRole = typeof record.intended_role === "string" ? record.intended_role : "";
      const stored = await options.evidenceStore.get(evidenceId);
      let promotedRecipe;
      try {
        promotedRecipe = options.recipeRegistry.resolve(recipeId, recipeVersion, stored.evidence);
      } catch (error) {
        const available = options.recipeRegistry.list();
        throw new Error(`${errorMessage(error)}; available PROMOTED browser recipes: ${available.length === 0 ? "none" : available.join(", ")}`, { cause: error });
      }
      if (promotedRecipe.schema_ref !== schemaRef) {
        throw new Error(`browser recipe schema does not match proposal schema binding: expected ${promotedRecipe.schema_ref}`);
      }
      const taskId = typeof options.taskId === "function" ? options.taskId() : options.taskId;
      const runId = typeof options.runId === "function" ? options.runId() : options.runId;
      if (!taskId || !runId) throw new Error("browser formalization requires task and run identity");
      const now = new Date().toISOString();
      const proposal = await options.proposalStore.put({
        schema_version: "1.0",
        proposal_id: `browser_proposal_${canonicalDigest({ evidence: stored.evidenceDigest, recipeId, recipeVersion, bindingId, familyId, schemaRef, tableId, inputRole }).slice(0, 32)}`,
        evidence_digest: stored.evidenceDigest,
        task_id: taskId,
        run_id: runId,
        requirement_id: null,
        generation: 1,
        recipe_id: recipeId,
        recipe_version: recipeVersion,
        binding_id: bindingId,
        family_id: familyId,
        schema_ref: schemaRef,
        table_id: tableId,
        input_role: inputRole,
        intended_role: intendedRole as "source" | "mapping" | "metadata" | "carrier",
        status: "hil_pending",
        created_at: now,
        updated_at: now,
        failure_reason: null,
      });
      const request: Parameters<DatasetHILGate["requestHIL"]>[0] = {
        requirement_id: null,
        kind: "data_review",
        review_type: "browser_evidence_acceptance",
        blocking: true,
        subject: {
          binding_id: bindingId,
          table_ids: [tableId],
          evidence_ids: [evidenceId],
          source_asset_ids: [stored.evidence.source_asset_id],
          locator_urls: [stored.evidence.final_url],
        },
        review_items: [],
        summary: `Review browser evidence ${evidenceId} for Core formalization`,
        evidence: {
          evidence_id: evidenceId,
          evidence_digest: stored.evidenceDigest,
          requested_url: stored.evidence.requested_url,
          final_url: stored.evidence.final_url,
          redirect_chain: stored.evidence.redirect_chain.map((hop) => ({
            from_url: hop.from_url,
            to_url: hop.to_url,
            status: hop.status,
          })),
          media_type: stored.evidence.media_type,
          bytes_received: stored.evidence.bytes_received,
          sha256: stored.evidence.sha256,
          recipe_id: recipeId,
          recipe_version: recipeVersion,
          recipe_implementation_digest: promotedRecipe.ref.implementation_digest,
          binding_id: bindingId,
          family_id: familyId,
          schema_ref: schemaRef,
          table_id: tableId,
          input_role: inputRole,
        },
        policy_ref: "browser.acquisition.evidence-acceptance.v1",
        idempotency_key: `browser-formalization:${proposal.proposal_id}`,
      };
      const expectedHILEvidenceDigest = computeHILEvidenceDigest(request);
      const review = await options.formalizationHIL.requestHIL(request, signal);
      const accepted = review.decision.action === "accept";
      await options.proposalStore.update(proposal.proposal_id, {
        status: accepted ? "accepted" : "rejected",
        failure_reason: accepted ? null : `formalization review ${review.decision.action}`,
      });
      if (!accepted) {
        return { content: JSON.stringify({ proposal, review, formalization_status: "rejected", publication_status: "not_published" }) };
      }
      try {
        const formalized = await options.formalizationService.formalize({
          proposal,
          evidence: stored.evidence,
          review,
          expectedHILEvidenceDigest,
          acceptedBrowserEvidenceDigests: [stored.evidenceDigest],
        });
        return { content: JSON.stringify({ proposal: formalized.proposal, review, formalization_status: "formalized", browser_evidence_acceptance: { request_id: review.request_id, review_id: review.review_id, hil_evidence_digest: review.evidence_digest, accepted_browser_evidence_digests: [stored.evidenceDigest], reviewer: review.reviewer, reviewed_at: review.reviewed_at, reason: review.reason }, registration: formalized.registration, publication_status: "pipeline_continues_without_additional_browser_review" }) };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const failed = await options.proposalStore.update(proposal.proposal_id, { status: "failed", failure_reason: reason });
        throw new Error(`browser formalization failed for ${failed.proposal_id}: ${reason}`, { cause: error });
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
      const hostname = urlHostname(url);
      if (hostname !== null && (hostFailureCounts.get(hostname) ?? 0) >= HOST_FAIL_FAST_THRESHOLD) {
        hooks.onQuery(filename, SOURCE, "failed", 0);
        return {
          content: JSON.stringify({
            source: SOURCE,
            accession: filename,
            source_url: url,
            local_files: [],
            no_data: true,
            error: `host is unreachable: ${hostname}`,
          }),
          isError: true,
        };
      }
      let transportStarted = false;
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

        const attemptId = `download_attempt_${randomUUID()}`;
        const startedAt = new Date().toISOString();
        await options.crawler.pace(url);
        transportStarted = true;
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
            isError: true,
          };
        }
        const mediaType = (response.headers["content-type"] ?? "application/octet-stream")
          .split(";", 1)[0]
          .trim()
          .toLowerCase();

        const published = await publishBrowserAcquisition({
          requestedUrl: url,
          finalUrl: response.url ?? url,
          redirectChain: response.redirectChain ?? [],
          status: response.status,
          mediaType,
          filename,
          body: response.body,
          startedAt,
          attemptId,
          maxBytes: options.maxDownloadBytes ?? MAX_CRAWLER_DOWNLOAD_BYTES,
          signal,
        });
        if (hostname !== null) {
          hostFailureCounts.set(hostname, 0);
        }
        hooks.onQuery(filename, SOURCE, "success", 1);
        return {
          content: JSON.stringify({
            source: SOURCE,
            source_url: url,
            local_files: [published.destination],
            mime_type: mediaType,
            bytes_received: published.bytesReceived,
            retrieved_at: published.finishedAt,
            source_asset: published.asset,
            source_asset_registration_receipt: published.registrationReceipt,
            download_attempt: published.attempt,
            browser_acquisition_evidence: published.evidence,
            browser_evidence_digest: published.evidenceDigest,
            formal_status: "preparation_only",
          }),
        };
      } catch (error) {
        if (signal?.aborted === true) throw error;
        if (hostname !== null && transportStarted) {
          hostFailureCounts.set(hostname, (hostFailureCounts.get(hostname) ?? 0) + 1);
        }
        hooks.onQuery(filename, SOURCE, "failed", 0);
        return {
          content: JSON.stringify({
            source: SOURCE,
            accession: filename,
            source_url: url,
            error: errorMessage(error),
          }),
          isError: true,
        };
      }
    },
  };

  return Object.assign([navigatePage, downloadFromPage, proposeFormalization], {
    navigatePage,
    downloadFromPage,
    proposeFormalization,
  });
}
