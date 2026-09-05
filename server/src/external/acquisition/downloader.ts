/**
 * Verified streaming acquisition of immutable source bytes (Python
 * ``app/integrations/acquisition.py`` parity).
 *
 * P5-D3: this is the single sanctioned path that produces SourceAssets. Agent
 * tools never fetch + write files themselves; they call ``acquireSource``
 * which owns policy, streaming, size limits, hashing, expected checksums,
 * media type checks, content cache, atomic source_assets publication,
 * DownloadAttempt records, progress and cancellation.
 */

import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { link, mkdir, open, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  AcquisitionResult,
  DownloadAttempt,
  SourceAsset,
  SourceRecord,
} from "../../dataset/contracts/source.js";
import type { DataLevel } from "../../dataset/contracts/enums.js";
import { assetIdFromSha256 } from "../../dataset/adapters/identity.js";
import { AcquisitionError, classifyTransportFailure, httpFailureCode, isAbortError } from "../network/errors.js";
import { UnsafeUrlError } from "../network/errors.js";
import { PublicHttpClient } from "../network/http-client.js";
import { validateHttpsSourceUrl } from "../network/url-policy.js";
import { ContentCache, canonicalRequestHash } from "./content-cache.js";
import {
  assertSafeFilename,
  ensureAcquisitionDirs,
  sourceAssetPath,
  taskWorkDirs,
  type TaskWorkDirs,
} from "./workdir.js";

/**
 * Byte-level download progress sink accepted by ``acquireSource``.
 *
 * This is a duck-typed protocol, not an import from the agent layer: the
 * ``external`` acquisition path never depends on ``agent/tools/tool-hooks``.
 * The host (e.g. ``createDownloadProgressReporter``) supplies a throttled live
 * callback plus an optional ``finalize`` sink that is **not** subject to
 * throttling. ``acquireSource`` calls ``finalize`` once on every success path
 * (cache hit or streamed download) with the exact final byte count, so the UI
 * reaches 100% instead of freezing on the last throttled tick — callers never
 * have to emit the terminal event themselves.
 */
export interface AcquisitionProgress {
  (bytesReceived: number, declared: number | null): void | Promise<void>;
  /** Called once by ``acquireSource`` on success; bypasses throttling. */
  finalize?(bytesReceived: number, total: number): void | Promise<void>;
}

export const CURATED_SOURCE_HOSTS: ReadonlySet<string> = new Set([
  // NCBI (PubMed, GEO, PMC)
  "ftp.ncbi.nlm.nih.gov",
  "eutils.ncbi.nlm.nih.gov",
  "www.ncbi.nlm.nih.gov",
  // GDC
  "api.gdc.cancer.gov",
  // RCSB PDB
  "files.rcsb.org",
  "search.rcsb.org",
  "data.rcsb.org",
  // PubChem
  "pubchem.ncbi.nlm.nih.gov",
  // Reactome
  "reactome.org",
  // UCSC Xena (S3)
  "toil-xena-hub.s3.us-east-1.amazonaws.com",
  "tcga-xena-hub.s3.us-east-1.amazonaws.com",
  // Unpaywall (DOI → OA PDF URL lookup)
  "api.unpaywall.org",
  // Europe PMC (PMCID → fullTextXML)
  "www.ebi.ac.uk",
  // Gold9 official biomedical response forms
  "www.orphadata.com",
  "storage.googleapis.com",
  "search.clinicalgenome.org",
]);

/**
 * Provider-declared pagination for JSON list APIs. When present the
 * downloader fetches successive pages — stepping the `offset` query parameter
 * by `pageSize` — and merges the arrays found at `recordsPath` into a single
 * registered JSON asset. All caps fail loudly: a pagination run that exceeds
 * `maxRecords` or `maxPages` is an acquisition error, never a silent
 * truncation.
 */
export interface AcquisitionPaginationSpec {
  /** Dot path to the record array inside each JSON page (e.g. "activities"). */
  recordsPath: string;
  /** Records requested per page; sent as the `limit` query parameter. */
  pageSize: number;
  /** Loud-failure bound on total accumulated records across pages. */
  maxRecords: number;
  /** Loud-failure bound on the number of page requests. */
  maxPages: number;
}

