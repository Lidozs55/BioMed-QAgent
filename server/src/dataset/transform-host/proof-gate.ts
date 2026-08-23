import { types } from "node:util";

import { TransformHostError } from "./errors.js";
import { isSha256, sha256Bytes } from "./hashing.js";

/**
 * B-T6/B-T7 minimal sandbox proof gate (Host-owned, fail-closed).
 *
 * A sandbox proof is the contract a future isolated backend must satisfy before
 * Agent-authored transforms may execute: backend identity, low-privilege
 * identity, network denial, unmounted Host paths, hard kill, isolation
 * evidence, a canonical claims digest, platform, and validity window.
 *
 * This Host build has no trusted backend attestation, so evaluateSandboxProof()
 * never permits execution. Any missing field, unknown field, privilege
 * escalation, expired or future-dated proof, digest mutation, platform
 * mismatch, or incomplete Windows isolation claim resolves to
 * sandbox_unavailable; a structurally perfect proof still resolves to
 * sandbox_unavailable because it is caller-reported. There is intentionally no
 * enabled outcome in this build, and the gate never executes processes or
 * loads code (no child_process, node:vm, or worker_threads).
 */

export const SANDBOX_PROOF_SCHEMA_VERSION = "1.0" as const;

const MAX_PROOF_STRING_BYTES = 128;
const MAX_PROOF_EVIDENCE_BYTES = 512;
const MAX_PROOF_TIMESTAMP_BYTES = 40;
const MAX_UID_GID = 2_147_483_647;
const SAFE_BACKEND_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const PRIVILEGED_ACCOUNT = /^(?:root|administrator)$/i;

const PROOF_KEYS = new Set([
  "schemaVersion",
  "backendId",
  "backendVersion",
  "identity",
  "networkDenied",
  "unmounted",
  "hardKill",
  "isolationEvidence",
  "proofDigest",
  "platform",
  "issuedAt",
  "expiresAt",
  "windows",
]);
const REQUIRED_PROOF_KEYS = Object.freeze(
  [...PROOF_KEYS].filter((key) => key !== "windows"),
);
const IDENTITY_KEYS = new Set(["user", "uid", "gid", "privileged"]);
const REQUIRED_IDENTITY_KEYS = Object.freeze([...IDENTITY_KEYS]);
const UNMOUNTED_KEYS = new Set(["workspace", "settings", "publication"]);
const EVIDENCE_KEYS = new Set(["acl", "jobObject", "container"]);
const WINDOWS_KEYS = new Set(["serviceAccount", "acl", "jobObject", "networkDeny"]);

/** Low-privilege identity the backend reports the sandbox process runs as. */
export interface SandboxProofIdentityV1 {
  user: string;
  uid: number;
  gid: number;
  privileged: false;
}

/** Host paths that must not be mounted into the sandbox. */
export interface SandboxProofMountClaimsV1 {
  workspace: true;
  settings: true;
  publication: true;
}

/** Backend-supplied isolation evidence references (ACL / Job Object / container). */
export interface SandboxProofIsolationEvidenceV1 {
  acl: string;
  jobObject: string;
  container: string;
}

/** Windows-only completeness: service account/ACL + Job Object + network deny. */
export interface SandboxProofWindowsCompletenessV1 {
  serviceAccount: true;
  acl: true;
  jobObject: true;
  networkDeny: true;
}

/**
 * The full wire shape a trusted backend proof must satisfy. Parsed strictly
 * from unknown input; every claim except `windows` is required, and `windows`
 * is required exactly when the proof platform is win32.
 */
export interface SandboxProofV1 {
  schemaVersion: typeof SANDBOX_PROOF_SCHEMA_VERSION;
  backendId: string;
  backendVersion: string;
  identity: SandboxProofIdentityV1;
  networkDenied: true;
  unmounted: SandboxProofMountClaimsV1;
  hardKill: true;
  isolationEvidence: SandboxProofIsolationEvidenceV1;
  proofDigest: string;
  platform: NodeJS.Platform;
  issuedAt: string;
  expiresAt: string;
  windows?: SandboxProofWindowsCompletenessV1;
}

