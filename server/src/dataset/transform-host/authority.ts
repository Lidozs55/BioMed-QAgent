import type {
  InputAssetReceipt,
  InputResultReceipt,
  ResourceLimits,
} from "@biomed/contracts";

import { TransformHostError } from "./errors.js";
import { isSha256 } from "./hashing.js";

const AUTHORITY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPAQUE_HANDLE = /^(?:in|out)_[A-Za-z0-9_-]{1,124}$/;
const MAX_AUTHORIZED_INPUTS = 64;
const MAX_AUTHORIZED_OUTPUTS = 32;
const RESOURCE_LIMIT_KEYS = new Set([
  "wall_ms",
  "cpu_ms",
  "rss_bytes",
  "temp_bytes",
  "output_bytes",
  "log_bytes",
  "open_files",
  "pids",
]);
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,1023}$/u;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

export interface CoreAuthorizedInputHandle {
  readonly handle: string;
  readonly receiptKind: "asset" | "result";
  readonly receiptId: string;
}

/**
 * Non-serializable capability plus immutable invocation facts issued by Dataset
 * Core. Constructing the Host with this object is the authority boundary: raw
 * protocol strings are never sufficient to establish task ownership.
 */
export interface CoreAuthoritativeTransformContext {
  readonly authorizationToken: object;
  readonly taskId: string;
  readonly runId: string;
  readonly buildId: string;
  readonly invocationId: string;
  readonly attempt: number;
  readonly generation: number;
  readonly requestDigest: string;
  readonly parametersDigest: string;
  readonly familySpecDigest: string;
  readonly projectionDigest: string;
  readonly implementationDigest: string;
  readonly bundleDigest: string;
  readonly codeBundleRef: string;
  readonly compilerDigest: string;
  readonly runtimeDigest: string;
  readonly policyDigest: string;
  readonly resourceClassId: string;
  readonly resourceLimits: Readonly<ResourceLimits>;
  readonly deadline: string;
  readonly cancelFence: string;
  readonly inputHandles: readonly Readonly<CoreAuthorizedInputHandle>[];
  readonly outputHandles: readonly string[];
  readonly inputAssetReceipts: readonly Readonly<InputAssetReceipt>[];
  readonly inputResultReceipts: readonly Readonly<InputResultReceipt>[];
}

export interface CoreAuthorityClaim {
  readonly authorizationToken: object;
  readonly taskId: string;
  readonly generation: number;
}

export function assertCoreAuthoritativeContext(
  context: CoreAuthoritativeTransformContext,
): void {
  if (!Object.isFrozen(context) || !Object.isFrozen(context.authorizationToken)) {
    throw invalid("Core authoritative context and token must be immutable");
  }
  for (const [label, value] of [
    ["taskId", context.taskId],
    ["runId", context.runId],
    ["buildId", context.buildId],
    ["invocationId", context.invocationId],
    ["resourceClassId", context.resourceClassId],
    ["cancelFence", context.cancelFence],
  ] as const) {
    if (!AUTHORITY_ID.test(value)) throw invalid(`Core ${label} is invalid`);
  }
  for (const [label, value] of [
    ["requestDigest", context.requestDigest],
    ["parametersDigest", context.parametersDigest],
    ["familySpecDigest", context.familySpecDigest],
    ["projectionDigest", context.projectionDigest],
    ["implementationDigest", context.implementationDigest],
    ["bundleDigest", context.bundleDigest],
    ["compilerDigest", context.compilerDigest],
    ["runtimeDigest", context.runtimeDigest],
    ["policyDigest", context.policyDigest],
  ] as const) {
    if (!isSha256(value)) throw invalid(`Core ${label} must be a lowercase SHA-256`);
  }
  if (context.codeBundleRef !== `bundle_${context.bundleDigest}`) {
    throw invalid("Core codeBundleRef must equal bundle_<bundleDigest>");
  }
  if (!isNonNegativeSafeInteger(context.attempt) || !isNonNegativeSafeInteger(context.generation)) {
    throw invalid("Core attempt and generation must be non-negative safe integers");
  }
  if (!isExactIsoUtc(context.deadline)) {
    throw invalid("Core deadline must be a bounded canonical UTC timestamp");
  }
  if (!Object.isFrozen(context.resourceLimits)) {
    throw invalid("Core resource limits must be immutable");
  }
  const resourceEntries = Object.entries(context.resourceLimits);
  if (
    resourceEntries.length !== RESOURCE_LIMIT_KEYS.size
    || resourceEntries.some(([key]) => !RESOURCE_LIMIT_KEYS.has(key))
  ) {
    throw invalid("Core resource limits have unknown or missing fields");
  }
  for (const [key, value] of resourceEntries) {
    if (!isNonNegativeSafeInteger(value)) throw invalid(`Core resource limit ${key} is invalid`);
  }
  validateAuthorizedHandles(context.inputHandles, context.outputHandles);
  validateAssetReceipts(context.inputAssetReceipts);
  validateResultReceipts(context.inputResultReceipts);
  if (context.inputAssetReceipts.length + context.inputResultReceipts.length > MAX_AUTHORIZED_INPUTS) {
    throw invalid(`Core input receipt closure exceeds ${MAX_AUTHORIZED_INPUTS} entries`);
  }
  const authorizedReceipts = new Set(
    context.inputHandles.map((input) => `${input.receiptKind}:${input.receiptId}`),
  );
  const receiptedInputs = new Set([
    ...context.inputAssetReceipts.map((receipt) => `asset:${receipt.asset_id}`),
    ...context.inputResultReceipts.map((receipt) => `result:${receipt.result_manifest_id}`),
  ]);
  if (
    authorizedReceipts.size !== receiptedInputs.size
    || [...authorizedReceipts].some((identity) => !receiptedInputs.has(identity))
  ) {
    throw invalid("Core opaque input handles must exactly bind the input receipt closure");
  }
}

