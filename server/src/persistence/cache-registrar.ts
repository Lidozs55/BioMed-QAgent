/**
 * CacheRegistrar — best-effort registration of downloaded raw files into the
 * global dataset cache (``data/cache``, Python CacheStore via the bridge).
 *
 * Every verified download (``acquireSource`` and ``downloadFromPage``) is
 * registered here at download time so later runs can reuse the raw bytes via
 * ``search_local_cache`` / ``get_cache_dataset`` instead of re-downloading.
 * Registration is fire-and-forget: it never throws into the download path —
 * failures are logged and swallowed so acquisition keeps working even when the
 * bridge is down.
 *
 * Records are content-addressed: the cache dataset id is derived from the file
 * SHA-256, so re-downloading identical bytes overwrites the same record
 * (idempotent). The raw file itself is stored as an immutable asset file
 * (``records/<ns>/<id>/assets/<sanitized-name>``) referenced by the manifest.
 */

import { BRIDGE_OP, type DatabaseClient } from "./db-client.js";

/** Payload produced by a verified download (passed to ``onPublished``). */
export interface PublishedDownload {
  filename: string;
  /** Absolute path of the verified, immutable file. */
  filePath: string;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
  sourceUrl: string;
  /** Source database key (e.g. ``geo`` / ``gdc`` / ``pubmed``); namespace base. */
  sourceDatabase?: string;
}

/** Cache namespace derived from a source database key. */
export function sanitizeCacheNamespace(database: string): string {
  const cleaned = database.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.length === 0 ? "src" : cleaned;
}

function resolveTaskId(taskId: string | (() => string) | undefined): string {
  return typeof taskId === "function" ? taskId() : (taskId ?? "");
}

/**
 * Safe staged asset name: the raw filename may contain characters the cache
 * store rejects (spaces, unicode, separators), so the file is staged under a
 * sanitized content-addressed name while the original name is kept in
 * ``extra.original_filename``.
 */
function safeAssetName(filename: string, sha256: string): string {
  const stem = filename
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return `blob_${sha256.slice(0, 8)}_${stem.length === 0 ? "blob" : stem}`;
}

export class CacheRegistrar {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly db: DatabaseClient) {}

  /**
   * Fire-and-forget registration. Never throws; failures are logged.
   * Commits are serialized through an internal queue so concurrent downloads
   * never interleave bridge writes.
   */
  register(
    namespace: string,
    published: PublishedDownload,
    taskId?: string | (() => string),
  ): void {
    this.queue = this.queue
      .then(() => this.tryRegister(namespace, published, resolveTaskId(taskId)))
      .catch(() => undefined);
  }

  /** Register and await completion (for tests / shutdown); never rejects. */
  async registerNow(
    namespace: string,
    published: PublishedDownload,
    taskId?: string | (() => string),
  ): Promise<void> {
    this.queue = this.queue.then(() =>
      this.tryRegister(namespace, published, resolveTaskId(taskId)),
    );
    try {
      await this.queue;
    } catch {
      // best-effort by contract
    }
  }

  private async tryRegister(
    namespace: string,
    published: PublishedDownload,
    taskId: string,
  ): Promise<void> {
    const safeNamespace = sanitizeCacheNamespace(namespace);
    const datasetId = `blob_${published.sha256.slice(0, 16)}`;
    const assetName = safeAssetName(published.filename, published.sha256);
    const downloadedAt = new Date().toISOString();
    const topic = `${safeNamespace} ${published.filename}`;
    const description = `raw downloaded file ${published.filename}`;
    try {
      await this.db.call(BRIDGE_OP.CACHE_COMMIT, {
        dataset_id: datasetId,
        source_namespace: safeNamespace,
        topic,
        description,
        csv_rows: [
          {
            asset_sha256: published.sha256,
            size_bytes: String(published.sizeBytes),
            media_type: published.mediaType,
            source_url: published.sourceUrl,
            downloaded_at: downloadedAt,
          },
        ],
        columns: ["asset_sha256", "size_bytes", "media_type", "source_url", "downloaded_at"],
        created_by_task_id: taskId,
        source_files: [published.filename],
        keywords: [safeNamespace, published.filename],
        extra: {
          kind: "raw_download",
          source_url: published.sourceUrl,
          original_filename: published.filename,
          ...(published.sourceDatabase === undefined
            ? {}
            : { source_database: published.sourceDatabase }),
        },
        asset_files: {
          [assetName]: {
            path: published.filePath,
            media_type: published.mediaType,
          },
        },
      });
    } catch (error) {
      console.warn(
        `cache.register_failed namespace=${safeNamespace} dataset=${datasetId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}