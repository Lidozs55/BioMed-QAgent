/**
 * D-E2 shadow evidence gate (staging) — minimal Core-owned shadow run
 * comparison (ADR-038/039 and docs/architecture/canonical-evidence.md).
 *
 * Pure Core decision boundary that compares two selected shadow runs
 * (legacy vs Host) of the same frozen input closure. The untrusted caller
 * may supply only task/build/run/attempt/manifest IDs; every manifest,
 * artifact root and Host receipt comes from the injected Core resolver.
 * The gate:
 *
 * - requires the same input/parameter/implementation/dataset_revision
 *   closure and distinct output roots;
 * - recomputes declared output bytes where possible; a digest that is only
 *   reported is labeled `declared_only` and can never be treated as equal
 *   or trusted (no fallback to reported parity);
 * - preserves the declared PK/tuple column order — a reversal blocks;
 * - blocks on assessment score/blocker and provenance mismatch;
 * - returns not_ready (never shadow_verified) when the Host is unavailable
 *   or a run carries no receipt.
 *
 * Staging scope — this module is intentionally NOT wired anywhere:
 * - It is not exported from any barrel, and no executor/Host/admission/B3
 *   code imports it.
 * - The only product is a `ShadowEvidenceReport`; it never constructs a
 *   Publication, OperationResult or activation decision, and
 *   `shadow_verified` is a boolean that is true only for verdict
 *   "verified".
 * - It performs no direct I/O: byte recomputation is an injected Core
 *   capability ("where possible"), and any recomputation failure leaves
 *   the digest declared_only (fail closed).
 */
import type {
  ProductBlocker,
  ProductScore,
  ProductStatus,
} from "@biomed/contracts";

import { canonicalDigest } from "../adapters/identity.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** Untrusted selection: the caller may supply only these identity fields. */
export interface ShadowRunSelection {
  readonly run_id: string;
  readonly attempt: number;
  readonly manifest_id: string;
}

export interface ShadowRunOutputFile {
  readonly relative_path: string;
  readonly size_bytes: number;
  readonly sha256: string;
}

export interface ShadowRunAssessment {
  readonly product_status: ProductStatus;
  readonly scores: readonly ProductScore[];
  readonly blockers: readonly ProductBlocker[];
}

export interface ShadowRunProvenance {
  readonly source_receipt_ids: readonly string[];
  readonly locators: readonly string[];
  readonly retrieved_at: string | null;
  readonly transform_digest: string | null;
}

/** Immutable typed manifest; produced and validated by the Core resolver. */
export interface ShadowRunManifest {
  readonly manifest_id: string;
  readonly run_id: string;
  readonly attempt: number;
  readonly task_id: string;
  readonly build_id: string;
  readonly input_digest: string;
  readonly parameter_digest: string;
  readonly implementation_digest: string;
  readonly dataset_revision_id: string;
  readonly input_asset_ids: readonly string[];
  readonly upstream_result_manifest_ids: readonly string[];
  readonly output_files: readonly ShadowRunOutputFile[];
  /** Declared PK/tuple column order; the order is part of the declaration. */
  readonly primary_keys: readonly string[];
  readonly assessment: ShadowRunAssessment;
  readonly provenance: ShadowRunProvenance;
}

/** Host transport evidence; null means the run produced no receipt. */
export interface ShadowHostReceipt {
  readonly receipt_id: string;
  readonly receipt_digest: string;
}

export interface ShadowRunResolution {
  readonly manifest: ShadowRunManifest;
  readonly artifact_root: string;
  readonly host_receipt: ShadowHostReceipt | null;
}

export interface ShadowRecomputedBytes {
  readonly sha256: string;
  readonly size_bytes: number;
}

export interface CompareSelectedShadowRunsInput {
  readonly task_id: string;
  readonly build_id: string;
  readonly legacy: ShadowRunSelection;
  readonly host: ShadowRunSelection;
  /**
   * Core-owned resolver: selection + task/build context -> immutable typed
   * manifest, artifact root and Host receipt. A rejection (throw) means the
   * Host is unavailable.
   */
  readonly resolve_run: (
    selection: ShadowRunSelection,
    context: { readonly task_id: string; readonly build_id: string },
  ) => Promise<ShadowRunResolution>;
  /**
   * Core-owned byte recomputation for one declared output file. Returns
   * null when the artifact is unavailable; an absent capability means no
   * recomputation is possible. Digests that are never recomputed stay
   * `declared_only` and can never compare equal or trusted.
   */
  readonly recompute_declared_bytes?: ((
    artifact_root: string,
    relative_path: string,
  ) => Promise<ShadowRecomputedBytes | null>) | null;
  readonly now?: () => Date;
}

