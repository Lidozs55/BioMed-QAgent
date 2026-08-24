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

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync } from "node:fs";
import { copyFile, rename, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { PublicationCandidate } from "@biomed/contracts";
import type {
  DatasetManifest,
  DatasetPublication,
  ValidationResult,
  VersionedDatasetManifest,
} from "../contracts/index.js";
import { parsePublicationCandidate } from "../contracts/index.js";
import { throwIfAborted } from "../cooperative.js";
import { BuildError } from "../adapters/errors.js";
import { asPosix } from "../adapters/paths.js";
import { LockLostError } from "../service/build-lock.js";
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
  manifest: VersionedDatasetManifest;
  validation: ValidationResult;
  publicationCandidate?: PublicationCandidate | null;
  expectedSourceAssetIds?: ReadonlySet<string> | null;
  /** H2: rechecked immediately before the immutable rename. */
  pendingCheck?: (() => boolean) | null;
  /** Injectable for deterministic tests; Python ``datetime.now(UTC)`` default. */
  publishedAt?: string | null;
  /** Cooperative abort signal from the executor (M2 I-03/I-04). */
  signal?: AbortSignal | null;
  /** I-04 publish fence: re-verified immediately before the immutable rename;
   *  the build must still own its build lock, or it is a displaced lease. */
  fence?: (() => boolean | Promise<boolean>) | null;
  /** Deterministic coordination hook immediately before the final fence. */
  beforeFinalFence?: (() => void | Promise<void>) | null;
  /** A7 disk budget: the projected immutable version size (sum of the
   *  manifest artifact receipts + the manifest file). When set, promotion is
   *  refused before staging if the projected size exceeds this bound. */
  maxVersionBytes?: Readonly<number> | null;
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
  const fence = options.fence ?? null;
  throwIfAborted(signal);
  if (fence !== null && !(await fence())) {
    throw new LockLostError(
      "build lock was taken over before publication (displaced lease)",
    );
  }
  const manifest = options.manifest;
  const validation = options.validation;
  if (options.publicationCandidate !== undefined && options.publicationCandidate !== null) {
    const candidate = parsePublicationCandidate(options.publicationCandidate);
    const primary = candidate.tables.find((table) => table.definition.role === "primary");
    const manifestPrimary = manifest.artifacts.find((artifact) => artifact.role === "primary_dataset");
    if (
      candidate.task_id !== manifest.task_id ||
      candidate.build_id !== manifest.build_id ||
      candidate.dataset_family !== manifest.dataset_family ||
      candidate.row_granularity !== manifest.row_granularity ||
      primary === undefined ||
      manifestPrimary === undefined ||
      primary.row_count !== manifest.row_count ||
      primary.data_ref.output_file_sha256 !== manifestPrimary.sha256
    ) {
      throw new BuildError("publication candidate does not match the validated manifest");
    }
  }
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
  // P7 trust anchor: bind the dataset_manifest.json FILE BYTES into the
  // publication receipt. The artifact reader recomputes this digest from the
  // stored manifest file and rejects any record whose file does not match —
  // a tamper that edits manifest top-level metadata (row_count,
  // validation_summary, …) without rewriting the manifest file bytes is
  // detected, even though ``packageDigest`` only hashes entry hashes (the
  // digest does not cover the manifest's own metadata fields).
  //
  // Round-4 audit: the bytes come from ``options.manifest`` (the exact
  // object the release gate validated) — never from re-reading the build's
  // ``dataset_manifest.json`` on disk, which could drift from the gated
  // object. The same bytes are hashed AND written into the immutable
  // version, so gate object, receipt, and publication content are one.
  const manifestBytes = Buffer.from(`${pythonJsonDumps(manifest)}\n`, "utf8");
  const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  // A7 disk budget: refuse BEFORE staging if the projected immutable version
  // exceeds the bound (projected from the manifest receipts — never by reading
  // the multi-GB artifacts). Throwing here leaves no stage dir, so there is no
  // phantom publication to clean up or accidentally promote.
  if (options.maxVersionBytes !== null && options.maxVersionBytes !== undefined) {
    const projected =
      manifest.artifacts.reduce((sum, artifact) => sum + artifact.size_bytes, 0) +
      manifestBytes.length;
    if (projected > options.maxVersionBytes) {
      throw new BuildError(
        `publication package exceeds disk budget: ${projected} bytes > ${options.maxVersionBytes} bytes`,
      );
    }
  }
  const publication: DatasetPublication = {
    // P7 receipt schema: 1.1 carries the manifest file-byte hash (round-3
    // audit: the schema bump is explicit, so legacy 1.0 records keep their
    // pre-P7 trust level instead of silently vanishing from the API).
    schema_version: "1.1",
    publication_id: publicationId,
    manifest_ref: manifest.manifest_id,
    manifest_sha256: manifestSha256,
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
      // A7: stream the copy and compute size/SHA-256 WHILE writing, then
      // re-verify the staged file against the manifest receipt. A copy/target
      // drift (or a stale manifest hash) aborts here — before any promote — so
      // a corrupted staging can never become an official version.
      await copyArtifactVerifying(src, dest, artifact, signal);
      throwIfAborted(signal);
    }
    // Round-4 audit: write the manifest from the GATED bytes, not by
    // copying the build output file — the receipt was computed from these
    // exact bytes, so hash and content cannot diverge.
    await writeFile(join(stagedDir, MANIFEST_FILE), manifestBytes);
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
    // failed record ("no fake-success publication" invariant).  I-04: the
    // fence re-checks lease ownership at the same boundary so a build whose
    // lock was taken over can never publish late.
    throwIfAborted(signal);
    await options.beforeFinalFence?.();
    if (fence !== null && !(await fence())) {
      throw new LockLostError(
        "build lock was taken over before the final rename (displaced lease)",
      );
    }
    await rename(stagedDir, versionDir);
  } catch (error) {
    if (existsSync(stagedDir)) {
      await rm(stagedDir, { recursive: true, force: true });
    }
    if (error instanceof PublicationRefusedError) {
      throw error;
    }
    if (error instanceof LockLostError) {
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

/** Stream a source artifact into the stage dir while computing its size +
 * SHA-256, then re-verify the staged bytes against the manifest receipt.
 * Exported for the A7.2 test to exercise copy/source-drift rejection
 * deterministically (a mid-copy race in a live publish is non-deterministic). */
export async function copyArtifactVerifying(
  src: string,
  dest: string,
  artifact: { size_bytes: number; sha256: string },
  signal: AbortSignal | null,
): Promise<void> {
  const hasher = createHash("sha256");
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(src);
    const output = createWriteStream(dest);
    const fail = (error: unknown): void => {
      input.destroy();
      output.destroy();
      reject(error);
    };
    input.on("error", fail);
    output.on("error", fail);
    input.on("data", (chunk: Buffer) => {
      hasher.update(chunk);
      bytes += chunk.length;
    });
    output.on("finish", () => {
      try {
        throwIfAborted(signal);
        if (bytes !== artifact.size_bytes || hasher.digest("hex") !== artifact.sha256) {
          reject(new AtomicPromotionError("staged artifact receipt mismatch"));
        } else {
          resolve();
        }
      } catch (error) {
        reject(error);
      }
    });
    input.pipe(output);
  });
}

/** Python ``datetime.now(UTC).isoformat()``-style timestamp (microseconds). */
function pythonNowIso(): string {
  const iso = new Date().toISOString();
  return iso.replace(/\.\d{3}Z$/, (match) => `.${match.slice(1, 4)}000Z`);
}

export type { DatasetPublication, DatasetManifest };