export function assertCoreAuthorityClaim(
  context: CoreAuthoritativeTransformContext,
  claim: CoreAuthorityClaim,
): void {
  if (
    claim.authorizationToken !== context.authorizationToken
    || claim.taskId !== context.taskId
    || claim.generation !== context.generation
  ) {
    throw invalid("Request does not match the Core-authoritative task generation capability");
  }
}

function validateAuthorizedHandles(
  inputs: readonly Readonly<CoreAuthorizedInputHandle>[],
  outputs: readonly string[],
): void {
  if (!Object.isFrozen(inputs) || inputs.length > MAX_AUTHORIZED_INPUTS) {
    throw invalid("Core input handle closure must be immutable and bounded");
  }
  if (!Object.isFrozen(outputs) || outputs.length > MAX_AUTHORIZED_OUTPUTS) {
    throw invalid("Core output handle closure must be immutable and bounded");
  }
  const handleSet = new Set<string>();
  const receiptSet = new Set<string>();
  for (const input of inputs) {
    if (!Object.isFrozen(input) || !OPAQUE_HANDLE.test(input.handle) || !AUTHORITY_ID.test(input.receiptId)) {
      throw invalid("Core input handle binding is invalid");
    }
    if (input.receiptKind !== "asset" && input.receiptKind !== "result") {
      throw invalid("Core input handle receipt kind is invalid");
    }
    const receiptIdentity = `${input.receiptKind}:${input.receiptId}`;
    if (handleSet.has(input.handle) || receiptSet.has(receiptIdentity)) {
      throw invalid("Core input handle closure contains duplicates");
    }
    handleSet.add(input.handle);
    receiptSet.add(receiptIdentity);
  }
  const foldedOutputs = new Set<string>();
  for (const output of outputs) {
    const folded = output.toLocaleLowerCase("en-US");
    if (!OPAQUE_HANDLE.test(output) || foldedOutputs.has(folded)) {
      throw invalid("Core output handle closure is invalid or case-colliding");
    }
    foldedOutputs.add(folded);
  }
}

function validateAssetReceipts(receipts: readonly Readonly<InputAssetReceipt>[]): void {
  if (!Object.isFrozen(receipts)) throw invalid("Core asset receipt closure must be immutable");
  for (const receipt of receipts) {
    if (!Object.isFrozen(receipt)) throw invalid("Core asset receipts must be immutable");
    if (
      receipt.asset_id !== `asset_${receipt.sha256}`
      || !AUTHORITY_ID.test(receipt.role)
      || !SAFE_REF.test(receipt.locator_ref)
    ) {
      throw invalid("Core asset receipt identity is invalid");
    }
    if (!isSha256(receipt.sha256) || !isNonNegativeSafeInteger(receipt.size_bytes)) {
      throw invalid("Core asset receipt bytes are invalid");
    }
  }
}

function validateResultReceipts(receipts: readonly Readonly<InputResultReceipt>[]): void {
  if (!Object.isFrozen(receipts)) throw invalid("Core result receipt closure must be immutable");
  for (const receipt of receipts) {
    if (!Object.isFrozen(receipt)) throw invalid("Core result receipts must be immutable");
    if (
      !AUTHORITY_ID.test(receipt.result_manifest_id)
      || !AUTHORITY_ID.test(receipt.role)
      || !isSha256(receipt.sha256)
      || !isNonNegativeSafeInteger(receipt.size_bytes)
      || !SAFE_REF.test(receipt.locator_ref)
    ) {
      throw invalid("Core result receipt identity is invalid");
    }
  }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isExactIsoUtc(value: string): boolean {
  if (value.length > 40 || !ISO_UTC.test(value)) return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const canonical = new Date(timestamp).toISOString();
  return value === canonical || value === canonical.replace(".000Z", "Z");
}

function invalid(message: string): TransformHostError {
  return new TransformHostError("protocol_invalid", message);
}