export type ShadowEvidenceVerdict = "verified" | "mismatch" | "not_ready";

export type ShadowNotReadyReason = "host_unavailable" | "receipt_missing";

export type ShadowBlockingMismatchCode =
  | "cross_run_mismatch"
  | "same_output_root"
  | "input_closure_mismatch"
  | "output_closure_mismatch"
  | "byte_tamper"
  | "byte_parity_unverifiable"
  | "primary_key_order_mismatch"
  | "assessment_scores_mismatch"
  | "assessment_blockers_mismatch"
  | "provenance_mismatch";

export interface ShadowBlockingMismatch {
  readonly code: ShadowBlockingMismatchCode;
  readonly detail: string;
}

export interface ShadowClosureComparison {
  readonly input_digest_equal: boolean;
  readonly parameter_digest_equal: boolean;
  readonly implementation_digest_equal: boolean;
  readonly dataset_revision_equal: boolean;
  readonly input_assets_equal: boolean;
  readonly upstream_results_equal: boolean;
}

export type ShadowDigestStatus = "recomputed" | "declared_only";

export interface ShadowFileDigestEvidence {
  readonly relative_path: string;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly digest_status: ShadowDigestStatus;
}

export type ShadowDigestComparisonStatus = "equal" | "mismatch" | "declared_only";

export interface ShadowDigestComparison {
  readonly relative_path: string;
  readonly status: ShadowDigestComparisonStatus;
  readonly legacy: ShadowFileDigestEvidence;
  readonly host: ShadowFileDigestEvidence;
}

export interface ShadowEvidenceReport {
  schema_version: "1.0";
  report_kind: "shadow_evidence";
  report_id: string;
  task_id: string;
  build_id: string;
  legacy_run: ShadowRunSelection;
  host_run: ShadowRunSelection;
  verdict: ShadowEvidenceVerdict;
  /** True only when verdict === "verified"; never produced otherwise. */
  shadow_verified: boolean;
  not_ready_reason: ShadowNotReadyReason | null;
  not_ready_detail: string | null;
  blocking_mismatches: readonly ShadowBlockingMismatch[];
  closure: ShadowClosureComparison | null;
  digest_comparisons: readonly ShadowDigestComparison[];
  primary_keys_preserved: boolean | null;
  assessment_match: boolean | null;
  provenance_match: boolean | null;
  legacy_artifact_root: string | null;
  host_artifact_root: string | null;
  issued_at: string;
}

/** Typed rejection for malformed untrusted selections. */
export class ShadowEvidenceInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShadowEvidenceInputError";
  }
}

/** Internal short-circuit for not_ready outcomes. */
class NotReadySignal extends Error {
  constructor(
    readonly reason: ShadowNotReadyReason,
    readonly detail: string,
  ) {
    super(detail);
    this.name = "NotReadySignal";
  }
}

interface ReportBase {
  schema_version: "1.0";
  report_kind: "shadow_evidence";
  report_id: string;
  task_id: string;
  build_id: string;
  legacy_run: ShadowRunSelection;
  host_run: ShadowRunSelection;
  issued_at: string;
}

function nonEmptyId(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new ShadowEvidenceInputError(`${name} must be a non-empty id without NUL`);
  }
  return value;
}

function validateSelection(selection: ShadowRunSelection, name: string): void {
  nonEmptyId(selection.run_id, `${name}.run_id`);
  nonEmptyId(selection.manifest_id, `${name}.manifest_id`);
  if (!Number.isSafeInteger(selection.attempt) || selection.attempt < 1) {
    throw new ShadowEvidenceInputError(`${name}.attempt must be a positive safe integer`);
  }
}

function validateInput(input: CompareSelectedShadowRunsInput): void {
  nonEmptyId(input.task_id, "task_id");
  nonEmptyId(input.build_id, "build_id");
  validateSelection(input.legacy, "legacy");
  validateSelection(input.host, "host");
}

function sameFilesystemPath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}

function sortedIdsEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

function arraysEqual<T>(left: readonly T[], right: readonly T[], key: (value: T) => string): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => key(value) === key(right[index]));
}

function scoreKey(score: ProductScore): string {
  return `${score.dimension}|${score.score}|${score.satisfied}|${score.required}`;
}

