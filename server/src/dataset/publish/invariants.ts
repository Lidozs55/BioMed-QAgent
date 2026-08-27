/**
 * Architecture-level release invariants (ADR-012; Design §16 Phase 6; Python
 * ``backend/app/datasets/build/invariants.py``).
 *
 * Three invariants are fixed at the architecture layer and enforced before any
 * build output may be promoted: provenance closure, profile passed, and atomic
 * promotion (plus the B4 artifact-inventory check). Specific rules (CSV
 * encoding, column counts, field completeness, probe mapping coverage, ...)
 * belong to the versioned Validation Profile, not to this module.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { throwIfAborted } from "../cooperative.js";
import { sha256FileStream } from "../adapters/hashing.js";
import type { ManifestArtifactEntry, ValidationResult, VersionedDatasetManifest } from "../contracts/index.js";

/** Directory under the build workspace where immutable versions are promoted. */
export const PUBLISH_DIR = "publish";

/** Outcome of the release gate (B4 extends it with artifact inventory). */
export interface ReleaseInvariantsResult {
  provenance_closed: boolean;
  profile_passed: boolean;
  atomic_promotion_ready: boolean;
  artifacts_intact: boolean;
  violations: string[];
  passed: boolean;
}

/**
 * Check the release invariants for *manifest* + *validation*.  ``outputDir``
 * is the build workspace; the provenance document is read from disk (its path
 * is taken from the manifest artifact) and the publish directory atomic-write
 * mechanism is probed without persisting anything meaningful.
 * ``expectedSourceAssetIds`` is the build's authoritative source-asset set
 * (B4): when provided, the provenance document's source asset ids must equal
 * it exactly.
 */
export async function checkReleaseInvariants(options: {
  manifest: VersionedDatasetManifest;
  validation: ValidationResult;
  outputDir: string;
  expectedSourceAssetIds?: ReadonlySet<string> | null;
  signal?: AbortSignal | null;
}): Promise<ReleaseInvariantsResult> {
  const signal = options.signal ?? null;
  throwIfAborted(signal);
  const violations: string[] = [];
  const provenanceClosed = await checkProvenanceClosure(
    options.manifest,
    options.outputDir,
    violations,
    options.expectedSourceAssetIds ?? null,
    signal,
  );
  const profilePassed = checkProfilePassed(options.validation, violations);
  const artifactsIntact = await checkManifestArtifacts(options.manifest, options.outputDir, violations, signal);
  const atomicReady = checkAtomicPromotion(options.manifest, options.outputDir, violations);
  return {
    provenance_closed: provenanceClosed,
    profile_passed: profilePassed,
    atomic_promotion_ready: atomicReady,
    artifacts_intact: artifactsIntact,
    violations,
    passed: violations.length === 0,
  };
}

