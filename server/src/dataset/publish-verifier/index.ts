import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, opendir, realpath, stat } from "node:fs/promises";
import { types } from "node:util";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type {
  OperationResultManifest,
  ProductAssessment,
} from "@biomed/contracts";
import { parseProductAssessment } from "@biomed/contracts";
import { parseOperationResultManifest } from "../contracts/operation-result.js";
import { canonicalDigest, canonicalJson } from "../adapters/identity.js";

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CHECK_IDS = [
  "receipt",
  "identity",
  "generation",
  "operation_result",
  "digests",
  "assessment",
  "artifact_inventory",
  "artifact_files",
] as const;

export type PublicationVerificationCheckId = (typeof CHECK_IDS)[number];

export interface AuthoritativePublicationReuseRequest {
  readonly task_id: string;
  readonly requirement_id: string;
  readonly run_id: string;
  readonly attempt: number;
  readonly publication_id: string;
  readonly manifest_id: string;
}

export interface PublicationAssetDigest {
  readonly asset_id: string;
  readonly size_bytes: number;
  readonly sha256: string;
}

export interface PublicationArtifactDigest {
  readonly schema: string;
  readonly locator: string;
  readonly size_bytes: number;
  readonly sha256: string;
}

export interface PublicationAssessmentIdentity {
  readonly requirement_id: string;
  readonly package_id: string;
  readonly package_version: string;
}

/** Core-issued, immutable receipt. Callers cannot provide this value. */
export interface AuthoritativePublicationReceipt {
  readonly schema_version: "1.0";
  readonly task_id: string;
  readonly requirement_id: string;
  readonly run_id: string;
  readonly attempt: number;
  readonly generation: number;
  readonly publication_id: string;
  readonly manifest_id: string;
  readonly state: "published" | "revoked";
  readonly input_digest: string;
  readonly parameter_digest: string;
  readonly implementation_digest: string;
  readonly dependency_digest: string;
  readonly asset_digest: string;
  readonly assets: readonly PublicationAssetDigest[];
  readonly artifacts: readonly PublicationArtifactDigest[];
  readonly assessment: PublicationAssessmentIdentity;
  readonly receipt_digest: string;
}

export interface AuthoritativePublicationResolution {
  readonly receipt: AuthoritativePublicationReceipt | null;
  readonly operation_result: OperationResultManifest | null;
  readonly assessment: ProductAssessment | null;
  readonly artifact_root: string | null;
  readonly current_generation: number | null;
}

export type AuthoritativePublicationResolver = (
  request: Readonly<AuthoritativePublicationReuseRequest>,
) => AuthoritativePublicationResolution | null | Promise<AuthoritativePublicationResolution | null>;

export interface PublicationVerificationCheck {
  readonly id: PublicationVerificationCheckId;
  readonly passed: boolean;
}

export interface AuthoritativePublicationEvidence {
  readonly kind: "authoritative_publication_evidence";
  readonly task_id: string;
  readonly requirement_id: string;
  readonly run_id: string;
  readonly attempt: number;
  readonly generation: number;
  readonly publication_id: string;
  readonly manifest_id: string;
  readonly receipt: AuthoritativePublicationReceipt;
  readonly operation_result: OperationResultManifest;
  readonly assessment: ProductAssessment;
  readonly checks: readonly PublicationVerificationCheck[];
}

export interface PublicationNotReusable {
  readonly kind: "not_reusable";
  readonly code: "not_reusable";
  readonly checks: readonly PublicationVerificationCheck[];
  readonly failed_checks: readonly PublicationVerificationCheckId[];
}

export type AuthoritativePublicationVerification =
  | AuthoritativePublicationEvidence
  | PublicationNotReusable;

/**
 * Revalidate a selected publication before reuse. This is deliberately not an
 * executor or publisher hook: it only returns evidence or a typed denial.
 */