function blockerKey(blocker: ProductBlocker): string {
  return `${blocker.requirement_id}|${blocker.dimension}|${blocker.code}|${blocker.message}`;
}

async function resolveReadyRun(
  input: CompareSelectedShadowRunsInput,
  selection: ShadowRunSelection,
  name: "legacy" | "host",
): Promise<ShadowRunResolution> {
  let resolution: ShadowRunResolution;
  try {
    resolution = await input.resolve_run(selection, {
      task_id: input.task_id,
      build_id: input.build_id,
    });
  } catch {
    throw new NotReadySignal("host_unavailable", `Host unavailable: resolving the ${name} shadow run failed`);
  }
  if (resolution.host_receipt === null) {
    throw new NotReadySignal("receipt_missing", `${name} shadow run resolution carries no Host receipt`);
  }
  if (
    typeof resolution.host_receipt.receipt_id !== "string"
    || resolution.host_receipt.receipt_id.length === 0
    || typeof resolution.host_receipt.receipt_digest !== "string"
    || !SHA256_PATTERN.test(resolution.host_receipt.receipt_digest)
  ) {
    throw new NotReadySignal("host_unavailable", `${name} shadow run resolution carries a malformed Host receipt`);
  }
  if (
    typeof resolution.artifact_root !== "string"
    || resolution.artifact_root.length === 0
    || resolution.artifact_root.includes("\0")
  ) {
    throw new NotReadySignal("host_unavailable", `${name} shadow run resolution carries no usable artifact root`);
  }
  return resolution;
}

function notReadyReport(
  base: ReportBase,
  reason: ShadowNotReadyReason,
  detail: string,
  legacyArtifactRoot: string | null,
  hostArtifactRoot: string | null,
): ShadowEvidenceReport {
  return {
    ...base,
    verdict: "not_ready",
    shadow_verified: false,
    not_ready_reason: reason,
    not_ready_detail: detail,
    blocking_mismatches: [],
    closure: null,
    digest_comparisons: [],
    primary_keys_preserved: null,
    assessment_match: null,
    provenance_match: null,
    legacy_artifact_root: legacyArtifactRoot,
    host_artifact_root: hostArtifactRoot,
  };
}

/**
 * Compare two selected shadow runs of the same frozen input closure.
 *
 * Deterministic: identical inputs (including the injected clock) always
 * yield an identical report, and every blocking condition is a typed
 * mismatch entry rather than a throw or a fallback to reported parity.
 * `not_ready` is produced only when the Host is unavailable or a receipt
 * is missing, and never carries `shadow_verified`.
 */
