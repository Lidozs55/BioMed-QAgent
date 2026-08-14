/**
 * Atomic publication promotion (Python ``expression_runner.py:_publish`` plus
 * the release-invariants gate of ``invariants.py``).
 *
 * A publication is a content-addressed immutable version directory
 * (``publish/<build_id>_<digest16>``) written via a staged temp directory +
 * rename so a crash never leaves a half-written publication and a prior
 * version is never mutated.  The release gate runs immediately before
 * promotion; the pending-input gate is rechecked at the rename boundary.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { copyFile, rename, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { DatasetManifest, DatasetPublication, ValidationResult } from "../contracts/index.js";
import { throwIfAborted } from "../cooperative.js";
import { BuildError } from "../adapters/errors.js";
import { pythonJsonDumps } from "../runtime/digests.js";
import { checkReleaseInvariants, findLatestPublication, PUBLISH_DIR } from "./invariants.js";
import { MANIFEST_FILE } from "./manifest.js";

/** H2 marker prefix: a main-run data-correction pause became pending. */
export const PUBLICATION_REFUSED_PREFIX = "publication refused: main input pending";

/** The build reached publication while a correction pause is pending. */
export class PublicationRefusedError extends BuildError {}

/** The atomic promotion failed (I/O error during staging or rename). */
export class AtomicPromotionError extends BuildError {}

export interface PublishOptions {
  outputDir: string;
  manifest: DatasetManifest;
  validation: ValidationResult;
  expectedSourceAssetIds?: ReadonlySet<string> | null;
  /** H2: rechecked immediately before the immutable rename. */
  pendingCheck?: (() => boolean) | null;
  /** Injectable for deterministic tests; Python ``datetime.now(UTC)`` default. */
  publishedAt?: string | null;
  /** Cooperative abort signal from the executor (M2 I-03/I-04). */
  signal?: AbortSignal | null;
}

export interface PublishResult {
  publication: DatasetPublication;
  publicationId: string;
  versionDir: string;
  supersedesPublicationId: string | null;
  invariants: {
    provenance_closed: boolean;
    profile_passed: boolean;
    atomic_promotion_ready: boolean;
    artifacts_intact: boolean;
  };
}

/** Promote *manifest* + *validation* to an immutable publication (atomic). */
export async function promotePublication(options: PublishOptions): Promise<PublishResult> {
  const signal = options.signal ?? null;
  throwIfAborted(signal);
  const manifest = options.manifest;
  const validation = options.validation;
  const invariants = await checkReleaseInvariants({
    manifest,
    validation,
    outputDir: options.outputDir,
    expectedSourceAssetIds: options.expectedSourceAssetIds ?? null,
    signal,
  });
  if (!invariants.passed) {
    throw new BuildError(
      `release invariants failed: ${invariants.violations.join("; ")}`,
    );
  }

  const publishDir = join(options.outputDir, PUBLISH_DIR);
  mkdirSync(publishDir, { recursive: true });
  const versionName = `${manifest.build_id}_${manifest.sha256.slice(0, 16)}`;
  const versionDir = join(publishDir, versionName);
  if (existsSync(versionDir)) {
    throw new BuildError(
      `atomic promotion: version directory already exists: ${versionName}`,
    );
  }
  const superseded = findLatestPublication(publishDir, manifest.build_id);
  const publicationId = `pub_${manifest.build_id}_${manifest.sha256.slice(0, 16)}`;
  const publication: DatasetPublication = {
    schema_version: "1.0",
    publication_id: publicationId,
    manifest_ref: manifest.manifest_id,
    validation_result_ref:
      validation.report_path === null || validation.report_path === undefined
        ? "validation_report.json"
        : String(validation.report_path),
    published_at: options.publishedAt ?? pythonNowIso(),
    supersedes_publication_id: superseded,
  };

  const stagedDir = join(publishDir, `.${versionName}.tmp`);
  if (existsSync(stagedDir)) rmSync(stagedDir, { recursive: true, force: true });
  mkdirSync(stagedDir, { recursive: true });
  try {
    // B3: preserve each artifact's relative_path under the version directory
    // so the manifest's references resolve inside the immutable publication.
    // A vanished file raises (never a silent skip) and aborts the promotion.
    for (const artifact of manifest.artifacts) {
      throwIfAborted(signal);
      const src = join(options.outputDir, artifact.relative_path);
      const dest = join(stagedDir, artifact.relative_path);
      mkdirSync(dirnameOf(dest), { recursive: true });
      await copyFile(src, dest);
      throwIfAborted(signal);
    }
    const manifestSrc = join(options.outputDir, MANIFEST_FILE);
    if (existsSync(manifestSrc)) {
      await copyFile(manifestSrc, join(stagedDir, MANIFEST_FILE));
    }
    // C1d: the publication's ``validation_result_ref`` must resolve inside
    // the immutable version directory — validation_report.json is not a
    // manifest artifact, so it needs an explicit copy.
    const validationSrc = join(options.outputDir, "validation_report.json");
    if (existsSync(validationSrc)) {
      await copyFile(validationSrc, join(stagedDir, "validation_report.json"));
    }
    throwIfAborted(signal);
    await writeFile(
      join(stagedDir, "publication.json"),
      `${pythonJsonDumps(publication)}\n`,
      "utf8",
    );
    throwIfAborted(signal);
    // H2: recheck the pending-input gate immediately before the immutable
    // rename — refusal raises before any version directory exists.
    if (options.pendingCheck !== null && options.pendingCheck !== undefined && options.pendingCheck()) {
      throw new PublicationRefusedError(PUBLICATION_REFUSED_PREFIX);
    }
    // M2: the final abort check sits at the rename boundary so a
    // timed-out/cancelled build can never promote a publication behind its
    // failed record ("no fake-success publication" invariant).
    throwIfAborted(signal);
    await rename(stagedDir, versionDir);
  } catch (error) {
    if (existsSync(stagedDir)) {
      await rm(stagedDir, { recursive: true, force: true });
    }
    if (error instanceof PublicationRefusedError) {
      throw error;
    }
    throw new AtomicPromotionError(
      `atomic promotion failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    publication,
    publicationId,
    versionDir: asPosix(relative(options.outputDir, versionDir)),
    supersedesPublicationId: superseded,
    invariants: {
      provenance_closed: invariants.provenance_closed,
      profile_passed: invariants.profile_passed,
      atomic_promotion_ready: invariants.atomic_promotion_ready,
      artifacts_intact: invariants.artifacts_intact,
    },
  };
}

function dirnameOf(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index < 0 ? "." : path.slice(0, index);
}

/** Python ``datetime.now(UTC).isoformat()``-style timestamp (microseconds). */
function pythonNowIso(): string {
  const iso = new Date().toISOString();
  return iso.replace(/\.\d{3}Z$/, (match) => `.${match.slice(1, 4)}000Z`);
}

function asPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

export type { DatasetPublication, DatasetManifest };