async function checkProvenanceClosure(
  manifest: VersionedDatasetManifest,
  outputDir: string,
  violations: string[],
  expectedSourceAssetIds: ReadonlySet<string> | null,
  signal?: AbortSignal | null,
): Promise<boolean> {
  throwIfAborted(signal);
  const provenanceEntries = manifest.artifacts.filter(
    (entry) => entry.role === "provenance",
  );
  if (provenanceEntries.length === 0) {
    violations.push("provenance closure: manifest declares no provenance artifact");
    return false;
  }
  const provenancePath = join(outputDir, provenanceEntries[0].relative_path);
  if (!existsSync(provenancePath)) {
    violations.push(
      `provenance closure: provenance document missing on disk ` +
        `(${provenanceEntries[0].relative_path})`,
    );
    return false;
  }
  let document: Record<string, unknown>;
  try {
    document = JSON.parse(await readFile(provenancePath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    violations.push(
      `provenance closure: provenance document unreadable: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
  const sources = Array.isArray(document["sources"]) ? (document["sources"] as unknown[]) : [];
  const declaredAssetIds = new Set<string>();
  for (const source of sources) {
    if (typeof source === "object" && source !== null) {
      const assetId = (source as Record<string, unknown>)["asset_id"];
      if (typeof assetId === "string" && assetId.length > 0) {
        declaredAssetIds.add(assetId);
      }
    }
  }
  if (expectedSourceAssetIds !== null) {
    if (!setsEqual(declaredAssetIds, expectedSourceAssetIds)) {
      const missing = [...expectedSourceAssetIds].filter((id) => !declaredAssetIds.has(id)).sort();
      const extra = [...declaredAssetIds].filter((id) => !expectedSourceAssetIds.has(id)).sort();
      violations.push(
        "provenance closure: provenance document source asset ids do " +
          "not match the build's source asset set " +
          `(missing: ${pyReprList(missing)}; extra: ${pyReprList(extra)})`,
      );
      return false;
    }
    return true;
  }
  const sourceCountRaw = (manifest.provenance_summary["source_count"] ?? 0);
  const sourceCount = typeof sourceCountRaw === "number" ? sourceCountRaw : Number(sourceCountRaw);
  if (declaredAssetIds.size < sourceCount) {
    violations.push(
      "provenance closure: provenance document lists " +
        `${declaredAssetIds.size} source asset(s) but the manifest ` +
        `declares ${sourceCount}`,
    );
    return false;
  }
  return true;
}

/** B4: every manifest artifact must exist with the exact declared size/SHA-256. */
async function checkManifestArtifacts(
  manifest: VersionedDatasetManifest,
  outputDir: string,
  violations: string[],
  signal?: AbortSignal | null,
): Promise<boolean> {
  let ok = true;
  for (const entry of manifest.artifacts) {
    throwIfAborted(signal);
    const path = join(outputDir, entry.relative_path);
    if (!existsSync(path) || !statSync(path).isFile()) {
      violations.push(
        `manifest artifacts: ${entry.relative_path} is missing or not ` +
          "a regular file",
      );
      ok = false;
      continue;
    }
    let actualSize: number;
    let actualSha256: string;
    try {
      actualSize = statSync(path).size;
      actualSha256 = await sha256FileStream(path, signal);
    } catch (error) {
      violations.push(
        `manifest artifacts: ${entry.relative_path} unreadable: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      ok = false;
      continue;
    }
    if (actualSize !== entry.size_bytes) {
      violations.push(
        `manifest artifacts: ${entry.relative_path} size ${actualSize} ` +
          `!= declared ${entry.size_bytes}`,
      );
      ok = false;
    }
    if (actualSha256 !== entry.sha256) {
      violations.push(
        `manifest artifacts: ${entry.relative_path} sha256 mismatch`,
      );
      ok = false;
    }
  }
  return ok;
}

function checkProfilePassed(validation: ValidationResult, violations: string[]): boolean {
  if (validation.status !== "passed") {
    violations.push(
      `profile passed: validation status is ${pyRepr(validation.status)}, ` +
        "not 'passed'; failed/unvalidated builds are never promoted",
    );
    return false;
  }
  return true;
}

function checkAtomicPromotion(
  manifest: VersionedDatasetManifest,
  outputDir: string,
  violations: string[],
): boolean {
  const publishDir = join(outputDir, PUBLISH_DIR);
  mkdirSync(publishDir, { recursive: true });

  const probe = join(publishDir, ".invariant_probe");
  const staged = join(publishDir, ".invariant_probe.tmp");
  try {
    writeFileSync(staged, "probe", "utf8");
    renameSync(staged, probe);
    unlinkSync(probe);
  } catch (error) {
    violations.push(
      `atomic promotion: publish directory is not atomically writable: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }

  const versionDir = join(
    publishDir,
    `${manifest.requirement_id}_${manifest.sha256.slice(0, 16)}`,
  );
  if (existsSync(versionDir)) {
    violations.push(
      "atomic promotion: version directory already exists for this " +
        `digest (${manifest.requirement_id}_${manifest.sha256.slice(0, 16)}); ` +
        "refusing to republish an immutable version",
    );
    return false;
  }
  return true;
}

/**
 * Return the publication_id of the newest immutable version.  Version
 * directories are content-addressed (``<requirement_id>_<digest16>``); the newest
 * version is the one with the latest ``published_at`` — never a lexicographic
 * ordering of publication_ids.  The lookup is BUILD-SCOPED when ``requirementId``
 * is given (Python ``find_latest_publication``).
 */
export function findLatestPublication(
  publishDir: string,
  requirementId?: string | null,
): string | null {
  let newest: [publishedAt: string, publicationId: string] | null = null;
  for (const child of listDirectories(publishDir)) {
    if (child.startsWith(".")) continue;
    if (requirementId !== null && requirementId !== undefined && !child.startsWith(`${requirementId}_`)) {
      continue;
    }
    const publicationPath = join(publishDir, child, "publication.json");
    if (!existsSync(publicationPath)) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(readFileSync(publicationPath, "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    const publicationId = record["publication_id"];
    if (typeof publicationId !== "string" || publicationId.length === 0) continue;
    const publishedAt = String(record["published_at"] ?? "");
    if (newest === null || publishedAt > newest[0]) {
      newest = [publishedAt, publicationId];
    }
  }
  return newest === null ? null : newest[1];
}

function listDirectories(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function pyRepr(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function pyReprList(values: readonly string[]): string {
  return `[${values.map((value) => pyRepr(value)).join(", ")}]`;
}

export type { ManifestArtifactEntry };