/** The digest-covered claims: SandboxProofV1 minus `proofDigest`. */
export interface SandboxProofCanonicalClaimsV1 {
  schemaVersion: typeof SANDBOX_PROOF_SCHEMA_VERSION;
  backendId: string;
  backendVersion: string;
  identity: SandboxProofIdentityV1;
  networkDenied: true;
  unmounted: SandboxProofMountClaimsV1;
  hardKill: true;
  isolationEvidence: SandboxProofIsolationEvidenceV1;
  platform: NodeJS.Platform;
  issuedAt: string;
  expiresAt: string;
  windows?: SandboxProofWindowsCompletenessV1;
}

export type SandboxProofDenialReason =
  | "proof_missing"
  | "unknown_field"
  | "missing_field"
  | "field_invalid"
  | "privilege_escalation"
  | "network_not_denied"
  | "mount_violation"
  | "hard_kill_missing"
  | "isolation_evidence_missing"
  | "platform_mismatch"
  | "windows_incomplete"
  | "digest_mismatch"
  | "proof_not_yet_valid"
  | "proof_expired"
  | "self_reported";

/** Fail-closed evaluation. Structural type: there is no enabled variant. */
export interface SandboxProofEvaluation {
  permitted: false;
  status: "sandbox_unavailable";
  reason: SandboxProofDenialReason;
  platform: NodeJS.Platform;
  detail: string;
}

export interface SandboxProofGateOptions {
  now?: () => Date;
  platform?: NodeJS.Platform;
}

/**
 * Deterministic canonical serialization of the digest-covered claims. Fixed
 * field order, no whitespace; used both by the gate and by proof issuers.
 */
export function canonicalSandboxProofClaims(claims: SandboxProofCanonicalClaimsV1): string {
  const body = {
    schemaVersion: claims.schemaVersion,
    backendId: claims.backendId,
    backendVersion: claims.backendVersion,
    identity: {
      user: claims.identity.user,
      uid: claims.identity.uid,
      gid: claims.identity.gid,
      privileged: claims.identity.privileged,
    },
    networkDenied: claims.networkDenied,
    unmounted: {
      workspace: claims.unmounted.workspace,
      settings: claims.unmounted.settings,
      publication: claims.unmounted.publication,
    },
    hardKill: claims.hardKill,
    isolationEvidence: {
      acl: claims.isolationEvidence.acl,
      jobObject: claims.isolationEvidence.jobObject,
      container: claims.isolationEvidence.container,
    },
    platform: claims.platform,
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
  };
  if (claims.windows === undefined) {
    return JSON.stringify(body);
  }
  return JSON.stringify({
    ...body,
    windows: {
      serviceAccount: claims.windows.serviceAccount,
      acl: claims.windows.acl,
      jobObject: claims.windows.jobObject,
      networkDeny: claims.windows.networkDeny,
    },
  });
}

/**
 * Host-owned proof evaluation. Never throws and never permits: any missing
 * field, expired/not-yet-valid proof, caller-reported claim, digest mutation,
 * platform mismatch, or incomplete Windows isolation claim resolves to
 * sandbox_unavailable. `now` and `platform` are injectable for determinism.
 */
export function evaluateSandboxProof(
  input: unknown,
  options: SandboxProofGateOptions = {},
): SandboxProofEvaluation {
  const platform = options.platform ?? process.platform;
  const now = (options.now ?? (() => new Date()))();
  return evaluateNow(input, platform, now);
}

/**
 * Throws a typed TransformHostError (code `sandbox_unavailable`) unless a
 * trusted sandbox proof permits execution. This build never permits, so it
 * always throws. The evaluation is attached as the error cause.
 */