export async function verifyAuthoritativePublicationForReuse(
  input: Readonly<AuthoritativePublicationReuseRequest>,
  resolveAuthoritativePublication: AuthoritativePublicationResolver,
): Promise<AuthoritativePublicationVerification> {
  const checks = CHECK_IDS.map((id) => ({ id, passed: false }));
  const deny = (): PublicationNotReusable => Object.freeze({
    kind: "not_reusable",
    code: "not_reusable",
    checks: Object.freeze(checks.map((check) => Object.freeze({ ...check }))),
    failed_checks: Object.freeze(
      checks.filter((check) => !check.passed).map((check) => check.id),
    ),
  });

  try {
    if (!validRequest(input)) return deny();
    const resolved = await resolveAuthoritativePublication(Object.freeze({ ...input }));
    if (!resolved || !resolved.receipt || !resolved.operation_result ||
        !resolved.assessment || !resolved.artifact_root) return deny();

    const receipt = validateReceipt(resolved.receipt);
    if (!receipt) return deny();
    checks[0]!.passed = true;

    if (!sameIdentity(input, receipt)) return deny();
    checks[1]!.passed = true;

    if (!Number.isSafeInteger(resolved.current_generation) ||
        resolved.current_generation !== receipt.generation ||
        !Number.isSafeInteger(receipt.generation) || receipt.generation < 0 ||
        receipt.state !== "published") return deny();
    checks[2]!.passed = true;

    const operationResult = parseOperationResultManifest(
      resolved.operation_result,
      input.task_id,
      input.run_id,
      input.requirement_id,
    );
    if (!validOperationResult(operationResult, input, receipt)) return deny();
    checks[3]!.passed = true;

    if (!validDigests(receipt, operationResult)) return deny();
    checks[4]!.passed = true;

    const assessment = parseProductAssessment(resolved.assessment);
    if (!validAssessment(assessment, receipt)) return deny();
    checks[5]!.passed = true;

    if (!validArtifactInventory(receipt, operationResult)) return deny();
    checks[6]!.passed = true;

    if (!await validArtifactFiles(receipt, operationResult, resolved.artifact_root)) return deny();
    checks[7]!.passed = true;

    return freeze({
      kind: "authoritative_publication_evidence" as const,
      task_id: input.task_id,
      requirement_id: input.requirement_id,
      run_id: input.run_id,
      attempt: input.attempt,
      generation: receipt.generation,
      publication_id: input.publication_id,
      manifest_id: input.manifest_id,
      receipt,
      operation_result: operationResult,
      assessment,
      checks,
    });
  } catch {
    return deny();
  }
}

function validRequest(input: Readonly<AuthoritativePublicationReuseRequest>): boolean {
  if (!isPlainRecord(input)) return false;
  const keys = Object.keys(input).sort();
  if (keys.join(",") !== "attempt,manifest_id,publication_id,requirement_id,run_id,task_id") return false;
  return SAFE_ID.test(input.task_id) && SAFE_ID.test(input.requirement_id) && SAFE_ID.test(input.run_id) &&
    SAFE_ID.test(input.publication_id) && SAFE_ID.test(input.manifest_id) &&
    Number.isSafeInteger(input.attempt) && input.attempt >= 1;
}

function validateReceipt(value: AuthoritativePublicationReceipt): AuthoritativePublicationReceipt | null {
  const snapshot = snapshotPlainData(value);
  if (!isPlainRecord(snapshot)) return null;
  value = snapshot as unknown as AuthoritativePublicationReceipt;
  if (value.schema_version !== "1.0" || !SAFE_ID.test(value.task_id) ||
      !SAFE_ID.test(value.requirement_id) || !SAFE_ID.test(value.run_id) ||
      !SAFE_ID.test(value.publication_id) || !SAFE_ID.test(value.manifest_id) ||
      !Number.isSafeInteger(value.attempt) || value.attempt < 1 ||
      !Number.isSafeInteger(value.generation) || value.generation < 0 ||
      (value.state !== "published" && value.state !== "revoked") ||
      !SHA256.test(value.input_digest) || !SHA256.test(value.parameter_digest) ||
      !SHA256.test(value.implementation_digest) || !SHA256.test(value.dependency_digest) ||
      !SHA256.test(value.asset_digest) || !SHA256.test(value.receipt_digest) ||
      !Array.isArray(value.assets) || !Array.isArray(value.artifacts) ||
      !isPlainRecord(value.assessment)) return null;
  if (!value.assets.every((asset) => isPlainRecord(asset) &&
      typeof asset.asset_id === "string" && SAFE_ID.test(asset.asset_id) &&
      typeof asset.size_bytes === "number" && Number.isSafeInteger(asset.size_bytes) && asset.size_bytes >= 0 &&
      typeof asset.sha256 === "string" && SHA256.test(asset.sha256))) return null;
  if (!value.artifacts.every((artifact) => isPlainRecord(artifact) &&
      typeof artifact.schema === "string" && artifact.schema.length > 0 &&
      typeof artifact.locator === "string" && validRelativeLocator(artifact.locator) &&
      typeof artifact.size_bytes === "number" && Number.isSafeInteger(artifact.size_bytes) &&
      artifact.size_bytes >= 0 && typeof artifact.sha256 === "string" && SHA256.test(artifact.sha256))) return null;
  const assessment = value.assessment;
  if (typeof assessment.requirement_id !== "string" || assessment.requirement_id.length === 0 ||
      typeof assessment.package_id !== "string" || assessment.package_id.length === 0 ||
      typeof assessment.package_version !== "string" || assessment.package_version.length === 0) return null;
  const unsigned = { ...value } as Record<string, unknown>;
  delete unsigned.receipt_digest;
  if (canonicalDigest(unsigned) !== value.receipt_digest) return null;
  return freeze(value);
}

function sameIdentity(
  input: AuthoritativePublicationReuseRequest,
  receipt: AuthoritativePublicationReceipt,
): boolean {
  return receipt.task_id === input.task_id && receipt.requirement_id === input.requirement_id &&
    receipt.run_id === input.run_id && receipt.attempt === input.attempt &&
    receipt.publication_id === input.publication_id && receipt.manifest_id === input.manifest_id;
}