export async function compareSelectedShadowRuns(
  input: CompareSelectedShadowRunsInput,
): Promise<ShadowEvidenceReport> {
  validateInput(input);
  const now = (input.now ?? (() => new Date()))();
  if (!Number.isFinite(now.getTime())) {
    throw new TypeError("Core shadow evidence clock returned an invalid timestamp");
  }
  const issuedAt = now.toISOString();
  const reportId = canonicalDigest({
    task_id: input.task_id,
    build_id: input.build_id,
    legacy: input.legacy,
    host: input.host,
  });
  const base: ReportBase = {
    schema_version: "1.0",
    report_kind: "shadow_evidence",
    report_id: reportId,
    task_id: input.task_id,
    build_id: input.build_id,
    legacy_run: input.legacy,
    host_run: input.host,
    issued_at: issuedAt,
  };

  let legacyResolution: ShadowRunResolution;
  try {
    legacyResolution = await resolveReadyRun(input, input.legacy, "legacy");
  } catch (error) {
    if (error instanceof NotReadySignal) {
      return notReadyReport(base, error.reason, error.detail, null, null);
    }
    throw error;
  }
  let hostResolution: ShadowRunResolution;
  try {
    hostResolution = await resolveReadyRun(input, input.host, "host");
  } catch (error) {
    if (error instanceof NotReadySignal) {
      return notReadyReport(
        base,
        error.reason,
        error.detail,
        legacyResolution.artifact_root,
        null,
      );
    }
    throw error;
  }

  const mismatches: ShadowBlockingMismatch[] = [];
  const legacyManifest = legacyResolution.manifest;
  const hostManifest = hostResolution.manifest;
  const legacyRoot = legacyResolution.artifact_root;
  const hostRoot = hostResolution.artifact_root;

  // Cross-run identity: the resolved manifest must be the selected run.
  for (const [name, manifest, selection] of [
    ["legacy", legacyManifest, input.legacy],
    ["host", hostManifest, input.host],
  ] as const) {
    const bindings: Array<[string, string, string]> = [
      ["manifest_id", manifest.manifest_id, selection.manifest_id],
      ["run_id", manifest.run_id, selection.run_id],
      ["task_id", manifest.task_id, input.task_id],
      ["build_id", manifest.build_id, input.build_id],
    ];
    for (const [field, resolved, selected] of bindings) {
      if (resolved !== selected) {
        mismatches.push({
          code: "cross_run_mismatch",
          detail: `${name} resolved ${field}=${resolved} does not match the selected ${field}=${selected}`,
        });
      }
    }
    if (manifest.attempt !== selection.attempt) {
      mismatches.push({
        code: "cross_run_mismatch",
        detail: `${name} resolved attempt=${manifest.attempt} does not match the selected attempt=${selection.attempt}`,
      });
    }
  }

  // Shadow requires independent output roots (08-activation-release.md §3).
  if (sameFilesystemPath(legacyRoot, hostRoot)) {
    mismatches.push({
      code: "same_output_root",
      detail: `both shadow runs resolved to the same output root ${legacyRoot}; shadow requires independent output roots`,
    });
  }

  // Same input/parameter/implementation/dataset_revision closure.
  const closure: ShadowClosureComparison = {
    input_digest_equal: legacyManifest.input_digest === hostManifest.input_digest,
    parameter_digest_equal: legacyManifest.parameter_digest === hostManifest.parameter_digest,
    implementation_digest_equal:
      legacyManifest.implementation_digest === hostManifest.implementation_digest,
    dataset_revision_equal:
      legacyManifest.dataset_revision_id === hostManifest.dataset_revision_id,
    input_assets_equal: sortedIdsEqual(
      legacyManifest.input_asset_ids,
      hostManifest.input_asset_ids,
    ),
    upstream_results_equal: sortedIdsEqual(
      legacyManifest.upstream_result_manifest_ids,
      hostManifest.upstream_result_manifest_ids,
    ),
  };
  const closureFields: Array<[keyof ShadowClosureComparison, string]> = [
    ["input_digest_equal", "input_digest"],
    ["parameter_digest_equal", "parameter_digest"],
    ["implementation_digest_equal", "implementation_digest"],
    ["dataset_revision_equal", "dataset_revision_id"],
    ["input_assets_equal", "input_asset_ids"],
    ["upstream_results_equal", "upstream_result_manifest_ids"],
  ];
  const unequalClosure = closureFields.find(([field]) => !closure[field]);
  if (unequalClosure !== undefined) {
    mismatches.push({
      code: "input_closure_mismatch",
      detail: `shadow runs do not share the same input closure: ${unequalClosure[1]} differs`,
    });
  }

  // Declared output file closure (same relative paths on both sides).
  const legacyPaths = legacyManifest.output_files.map((file) => file.relative_path);
  const hostPaths = hostManifest.output_files.map((file) => file.relative_path);
  if (!sortedIdsEqual(legacyPaths, hostPaths)) {
    mismatches.push({
      code: "output_closure_mismatch",
      detail: "shadow runs declare different output file closures",
    });
  }

  // Recompute declared bytes where possible; otherwise the digest stays
  // declared_only and can never be equal or trusted.
  const recompute = input.recompute_declared_bytes ?? null;
  async function fileEvidence(
    manifest: ShadowRunManifest,
    artifactRoot: string,
    name: "legacy" | "host",
  ): Promise<ShadowFileDigestEvidence[]> {
    const evidence: ShadowFileDigestEvidence[] = [];
    for (const file of manifest.output_files) {
      let digestStatus: ShadowDigestStatus = "declared_only";
      let sha256 = file.sha256;
      let sizeBytes = file.size_bytes;
      if (recompute !== null) {
        let recomputed: ShadowRecomputedBytes | null = null;
        try {
          recomputed = await recompute(artifactRoot, file.relative_path);
        } catch {
          // Fail closed: an unusable recomputation leaves the digest
          // declared_only, which blocks parity instead of trusting it.
        }
        if (recomputed !== null) {
          if (recomputed.sha256 !== file.sha256 || recomputed.size_bytes !== file.size_bytes) {
            mismatches.push({
              code: "byte_tamper",
              detail: `${name} declared bytes for ${file.relative_path} do not match the recomputed bytes`,
            });
          }
          digestStatus = "recomputed";
          sha256 = recomputed.sha256;
          sizeBytes = recomputed.size_bytes;
        }
      }
      evidence.push({
        relative_path: file.relative_path,
        sha256,
        size_bytes: sizeBytes,
        digest_status: digestStatus,
      });
    }
    return evidence;
  }
  const legacyEvidence = await fileEvidence(legacyManifest, legacyRoot, "legacy");
  const hostEvidence = await fileEvidence(hostManifest, hostRoot, "host");

  const digestComparisons: ShadowDigestComparison[] = [];
  const hostEvidenceByPath = new Map(
    hostEvidence.map((evidence) => [evidence.relative_path, evidence]),
  );
  for (const legacyEntry of legacyEvidence) {
    const hostEntry = hostEvidenceByPath.get(legacyEntry.relative_path);
    if (hostEntry === undefined) continue; // output_closure_mismatch already recorded
    let status: ShadowDigestComparisonStatus;
    if (
      legacyEntry.digest_status === "declared_only"
      || hostEntry.digest_status === "declared_only"
    ) {
      status = "declared_only";
      mismatches.push({
        code: "byte_parity_unverifiable",
        detail: `${legacyEntry.relative_path}: a reported-only (declared_only) digest can never be equal or trusted`,
      });
    } else if (
      legacyEntry.sha256 === hostEntry.sha256
      && legacyEntry.size_bytes === hostEntry.size_bytes
    ) {
      status = "equal";
    } else {
      status = "mismatch";
      mismatches.push({
        code: "byte_tamper",
        detail: `${legacyEntry.relative_path}: recomputed bytes differ between shadow runs`,
      });
    }
    digestComparisons.push({
      relative_path: legacyEntry.relative_path,
      status,
      legacy: legacyEntry,
      host: hostEntry,
    });
  }

  // Declared PK/tuple order must be preserved; a reversal blocks.
  const primaryKeysPreserved = arraysEqual(
    legacyManifest.primary_keys,
    hostManifest.primary_keys,
    (value) => value,
  );
  if (!primaryKeysPreserved) {
    const reversed = arraysEqual(
      legacyManifest.primary_keys,
      [...hostManifest.primary_keys].reverse(),
      (value) => value,
    );
    mismatches.push({
      code: "primary_key_order_mismatch",
      detail: reversed
        ? "declared PK/tuple column order is reversed between shadow runs"
        : "declared PK/tuple column order differs between shadow runs",
    });
  }

  // Assessment scores/blockers and provenance must match.
  const scoresMatch = arraysEqual(
    legacyManifest.assessment.scores,
    hostManifest.assessment.scores,
    scoreKey,
  );
  const blockersMatch = arraysEqual(
    legacyManifest.assessment.blockers,
    hostManifest.assessment.blockers,
    blockerKey,
  );
  const assessmentMatch = scoresMatch && blockersMatch;
  if (!scoresMatch) {
    mismatches.push({
      code: "assessment_scores_mismatch",
      detail: "assessment scores differ between shadow runs",
    });
  }
  if (!blockersMatch) {
    mismatches.push({
      code: "assessment_blockers_mismatch",
      detail: "assessment blockers differ between shadow runs",
    });
  }
  const provenanceMatch = sortedIdsEqual(
    legacyManifest.provenance.source_receipt_ids,
    hostManifest.provenance.source_receipt_ids,
  )
    && sortedIdsEqual(legacyManifest.provenance.locators, hostManifest.provenance.locators)
    && legacyManifest.provenance.retrieved_at === hostManifest.provenance.retrieved_at
    && legacyManifest.provenance.transform_digest === hostManifest.provenance.transform_digest;
  if (!provenanceMatch) {
    mismatches.push({
      code: "provenance_mismatch",
      detail: "provenance facts differ between shadow runs",
    });
  }

  const verdict: ShadowEvidenceVerdict = mismatches.length === 0 ? "verified" : "mismatch";
  return {
    ...base,
    verdict,
    shadow_verified: verdict === "verified",
    not_ready_reason: null,
    not_ready_detail: null,
    blocking_mismatches: mismatches,
    closure,
    digest_comparisons: digestComparisons,
    primary_keys_preserved: primaryKeysPreserved,
    assessment_match: assessmentMatch,
    provenance_match: provenanceMatch,
    legacy_artifact_root: legacyRoot,
    host_artifact_root: hostRoot,
  };
}