export function assertExecutionPermitted(
  input: unknown,
  options: SandboxProofGateOptions = {},
): never {
  const evaluation = evaluateSandboxProof(input, options);
  if (evaluation.permitted) {
    throw new TransformHostError(
      "protocol_invalid",
      "Unreachable: this Host build has no permitted sandbox proof outcome",
      { cause: evaluation },
    );
  }
  throw new TransformHostError("sandbox_unavailable", evaluation.detail, { cause: evaluation });
}

function evaluateNow(
  input: unknown,
  platform: NodeJS.Platform,
  now: Date,
): SandboxProofEvaluation {
  const top = parseRecord(input, "Sandbox proof");
  if (!top.ok) {
    return deny("proof_missing", top.detail, platform);
  }
  const record = top.record;

  for (const key of Object.keys(record)) {
    if (!PROOF_KEYS.has(key)) {
      return deny("unknown_field", `Sandbox proof carries unsupported field "${key}"`, platform);
    }
  }
  for (const key of REQUIRED_PROOF_KEYS) {
    if (!(key in record)) {
      return deny("missing_field", `Sandbox proof is missing required field "${key}"`, platform);
    }
  }

  if (record.schemaVersion !== SANDBOX_PROOF_SCHEMA_VERSION) {
    return deny("field_invalid", `$.schemaVersion must be "${SANDBOX_PROOF_SCHEMA_VERSION}"`, platform);
  }

  const backendId = boundedId(record.backendId);
  if (backendId === null) {
    return deny("field_invalid", "$.backendId must be a safe identifier of at most 128 UTF-8 bytes", platform);
  }
  const backendVersion = boundedPrintable(record.backendVersion, MAX_PROOF_STRING_BYTES);
  if (backendVersion === null) {
    return deny("field_invalid", "$.backendVersion must be a bounded printable string", platform);
  }

  const identity = parseRecord(record.identity, "$.identity");
  if (!identity.ok) {
    return deny("field_invalid", identity.detail, platform);
  }
  for (const key of Object.keys(identity.record)) {
    if (!IDENTITY_KEYS.has(key)) {
      return deny("unknown_field", `$.identity carries unsupported field "${key}"`, platform);
    }
  }
  for (const key of REQUIRED_IDENTITY_KEYS) {
    if (!(key in identity.record)) {
      return deny("missing_field", `$.identity is missing required field "${key}"`, platform);
    }
  }
  const user = boundedPrintable(identity.record.user, MAX_PROOF_STRING_BYTES);
  if (user === null) {
    return deny("field_invalid", "$.identity.user must be a bounded printable string", platform);
  }
  if (PRIVILEGED_ACCOUNT.test(user)) {
    return deny("privilege_escalation", `$.identity.user "${user}" is a privileged account`, platform);
  }
  const uid = boundedIdNumber(identity.record.uid);
  if (uid === null) {
    return deny("field_invalid", "$.identity.uid must be a non-negative integer no greater than 2147483647", platform);
  }
  if (uid === 0) {
    return deny("privilege_escalation", "$.identity.uid 0 is a privileged identity", platform);
  }
  const gid = boundedIdNumber(identity.record.gid);
  if (gid === null) {
    return deny("field_invalid", "$.identity.gid must be a non-negative integer no greater than 2147483647", platform);
  }
  if (gid === 0) {
    return deny("privilege_escalation", "$.identity.gid 0 is a privileged group", platform);
  }
  if (typeof identity.record.privileged !== "boolean") {
    return deny("field_invalid", "$.identity.privileged must be a boolean", platform);
  }
  if (identity.record.privileged === true) {
    return deny("privilege_escalation", "$.identity.privileged must be false for a low-privilege identity", platform);
  }

  if (record.networkDenied !== true) {
    return deny("network_not_denied", "$.networkDenied must be true (no network, DNS, or proxy)", platform);
  }

  const unmounted = parseRecord(record.unmounted, "$.unmounted");
  if (!unmounted.ok) {
    return deny("mount_violation", unmounted.detail, platform);
  }
  for (const key of Object.keys(unmounted.record)) {
    if (!UNMOUNTED_KEYS.has(key)) {
      return deny("unknown_field", `$.unmounted carries unsupported field "${key}"`, platform);
    }
  }
  for (const key of UNMOUNTED_KEYS) {
    if (unmounted.record[key] !== true) {
      return deny("mount_violation", `$.unmounted.${key} must be true (Host paths are not mounted into the sandbox)`, platform);
    }
  }

  if (record.hardKill !== true) {
    return deny("hard_kill_missing", "$.hardKill must be true (hard wall-clock kill and process-tree cleanup)", platform);
  }

  const evidence = parseRecord(record.isolationEvidence, "$.isolationEvidence");
  if (!evidence.ok) {
    return deny("isolation_evidence_missing", evidence.detail, platform);
  }
  for (const key of Object.keys(evidence.record)) {
    if (!EVIDENCE_KEYS.has(key)) {
      return deny("unknown_field", `$.isolationEvidence carries unsupported field "${key}"`, platform);
    }
  }
  const aclEvidence = boundedPrintable(evidence.record.acl, MAX_PROOF_EVIDENCE_BYTES);
  if (aclEvidence === null) {
    return deny("isolation_evidence_missing", "$.isolationEvidence.acl must be a bounded evidence reference", platform);
  }
  const jobObjectEvidence = boundedPrintable(evidence.record.jobObject, MAX_PROOF_EVIDENCE_BYTES);
  if (jobObjectEvidence === null) {
    return deny("isolation_evidence_missing", "$.isolationEvidence.jobObject must be a bounded evidence reference", platform);
  }
  const containerEvidence = boundedPrintable(evidence.record.container, MAX_PROOF_EVIDENCE_BYTES);
  if (containerEvidence === null) {
    return deny("isolation_evidence_missing", "$.isolationEvidence.container must be a bounded evidence reference", platform);
  }

  if (typeof record.platform !== "string") {
    return deny("field_invalid", "$.platform must be a string", platform);
  }
  if (record.platform !== platform) {
    return deny(
      "platform_mismatch",
      `Sandbox proof platform "${record.platform}" does not match Host platform "${platform}"`,
      platform,
    );
  }

  let windowsClaims: SandboxProofWindowsCompletenessV1 | undefined;
  if (platform === "win32") {
    if (!("windows" in record)) {
      return deny("windows_incomplete", "Win32 proofs must carry $.windows completeness evidence", platform);
    }
    const windows = parseRecord(record.windows, "$.windows");
    if (!windows.ok) {
      return deny("windows_incomplete", windows.detail, platform);
    }
    for (const key of Object.keys(windows.record)) {
      if (!WINDOWS_KEYS.has(key)) {
        return deny("unknown_field", `$.windows carries unsupported field "${key}"`, platform);
      }
    }
    for (const key of WINDOWS_KEYS) {
      if (windows.record[key] !== true) {
        return deny(
          "windows_incomplete",
          `$.windows.${key} must be true (service account/ACL + Job Object + network deny)`,
          platform,
        );
      }
    }
    windowsClaims = { serviceAccount: true, acl: true, jobObject: true, networkDeny: true };
  } else if ("windows" in record) {
    return deny("field_invalid", "$.windows is only valid for win32 sandbox proofs", platform);
  }

  const issuedAt = boundedTimestamp(record.issuedAt);
  if (issuedAt === null) {
    return deny("field_invalid", "$.issuedAt must be a bounded ISO-8601 timestamp", platform);
  }
  const expiresAt = boundedTimestamp(record.expiresAt);
  if (expiresAt === null) {
    return deny("field_invalid", "$.expiresAt must be a bounded ISO-8601 timestamp", platform);
  }
  const issuedMillis = Date.parse(issuedAt);
  const expiresMillis = Date.parse(expiresAt);
  if (issuedMillis >= expiresMillis) {
    return deny("field_invalid", "$.issuedAt must precede $.expiresAt", platform);
  }
  const nowMillis = now.getTime();
  if (nowMillis < issuedMillis) {
    return deny("proof_not_yet_valid", "Sandbox proof is not valid yet (issuedAt is in the future)", platform);
  }
  if (nowMillis > expiresMillis) {
    return deny("proof_expired", "Sandbox proof has expired (now is past expiresAt)", platform);
  }

  if (typeof record.proofDigest !== "string" || !isSha256(record.proofDigest)) {
    return deny("field_invalid", "$.proofDigest must be a lowercase SHA-256", platform);
  }
  const claims: SandboxProofCanonicalClaimsV1 = {
    schemaVersion: SANDBOX_PROOF_SCHEMA_VERSION,
    backendId,
    backendVersion,
    identity: { user, uid, gid, privileged: false },
    networkDenied: true,
    unmounted: { workspace: true, settings: true, publication: true },
    hardKill: true,
    isolationEvidence: {
      acl: aclEvidence,
      jobObject: jobObjectEvidence,
      container: containerEvidence,
    },
    platform,
    issuedAt,
    expiresAt,
    windows: windowsClaims,
  };
  if (record.proofDigest !== sha256Bytes(canonicalSandboxProofClaims(claims))) {
    return deny("digest_mismatch", "Sandbox proof digest does not match the canonical claims digest", platform);
  }

  // Trust boundary: a proof is acceptable only when a trusted backend
  // attestation is configured and verified. This Host build never configures
  // one (B-T6/B-T7 stay disabled until an isolated low-privilege backend
  // exists), so a structurally valid proof is still caller-reported and
  // execution remains disabled. There is intentionally no enabled outcome.
  return deny(
    "self_reported",
    "Sandbox proof is caller-reported; no trusted backend attestation is configured on this Host, so Agent-authored transforms remain disabled",
    platform,
  );
}