function validOperationResult(
  result: OperationResultManifest,
  input: AuthoritativePublicationReuseRequest,
  receipt: AuthoritativePublicationReceipt,
): boolean {
  const summary = result.output_summary as Record<string, unknown>;
  return result.operation_kind === "publish" && result.output_kind === "publication_manifest" &&
    result.status === "succeeded" && result.output_digest !== null &&
    result.attempt === input.attempt && result.commit.state === "committed" &&
    summary.publication_id === receipt.publication_id && summary.manifest_id === receipt.manifest_id;
}

function validDigests(
  receipt: AuthoritativePublicationReceipt,
  result: OperationResultManifest,
): boolean {
  const dependencyDigest = canonicalDigest(result.dependency_closure);
  const assetDigest = canonicalDigest(receipt.assets.map((asset) => ({
    asset_id: asset.asset_id,
    size_bytes: asset.size_bytes,
    sha256: asset.sha256,
  })));
  return receipt.input_digest === result.input_digest &&
    receipt.parameter_digest === result.parameter_digest &&
    receipt.implementation_digest === result.implementation_digest &&
    receipt.dependency_digest === dependencyDigest && receipt.asset_digest === assetDigest;
}

function validAssessment(
  assessment: ProductAssessment,
  receipt: AuthoritativePublicationReceipt,
): boolean {
  return assessment.product_status === "publishable" &&
    assessment.requirement_id === receipt.assessment.requirement_id &&
    assessment.package_id === receipt.assessment.package_id &&
    assessment.package_version === receipt.assessment.package_version;
}

function validArtifactInventory(
  receipt: AuthoritativePublicationReceipt,
  result: OperationResultManifest,
): boolean {
  if (receipt.artifacts.length !== result.output_files.length || receipt.artifacts.length === 0) return false;
  const expected = new Map(result.output_files.map((file) => [file.relative_path, file]));
  const seen = new Set<string>();
  for (const artifact of receipt.artifacts) {
    if (seen.has(artifact.locator)) return false;
    seen.add(artifact.locator);
    const file = expected.get(artifact.locator);
    if (!file || file.size_bytes !== artifact.size_bytes || file.sha256 !== artifact.sha256) return false;
  }
  return seen.size === expected.size;
}

async function validArtifactFiles(
  receipt: AuthoritativePublicationReceipt,
  result: OperationResultManifest,
  artifactRoot: string,
): Promise<boolean> {
  if (!isAbsolute(artifactRoot)) return false;
  const root = resolve(artifactRoot);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return false;
  if (normalize(await realpath(root)) !== normalize(root)) return false;

  const actualLocators = await listRegularFiles(root);
  const expectedLocators = [...receipt.artifacts.map((artifact) => artifact.locator)].sort();
  if (actualLocators.length !== expectedLocators.length ||
      actualLocators.some((locator, index) => locator !== expectedLocators[index])) return false;

  for (const artifact of receipt.artifacts) {
    const target = resolve(root, ...artifact.locator.split("/"));
    const rootRelative = relative(root, target);
    if (rootRelative === "" || rootRelative.startsWith(`..${sep}`) || isAbsolute(rootRelative)) return false;
    let current = root;
    for (const part of artifact.locator.split("/")) {
      current = resolve(current, part);
      const info = await lstat(current);
      if (info.isSymbolicLink()) return false;
    }
    const info = await stat(target);
    if (!info.isFile() || info.nlink > 1 || info.size !== artifact.size_bytes) return false;
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(target)) digest.update(chunk);
    if (digest.digest("hex") !== artifact.sha256) return false;
  }

  return result.output_files.every((file) => receipt.artifacts.some((artifact) => artifact.locator === file.relative_path));
}

function validRelativeLocator(value: string): boolean {
  return value.length > 0 && !value.includes("\\") && !value.startsWith("/") &&
    !/^[A-Za-z]:/.test(value) && !value.split("/").some((part) => part === "" || part === "." || part === "..");
}

function normalize(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

async function listRegularFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string, prefix: string): Promise<void> {
    const entries = [];
    for await (const entry of await opendir(directory)) entries.push(entry);
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const locator = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const target = resolve(directory, entry.name);
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new TypeError("publication artifacts must not contain symbolic links");
      if (info.isDirectory()) await visit(target, locator);
      else if (info.isFile()) files.push(locator);
      else throw new TypeError("publication artifacts must contain regular files only");
    }
  }
  await visit(root, "");
  return files.sort();
}

function snapshotPlainData(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (types.isProxy(value)) throw new TypeError("publication evidence must not contain proxies");
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (!lengthDescriptor || !("value" in lengthDescriptor) || lengthDescriptor.value !== value.length) {
      throw new TypeError("invalid array length");
    }
    const copy: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError("publication evidence arrays must be dense data arrays");
      }
      copy.push(snapshotPlainData(descriptor.value));
    }
    return copy;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError("publication evidence must be plain data");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") throw new TypeError("publication evidence must use string keys");
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("publication evidence must use enumerable data properties");
    }
    copy[key] = snapshotPlainData(descriptor.value);
  }
  return copy;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

void canonicalJson;