export interface AcquireSourceOptions {
  source: SourceRecord;
  filename: string;
  workdirRoot: string;
  cache: ContentCache;
  client: PublicHttpClient;
  dataLevel: DataLevel;
  maxBytes: number;
  expectedSize?: number;
  expectedSha256?: string;
  expectedMd5?: string;
  expectedMediaTypes?: ReadonlySet<string>;
  accept?: string;
  requestHeaders?: Readonly<Record<string, string>>;
  /**
   * HTTP method for this acquisition; defaults to GET. POST sends `body` as
   * JSON and is never resumable (no Range support); GET behavior is
   * unchanged and remains the only resumable method.
   */
  method?: "GET" | "POST";
  /** Raw request body for POST acquisitions; forbidden for GET. */
  body?: string;
  progress?: AcquisitionProgress;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Extra per-hop validator for recipe/declarative hosts. Defaults to curated. */
  allowedHosts?: ReadonlySet<string>;
  /** DNS resolver for policy checks; defaults to the client's resolver. */
  resolve?: import("../network/dns.js").AddressResolver;
  /**
   * Caller-owned part file. When provided the downloader writes into this
   * exact path and, on non-abort stream failures, leaves the partial file in
   * place so the caller can resume (or clean it up). Defaults to a fresh
   * `download_attempt_<uuid>.part` that is always cleaned up on failure.
   */
  partPath?: string;
  /**
   * Resume an existing `partPath` of exactly this many bytes: sends
   * `Range: bytes=<resumeFromBytes>-` and appends on HTTP 206; on HTTP 200
   * (Range ignored) restarts from scratch into the same file. The final
   * checksum covers the whole file (prefix re-hashed).
   */
  resumeFromBytes?: number;
  /**
   * Provider-declared JSON pagination. When present the request streams the
   * first page from `source.url` (`limit` = pageSize, `offset` = 0) and then
   * fetches further pages by stepping `offset`; the merged document is
   * published as one asset. Mutually exclusive with resume (resumable single
   * downloads) and POST bodies.
   */
  pagination?: AcquisitionPaginationSpec;
  /**
   * Called once after a verified file is published (cache hit or fresh
   * download) with the immutable destination path and its hashes. The host
   * uses this to register the raw file into the global dataset cache; the
   * external layer never imports the persistence layer.
   */
  onPublished?: (published: {
    filename: string;
    filePath: string;
    sha256: string;
    sizeBytes: number;
    mediaType: string;
    sourceUrl: string;
    sourceDatabase: string;
  }) => void | Promise<void>;
}

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