function deny(
  reason: SandboxProofDenialReason,
  detail: string,
  platform: NodeJS.Platform,
): SandboxProofEvaluation {
  return Object.freeze({
    permitted: false,
    status: "sandbox_unavailable",
    reason,
    platform,
    detail,
  });
}

type RecordParse =
  | { ok: true; record: Record<string, unknown> }
  | { ok: false; detail: string };

function parseRecord(value: unknown, label: string): RecordParse {
  if (typeof value !== "object" || value === null || Array.isArray(value) || types.isProxy(value)) {
    return { ok: false, detail: `${label} must be a plain non-Proxy object` };
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return { ok: false, detail: `${label} must have a plain object prototype` };
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") {
      return { ok: false, detail: `${label} must not contain symbol fields` };
    }
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      return { ok: false, detail: `${label}.${key} must be an enumerable data property` };
    }
    record[key] = descriptor.value;
  }
  return { ok: true, record };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundedId(value: unknown): string | null {
  if (typeof value !== "string" || !SAFE_BACKEND_ID.test(value) || byteLength(value) > MAX_PROOF_STRING_BYTES) {
    return null;
  }
  return value;
}

function isPrintable(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return false;
    }
  }
  return true;
}

function boundedPrintable(value: unknown, maxBytes: number): string | null {
  if (
    typeof value !== "string"
    || value.length === 0
    || !isPrintable(value)
    || byteLength(value) > maxBytes
  ) {
    return null;
  }
  return value;
}

function boundedIdNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_UID_GID) {
    return null;
  }
  return value;
}

function boundedTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || byteLength(value) > MAX_PROOF_TIMESTAMP_BYTES) {
    return null;
  }
  return Number.isFinite(Date.parse(value)) ? value : null;
}
