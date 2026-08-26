/**
 * Content-addressed cache path definitions (Python
 * ``app/tools/content_cache.py`` parity).
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SHA256_RE = /^[0-9a-f]{64}$/;

function canonicalSha256(value: string): string {
  const checksum = value.trim().toLowerCase();
  if (!SHA256_RE.test(checksum)) {
    throw new TypeError("SHA-256 must contain exactly 64 hexadecimal characters");
  }
  return checksum;
}

/**
 * Non-default HTTP request identity for the content cache. GET requests
 * without a body keep the historical (database, accession, url) key; POST
 * acquisitions include method + body so distinct requests to the same URL
 * never share a cache entry.
 */
export interface RequestIdentityVariant {
  method: string;
  body?: string;
}

/** Deterministic SHA-256 of canonical request identity (database, accession, url). */
export function canonicalRequestHash(
  database: string,
  accession: string,
  url: string,
  variant?: RequestIdentityVariant,
): string {
  // Key order matches Python json.dumps(..., sort_keys=True) for the base
  // (GET) identity: accession, database, url. The POST method/body extension
  // is TypeScript-only (Python had no POST acquisition path) and is appended
  // in insertion order after the base keys.
  const canonical = JSON.stringify({
    accession: accession.trim().toLowerCase(),
    database: database.trim().toLowerCase(),
    url: url.trim(),
    ...(variant === undefined ? {} : {
      method: variant.method,
      body: variant.body ?? "",
    }),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export interface ContentCacheRoot {
  root: string;
}

export interface CachedMetadata {
  sha256: string;
  size_bytes?: string;
  media_type?: string;
  [key: string]: string | undefined;
}

export class ContentCache {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  blobPath(sha256: string): string {
    const checksum = canonicalSha256(sha256);
    const parent = path.join(this.root, "blobs", "sha256", checksum.slice(0, 2), checksum.slice(2, 4));
    return path.join(parent, checksum);
  }

  metadataPath(requestHash: string): string {
    const hash = canonicalSha256(requestHash);
    return path.join(this.root, "metadata", `${hash}.json`);
  }

  async readMetadata(requestHash: string): Promise<CachedMetadata | null> {
    const file = this.metadataPath(requestHash);
    let data: unknown;
    try {
      data = JSON.parse(await readFile(file, "utf8"));
    } catch {
      return null;
    }
    if (typeof data !== "object" || data === null || !("sha256" in data) || typeof (data as { sha256: unknown }).sha256 !== "string") {
      return null;
    }
    return data as CachedMetadata;
  }

  async writeMetadata(requestHash: string, metadata: Record<string, string>): Promise<void> {
    const file = this.metadataPath(requestHash);
    await mkdir(path.dirname(file), { recursive: true });
    const ordered = Object.fromEntries(Object.entries(metadata).sort(([left], [right]) => left.localeCompare(right)));
    await writeFile(file, `${JSON.stringify(ordered)}\n`, "utf8");
  }
}