/** Copy through a verified sibling temp file before atomic publication. */
async function copyVerifiedAtomic(
  source: string,
  destination: string,
  checksum: string,
  mismatchMessage: string,
): Promise<void> {
  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true });
  const temporary = path.join(parent, `.${path.basename(destination)}.${randomUUID()}.tmp`);
  try {
    const sourceHandle = await open(source, "r");
    let targetHandle: Awaited<ReturnType<typeof open>>;
    try {
      targetHandle = await open(temporary, "wx");
    } finally {
      await sourceHandle.close();
    }
    try {
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      const from = await open(source, "r");
      try {
        for (;;) {
          const { bytesRead } = await from.read(buffer, 0, buffer.length, null);
          if (bytesRead === 0) break;
          await targetHandle.write(buffer.subarray(0, bytesRead));
        }
      } finally {
        await from.close();
      }
      await targetHandle.sync();
    } finally {
      await targetHandle.close();
    }
    if ((await sha256File(temporary)) !== checksum) {
      throw new AcquisitionError("checksum_mismatch", mismatchMessage);
    }
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/** Content-addressed cache publication with verified atomic copy. */
async function publishCache(partPath: string, cache: ContentCache, checksum: string): Promise<string> {
  const blobPath = cache.blobPath(checksum);
  try {
    const existing = await stat(blobPath);
    if (existing.isFile()) {
      if ((await sha256File(blobPath)) !== checksum) {
        throw new AcquisitionError("checksum_mismatch", "cached blob checksum mismatch");
      }
      return blobPath;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await copyVerifiedAtomic(partPath, blobPath, checksum, "published cache checksum mismatch");
  return blobPath;
}

/** Task source_assets publication: hardlink when possible, verified copy otherwise. */
async function publishTaskAsset(
  blobPath: string,
  dirs: TaskWorkDirs,
  assetId: string,
  filename: string,
  checksum: string,
): Promise<string> {
  const destination = sourceAssetPath(dirs, assetId, filename);
  await mkdir(path.dirname(destination), { recursive: true });
  const existing = await stat(destination).catch(() => null);
  if (existing !== null && existing.isFile()) {
    if ((await sha256File(destination)) !== checksum) {
      throw new AcquisitionError("checksum_mismatch", "existing task asset differs");
    }
    return destination;
  }
  try {
    await link(blobPath, destination);
  } catch {
    // Hardlink unsupported (or lost a race): verified atomic copy instead.
    const raced = await stat(destination).catch(() => null);
    if (raced !== null && raced.isFile()) {
      if ((await sha256File(destination)) !== checksum) {
        throw new AcquisitionError("checksum_mismatch", "task asset checksum mismatch");
      }
      return destination;
    }
    await copyVerifiedAtomic(blobPath, destination, checksum, "task asset checksum mismatch");
  }
  if ((await sha256File(destination)) !== checksum) {
    throw new AcquisitionError("checksum_mismatch", "task asset checksum mismatch");
  }
  return destination;
}

function mediaTypeFromHeader(headers: Record<string, string>): string {
  const raw = headers["content-type"] ?? headers["Content-Type"] ?? "application/octet-stream";
  return raw.split(";", 1)[0].trim().toLowerCase();
}

function errorCodeFrom(error: unknown): AcquisitionError["code"] {
  if (isAbortError(error)) {
    return error instanceof Error && error.name === "TimeoutError" ? "timeout" : "cancelled";
  }
  if (error instanceof AcquisitionError) return error.code;
  return classifyTransportFailure(error) ?? "internal_error";
}

/**
 * Download one immutable source asset. Returns a failed DownloadAttempt
 * (with the part file already cleaned) instead of throwing for
 * network/validation failures — Python parity. Cancellation propagates.
 */
export async function acquireSource(options: AcquireSourceOptions): Promise<AcquisitionResult> {
  if (options.pagination !== undefined) return acquireJsonPaginatedSource(options);
  const {
    source,
    filename,
    workdirRoot,
    cache,
    client,
    dataLevel,
    maxBytes,
    expectedSize,
    expectedSha256,
    expectedMd5,
    expectedMediaTypes,
    accept = "text/tab-separated-values",
    requestHeaders,
    method = "GET",
    body,
    progress,
    signal,
    allowedHosts = CURATED_SOURCE_HOSTS,
    resolve,
  } = options;
  const resolver = resolve ?? client.resolve;
  if (method !== "GET" && method !== "POST") throw new TypeError("acquisition HTTP method must be GET or POST");
  if (method === "POST" && body === undefined) throw new TypeError("POST acquisition requires a JSON request body");
  if (method === "GET" && body !== undefined) throw new TypeError("GET acquisition must not carry a request body");
  assertSafeFilename(filename);
  const dirs = taskWorkDirs(workdirRoot);
  await ensureAcquisitionDirs(dirs);
  const attemptId = `download_attempt_${randomUUID()}`;
  const startedAt = new Date().toISOString();
  const partPath = options.partPath ?? path.join(dirs.downloadTmp, `${attemptId}.part`);
  const callerOwnedPart = options.partPath !== undefined;
  const onPublished = options.onPublished;
  const notifyPublished = async (
    filePath: string,
    checksum: string,
    sizeBytes: number,
    mediaType: string,
  ): Promise<void> => {
    await onPublished?.({
      filename,
      filePath,
      sha256: checksum,
      sizeBytes,
      mediaType,
      sourceUrl: source.url,
      sourceDatabase: source.database,
    });
  };
  // POST bodies are not resumable: Range resumption is a GET-only concern.
  let resumeOffset = method === "POST" ? 0 : options.resumeFromBytes ?? 0;
  if (resumeOffset > 0) {
    const partStat = await stat(partPath).catch(() => null);
    if (partStat === null || !partStat.isFile() || partStat.size !== resumeOffset) {
      // Stale or mismatched resume point — start from scratch.
      resumeOffset = 0;
    }
  }
  let bytesReceived = resumeOffset;

  const fail = (
    code: AcquisitionError["code"],
    message: string,
  ): AcquisitionResult => ({
    schema_version: "1.0",
    attempt: {
      schema_version: "1.0",
      attempt_id: attemptId,
      source_id: source.source_id,
      url: source.url,
      status: "failed",
      bytes_received: bytesReceived,
      error_code: code,
      error_message: message,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    },
    asset: null,
  });

  const cleanupPart = async (): Promise<void> => {
    await unlink(partPath).catch(() => undefined);
  };

  try {
    const originHost = await validateHttpsSourceUrl(source.url, allowedHosts, { resolvePublic: true, resolve: resolver });
    if (maxBytes <= 0) {
      throw new AcquisitionError("validation_error", "max_bytes must be positive");
    }
    const requestVariant = method !== "GET" || body !== undefined
      ? { method, body: body ?? "" }
      : undefined;
    const requestHash = canonicalRequestHash(source.database, source.accession, source.url, requestVariant);
    const cached = await cache.readMetadata(requestHash);
    if (cached !== null) {
      const cachedSha = cached.sha256;
      const cachedBlob = cache.blobPath(cachedSha);
      const cachedStat = await stat(cachedBlob).catch(() => null);
      if (cachedStat !== null && cachedStat.isFile() && (await sha256File(cachedBlob)) === cachedSha) {
        const cachedSize = cachedStat.size;
        const cachedMediaType = (cached.media_type ?? "application/octet-stream").split(";", 1)[0].trim().toLowerCase();
        if (cachedSize > maxBytes) {
          throw new AcquisitionError("size_exceeded", "cached download exceeds maximum size");
        }
        if (expectedSize !== undefined && cachedSize !== expectedSize) {
          throw new AcquisitionError("download_incomplete", "cached download expected size mismatch");
        }
        if (expectedSha256 !== undefined && cachedSha !== expectedSha256.toLowerCase()) {
          throw new AcquisitionError("checksum_mismatch", "cached download expected SHA-256 mismatch");
        }
        if (expectedMediaTypes !== undefined && !expectedMediaTypes.has(cachedMediaType)) {
          throw new AcquisitionError("validation_error", `unexpected cached content type: ${cachedMediaType || "missing"}`);
        }
        const assetId = assetIdFromSha256(cachedSha);
        const destination = await publishTaskAsset(cachedBlob, dirs, assetId, filename, cachedSha);
        await notifyPublished(destination, cachedSha, cachedSize, cachedMediaType);
        await progress?.finalize?.(cachedSize, cachedSize);
        return {
          schema_version: "1.0",
          attempt: {
            schema_version: "1.0",
            attempt_id: attemptId,
            source_id: source.source_id,
            url: source.url,
            status: "succeeded",
            bytes_received: cachedSize,
            started_at: startedAt,
            finished_at: new Date().toISOString(),
            error_code: null,
            error_message: null,
          },
          asset: buildSourceAsset(assetId, destination, dirs, cachedSha, cachedSize, cachedMediaType, source, attemptId, dataLevel),
        };
      }
    }

    let sha = createHash("sha256");
    let md5 = createHash("md5");
    if (resumeOffset > 0) {
      // Re-seed the content hashes over the already-downloaded prefix so the
      // final digest covers the entire file, not just the resumed portion.
      const handle = await open(partPath, "r");
      try {
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let remaining = resumeOffset;
        while (remaining > 0) {
          const { bytesRead } = await handle.read(
            buffer,
            0,
            Math.min(buffer.length, remaining),
            null,
          );
          if (bytesRead === 0) break;
          sha.update(buffer.subarray(0, bytesRead));
          md5.update(buffer.subarray(0, bytesRead));
          remaining -= bytesRead;
        }
      } finally {
        await handle.close();
      }
    }
    const headers: Record<string, string> = { ...requestHeaders };
    headers["Accept"] = accept;
    if (method === "POST" && headers["Content-Type"] === undefined && headers["content-type"] === undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (resumeOffset > 0) {
      headers["Range"] = `bytes=${resumeOffset}-`;
    }
    let response: Awaited<ReturnType<PublicHttpClient["request"]>>;
    try {
      response = await client.request(source.url, {
        method,
        body,
        headers,
        signal,
        timeoutMs: options.timeoutMs,
        resolve: resolver,
        validateUrl: async (url) => {
          try {
            await validateHttpsSourceUrl(url, allowedHosts, { resolvePublic: true, resolve: resolver });
          } catch (error) {
            if (error instanceof UnsafeUrlError) {
              throw new AcquisitionError("validation_error", error.message);
            }
            throw error;
          }
        },
        validateRedirect: async (_from, to) => {
          let host: string;
          try {
            host = await validateHttpsSourceUrl(to, allowedHosts, { resolvePublic: true, resolve: resolver });
          } catch (error) {
            if (error instanceof UnsafeUrlError) {
              throw new AcquisitionError("validation_error", error.message);
            }
            throw error;
          }
          if (host !== originHost) {
            throw new AcquisitionError("validation_error", "download redirect changed host");
          }
        },
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        // 取消时保留调用方 part 文件：用户取消后可断点续传（默认 part 仍清理）。
        if (!callerOwnedPart) await cleanupPart();
        throw error;
      }
      if (error instanceof AcquisitionError) return fail(error.code, error.message);
      if (error instanceof UnsafeUrlError) return fail("validation_error", error.message);
      const code = errorCodeFrom(error);
      if (code === "cancelled") {
        if (!callerOwnedPart) await cleanupPart();
        throw error;
      }
      return fail(code, `download failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status < 200 || response.status >= 300) {
      await response.discard();
      return fail(httpFailureCode(response.status), `download returned HTTP ${response.status}`);
    }
    let append = false;
    if (resumeOffset > 0 && response.status === 206) {
      append = true;
    } else if (resumeOffset > 0) {
      // Server ignored the Range header (HTTP 200 full body): restart from
      // scratch into the same caller-owned part file.
      sha = createHash("sha256");
      md5 = createHash("md5");
      bytesReceived = 0;
      resumeOffset = 0;
    }
    const declaredHeader = response.headers["content-length"] ?? response.headers["Content-Length"];
    const declaredLength = declaredHeader === undefined ? null : Number.parseInt(declaredHeader, 10);
    if (declaredLength !== null && declaredLength + resumeOffset > maxBytes) {
      await response.discard();
      await cleanupPart();
      return fail("size_exceeded", "declared content length exceeds maximum");
    }

    const mediaType = mediaTypeFromHeader(response.headers);
    const target = createWriteStream(partPath, { flags: append ? "a" : "w" });
    try {
      try {
        const declaredTotal = declaredLength === null
          ? null
          : declaredLength + resumeOffset;
        for await (const chunk of response.body) {
          if (signal?.aborted === true) {
            throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
          }
          bytesReceived += chunk.length;
          if (bytesReceived > maxBytes) {
            throw new AcquisitionError("size_exceeded", "download exceeded maximum size");
          }
          sha.update(chunk);
          md5.update(chunk);
          await new Promise<void>((resolveWrite, rejectWrite) => {
            target.write(chunk, (error) => (error ? rejectWrite(error) : resolveWrite()));
          });
          await progress?.(bytesReceived, declaredTotal);
        }
      } catch (error) {
        await new Promise<void>((resolveClose) => target.close(() => resolveClose()));
        if ((error instanceof Error && error.name === "AbortError") || signal?.aborted === true) {
          // 取消时保留调用方 part 文件：用户取消后可断点续传（默认 part 仍清理）。
          if (!callerOwnedPart) await cleanupPart();
          throw error;
        }
        // Caller-owned part files survive retryable stream failures so the
        // caller can resume from the partial bytes (downloaders retry).
        if (!callerOwnedPart) await cleanupPart();
        if (error instanceof AcquisitionError) return fail(error.code, error.message);
        const code = errorCodeFrom(error);
        if (code === "cancelled") throw error;
        return fail(code, `download failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      await new Promise<void>((resolveClose, rejectClose) => {
        target.end(() => resolveClose());
        target.on("error", rejectClose);
      });
      // fsync the part file before verification.
      const handle = await open(partPath, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } finally {
      target.destroy();
    }

    const streamedBytes = bytesReceived - resumeOffset;
    if (streamedBytes === 0 && resumeOffset === 0) {
      await cleanupPart();
      return fail("download_incomplete", "download was empty");
    }
    if (declaredLength !== null && streamedBytes !== declaredLength) {
      await cleanupPart();
      return fail("download_incomplete", "content length mismatch");
    }
    if (expectedMediaTypes !== undefined && !expectedMediaTypes.has(mediaType)) {
      await cleanupPart();
      return fail("media_mismatch", `unexpected content type: ${mediaType || "missing"}`);
    }
    if (expectedSize !== undefined && bytesReceived !== expectedSize) {
      await cleanupPart();
      return fail("download_incomplete", "expected size mismatch");
    }
    const checksum = sha.digest("hex");
    if (expectedSha256 !== undefined && checksum !== expectedSha256.toLowerCase()) {
      await cleanupPart();
      return fail("checksum_mismatch", "expected SHA-256 mismatch");
    }
    // GDC files API exposes md5sum but not SHA-256: verify official MD5 when provided.
    if (expectedMd5 !== undefined && md5.digest("hex") !== expectedMd5.toLowerCase()) {
      await cleanupPart();
      return fail("checksum_mismatch", "expected MD5 mismatch");
    }

    const blobPath = await publishCache(partPath, cache, checksum);
    const assetId = assetIdFromSha256(checksum);
    const destination = await publishTaskAsset(blobPath, dirs, assetId, filename, checksum);
    await cache.writeMetadata(requestHash, {
      sha256: checksum,
      size_bytes: String(bytesReceived),
      media_type: mediaType,
    });
    await cleanupPart();
    await notifyPublished(destination, checksum, bytesReceived, mediaType);
    await progress?.finalize?.(bytesReceived, bytesReceived);
    return {
      schema_version: "1.0",
      attempt: {
        schema_version: "1.0",
        attempt_id: attemptId,
        source_id: source.source_id,
        url: source.url,
        status: "succeeded",
        bytes_received: bytesReceived,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        error_code: null,
        error_message: null,
      },
      asset: buildSourceAsset(assetId, destination, dirs, checksum, bytesReceived, mediaType, source, attemptId, dataLevel),
    };
  } catch (error) {
    if ((error instanceof Error && error.name === "AbortError") || signal?.aborted === true) {
      // 取消时保留调用方 part 文件：用户取消后可断点续传（默认 part 仍清理）。
      if (!callerOwnedPart) await cleanupPart();
      throw error;
    }
    // Caller-owned part files survive non-abort failures for the caller to
    // resume or clean up; the default part is always removed.
    if (!callerOwnedPart) await cleanupPart();
    if (error instanceof AcquisitionError) return fail(error.code, error.message);
    if (error instanceof UnsafeUrlError) return fail("validation_error", error.message);
    return fail("internal_error", `download failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Pagination variant of ``acquireSource`` for provider-declared JSON list
 * APIs. Fetches successive pages by stepping the ``offset`` query parameter,
 * merges the arrays at ``pagination.recordsPath``, and publishes the merged
 * document through the same cache/task-asset path as the single-request
 * flow. Caps are loud: exceeding ``maxRecords`` or ``maxPages`` fails the
 * acquisition instead of truncating.
 */
async function acquireJsonPaginatedSource(options: AcquireSourceOptions): Promise<AcquisitionResult> {
  const {
    source,
    filename,
    workdirRoot,
    cache,
    client,
    dataLevel,
    maxBytes,
    expectedMediaTypes,
    requestHeaders,
    progress,
    signal,
    allowedHosts = CURATED_SOURCE_HOSTS,
    resolve,
    pagination,
  } = options;
  if (options.method === "POST" || options.body !== undefined || (options.resumeFromBytes ?? 0) > 0) {
    throw new TypeError("paginated acquisition supports plain GET without resume only");
  }
  if (options.expectedSize !== undefined || options.expectedSha256 !== undefined || options.expectedMd5 !== undefined) {
    throw new TypeError("paginated acquisition cannot verify expected checksums of a merged document");
  }
  if (pagination === undefined) throw new TypeError("pagination spec is required");
  if (!Number.isSafeInteger(pagination.pageSize) || pagination.pageSize < 1) {
    throw new TypeError("pagination pageSize must be a positive integer");
  }
  if (!Number.isSafeInteger(pagination.maxRecords) || pagination.maxRecords < 1) {
    throw new TypeError("pagination maxRecords must be a positive integer");
  }
  if (!Number.isSafeInteger(pagination.maxPages) || pagination.maxPages < 1) {
    throw new TypeError("pagination maxPages must be a positive integer");
  }
  if (!/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/.test(pagination.recordsPath)) {
    throw new TypeError("pagination recordsPath must be a dot path of plain keys");
  }

  const dirs = taskWorkDirs(workdirRoot);
  await ensureAcquisitionDirs(dirs);
  const attemptId = `download_attempt_${randomUUID()}`;
  const startedAt = new Date().toISOString();
  const partPath = options.partPath ?? path.join(dirs.downloadTmp, `${attemptId}.part`);
  const callerOwnedPart = options.partPath !== undefined;
  const onPublished = options.onPublished;
  const notifyPublished = async (
    filePath: string,
    checksum: string,
    sizeBytes: number,
    mediaType: string,
  ): Promise<void> => {
    await onPublished?.({
      filename,
      filePath,
      sha256: checksum,
      sizeBytes,
      mediaType,
      sourceUrl: source.url,
      sourceDatabase: source.database,
    });
  };
  const fail = (code: AcquisitionError["code"], message: string): AcquisitionResult => ({
    schema_version: "1.0",
    attempt: {
      schema_version: "1.0",
      attempt_id: attemptId,
      source_id: source.source_id,
      url: source.url,
      status: "failed",
      bytes_received: 0,
      error_code: code,
      error_message: message,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    },
    asset: null,
  });
  const cleanupPart = async (): Promise<void> => {
    await unlink(partPath).catch(() => undefined);
  };

  try {
    const resolver = resolve ?? client.resolve;
    await validateHttpsSourceUrl(source.url, allowedHosts, { resolvePublic: true, resolve: resolver });
    const base = new URL(source.url);
    base.searchParams.set("limit", String(pagination.pageSize));
    base.searchParams.set("offset", "0");
    const recordsPathKeys = pagination.recordsPath.split(".");
    const requestHash = canonicalRequestHash(source.database, source.accession, source.url, undefined);

    const cached = await cache.readMetadata(requestHash);
    if (cached !== null) {
      const cachedSha = cached.sha256;
      const cachedBlob = cache.blobPath(cachedSha);
      const cachedStat = await stat(cachedBlob).catch(() => null);
      if (cachedStat !== null && cachedStat.isFile() && (await sha256File(cachedBlob)) === cachedSha) {
        const cachedSize = cachedStat.size;
        const cachedMediaType = (cached.media_type ?? "application/octet-stream").split(";", 1)[0].trim().toLowerCase();
        if (cachedSize > maxBytes) {
          throw new AcquisitionError("size_exceeded", "cached download exceeds maximum size");
        }
        if (expectedMediaTypes !== undefined && !expectedMediaTypes.has(cachedMediaType)) {
          throw new AcquisitionError("validation_error", `unexpected cached content type: ${cachedMediaType || "missing"}`);
        }
        const assetId = assetIdFromSha256(cachedSha);
        const destination = await publishTaskAsset(cachedBlob, dirs, assetId, filename, cachedSha);
        await notifyPublished(destination, cachedSha, cachedSize, cachedMediaType);
        await progress?.finalize?.(cachedSize, cachedSize);
        return {
          schema_version: "1.0",
          attempt: {
            schema_version: "1.0",
            attempt_id: attemptId,
            source_id: source.source_id,
            url: source.url,
            status: "succeeded",
            bytes_received: cachedSize,
            started_at: startedAt,
            finished_at: new Date().toISOString(),
            error_code: null,
            error_message: null,
          },
          asset: buildSourceAsset(assetId, destination, dirs, cachedSha, cachedSize, cachedMediaType, source, attemptId, dataLevel),
        };
      }
    }

    const readPage = async (pageUrl: string): Promise<{ records: Record<string, unknown>[]; document: Record<string, unknown> }> => {
      const response = await client.request(pageUrl, {
        method: "GET",
        headers: { Accept: "application/json", ...requestHeaders },
        signal,
        timeoutMs: options.timeoutMs,
        resolve: resolver,
        validateUrl: async (candidate) => {
          try {
            await validateHttpsSourceUrl(candidate, allowedHosts, { resolvePublic: true, resolve: resolver });
          } catch (error) {
            if (error instanceof UnsafeUrlError) throw new AcquisitionError("validation_error", error.message);
            throw error;
          }
        },
      });
      if (response.status < 200 || response.status >= 300) {
        await response.discard();
        throw new AcquisitionError(httpFailureCode(response.status), `download returned HTTP ${response.status}`);
      }
      const mediaType = mediaTypeFromHeader(response.headers);
      if (expectedMediaTypes !== undefined && !expectedMediaTypes.has(mediaType)) {
        await response.discard();
        throw new AcquisitionError("media_mismatch", `unexpected content type: ${mediaType || "missing"}`);
      }
      const chunks: Buffer[] = [];
      let pageBytes = 0;
      for await (const chunk of response.body) {
        if (signal?.aborted === true) {
          throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
        }
        pageBytes += chunk.length;
        if (pageBytes > maxBytes) {
          throw new AcquisitionError("size_exceeded", "paginated page exceeded maximum size");
        }
        chunks.push(chunk);
      }
      let document: unknown;
      try {
        document = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new AcquisitionError("internal_error", "paginated response was not valid JSON");
      }
      if (document === null || typeof document !== "object" || Array.isArray(document)) {
        throw new AcquisitionError("internal_error", "paginated response must be a JSON object");
      }
      let cursor: unknown = document as Record<string, unknown>;
      for (const key of recordsPathKeys) {
        if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) {
          throw new AcquisitionError("internal_error", `paginated response missing records path "${pagination.recordsPath}"`);
        }
        cursor = (cursor as Record<string, unknown>)[key];
      }
      if (!Array.isArray(cursor) || cursor.some((entry) => entry === null || typeof entry !== "object" || Array.isArray(entry))) {
        throw new AcquisitionError("internal_error", `paginated response field "${pagination.recordsPath}" must be an array of objects`);
      }
      return { records: cursor as Record<string, unknown>[], document: document as Record<string, unknown> };
    };

    const records: Record<string, unknown>[] = [];
    let firstDocument: Record<string, unknown> | null = null;
    let lastDocument: Record<string, unknown> | null = null;
    let pages = 0;
    let shortPage = false;
    while (pages < pagination.maxPages && !shortPage) {
      const pageUrl = new URL(base);
      pageUrl.searchParams.set("offset", String(pages * pagination.pageSize));
      const page = await readPage(pageUrl.toString());
      pages += 1;
      if (firstDocument === null) firstDocument = page.document;
      lastDocument = page.document;
      records.push(...page.records);
      if (records.length > pagination.maxRecords) {
        await cleanupPart();
        return fail(
          "validation_error",
          `pagination_record_cap_exceeded: paginated acquisition exceeded the configured record cap of ${pagination.maxRecords}`,
        );
      }
      shortPage = page.records.length < pagination.pageSize;
    }
    if (!shortPage) {
      await cleanupPart();
      return fail(
        "validation_error",
        `pagination_record_cap_exceeded: paginated acquisition exhausted ${pagination.maxPages} full pages without reaching the end; raise the configured record cap or narrow the query`,
      );
    }

    const merged: Record<string, unknown> = { ...firstDocument };
    let cursor: Record<string, unknown> = merged;
    for (const key of recordsPathKeys.slice(0, -1)) {
      const child = cursor[key];
      cursor = child !== null && typeof child === "object" && !Array.isArray(child)
        ? child as Record<string, unknown>
        : (cursor[key] = {});
    }
    cursor[recordsPathKeys[recordsPathKeys.length - 1]!] = records;
    const lastMeta = lastDocument !== null ? lastDocument["page_meta"] : null;
    if (lastMeta !== null && typeof lastMeta === "object" && !Array.isArray(lastMeta)) {
      merged["page_meta"] = lastMeta;
    }
    const mergedBytes = Buffer.from(JSON.stringify(merged), "utf8");
    if (mergedBytes.length > maxBytes) {
      await cleanupPart();
      return fail("size_exceeded", "merged paginated document exceeded maximum size");
    }
    await writeFile(partPath, mergedBytes);
    const checksum = createHash("sha256").update(mergedBytes).digest("hex");

    const blobPath = await publishCache(partPath, cache, checksum);
    const assetId = assetIdFromSha256(checksum);
    const destination = await publishTaskAsset(blobPath, dirs, assetId, filename, checksum);
    await cache.writeMetadata(requestHash, {
      sha256: checksum,
      size_bytes: String(mergedBytes.length),
      media_type: "application/json",
    });
    await cleanupPart();
    await notifyPublished(destination, checksum, mergedBytes.length, "application/json");
    await progress?.finalize?.(mergedBytes.length, mergedBytes.length);
    return {
      schema_version: "1.0",
      attempt: {
        schema_version: "1.0",
        attempt_id: attemptId,
        source_id: source.source_id,
        url: source.url,
        status: "succeeded",
        bytes_received: mergedBytes.length,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        error_code: null,
        error_message: null,
      },
      asset: buildSourceAsset(assetId, destination, dirs, checksum, mergedBytes.length, "application/json", source, attemptId, dataLevel),
    };
  } catch (error) {
    if ((error instanceof Error && error.name === "AbortError") || signal?.aborted === true) {
      if (!callerOwnedPart) await cleanupPart();
      throw error;
    }
    if (!callerOwnedPart) await cleanupPart();
    if (error instanceof AcquisitionError) return fail(error.code, error.message);
    if (error instanceof UnsafeUrlError) return fail("validation_error", error.message);
    return fail("internal_error", `download failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function buildSourceAsset(
  assetId: string,
  destination: string,
  dirs: TaskWorkDirs,
  sha256: string,
  sizeBytes: number,
  mediaType: string,
  source: SourceRecord,
  attemptId: string,
  dataLevel: DataLevel,
): SourceAsset {
  const relative = path.relative(dirs.root, destination).split(path.sep).join("/");
  return {
    schema_version: "1.0",
    asset_id: assetId,
    kind: "source",
    relative_path: relative,
    sha256,
    size_bytes: sizeBytes,
    media_type: mediaType,
    generated_by_step_id: null,
    source_id: source.source_id,
    successful_attempt_id: attemptId,
    derived_from_asset_id: null,
    data_level: dataLevel,
  };
}

export type { DownloadAttempt, SourceAsset, AcquisitionResult };
