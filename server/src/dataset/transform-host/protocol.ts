import { types } from "node:util";

import { TRANSFORM_HOST_PROTOCOL_VERSION } from "./admission.js";
import { TransformHostError } from "./errors.js";

export const MAX_PROTOCOL_ID_BYTES = 128;
export const MAX_INPUT_HANDLES = 64;
export const MAX_OUTPUT_HANDLES = 32;

export interface OpaqueInputHandleV1 {
  handle: string;
  receiptKind: "asset" | "result";
  receiptId: string;
}

export interface TransformInvocationV1 {
  protocolVersion: typeof TRANSFORM_HOST_PROTOCOL_VERSION;
  operation: "execute_transform";
  taskId: string;
  runId: string;
  requirementId: string;
  invocationId: string;
  attempt: number;
  generation: number;
  requestDigest: string;
  parametersDigest: string;
  familySpecDigest: string;
  projectionDigest: string;
  implementationDigest: string;
  bundleDigest: string;
  codeBundleRef: string;
  compilerDigest: string;
  runtimeDigest: string;
  policyDigest: string;
  inputHandles: readonly OpaqueInputHandleV1[];
  outputHandles: readonly string[];
  resourceClassId: string;
  deadline: string;
  cancelFence: string;
}

export interface TransformTerminalV1 {
  protocolVersion: typeof TRANSFORM_HOST_PROTOCOL_VERSION;
  operation: "transform_terminal";
  invocationId: string;
  generation: number;
  reason: "sandbox_unavailable";
  detail: string;
}

const INVOCATION_KEYS = new Set([
  "protocolVersion",
  "operation",
  "taskId",
  "runId",
  "requirementId",
  "invocationId",
  "attempt",
  "generation",
  "requestDigest",
  "parametersDigest",
  "familySpecDigest",
  "projectionDigest",
  "implementationDigest",
  "bundleDigest",
  "codeBundleRef",
  "compilerDigest",
  "runtimeDigest",
  "policyDigest",
  "inputHandles",
  "outputHandles",
  "resourceClassId",
  "deadline",
  "cancelFence",
]);
const INPUT_HANDLE_KEYS = new Set(["handle", "receiptKind", "receiptId"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SAFE_HANDLE = /^(?:in|out)_[A-Za-z0-9_-]+$/;

/** Strict, bounded, versioned parser for the permanently disabled MVP. */
export function parseTransformInvocationV1(value: unknown): TransformInvocationV1 {
  const record = exactRecord(value, "$", INVOCATION_KEYS);
  literal(record.protocolVersion, TRANSFORM_HOST_PROTOCOL_VERSION, "$.protocolVersion");
  literal(record.operation, "execute_transform", "$.operation");
  const parsed: TransformInvocationV1 = {
    protocolVersion: TRANSFORM_HOST_PROTOCOL_VERSION,
    operation: "execute_transform",
    taskId: boundedId(record.taskId, "$.taskId"),
    runId: boundedId(record.runId, "$.runId"),
    requirementId: boundedId(record.requirementId, "$.requirementId"),
    invocationId: boundedId(record.invocationId, "$.invocationId"),
    attempt: boundedNonNegativeInt(record.attempt, "$.attempt"),
    generation: boundedNonNegativeInt(record.generation, "$.generation"),
    requestDigest: digest(record.requestDigest, "$.requestDigest"),
    parametersDigest: digest(record.parametersDigest, "$.parametersDigest"),
    familySpecDigest: digest(record.familySpecDigest, "$.familySpecDigest"),
    projectionDigest: digest(record.projectionDigest, "$.projectionDigest"),
    implementationDigest: digest(record.implementationDigest, "$.implementationDigest"),
    bundleDigest: digest(record.bundleDigest, "$.bundleDigest"),
    codeBundleRef: bundleRef(record.codeBundleRef, "$.codeBundleRef"),
    compilerDigest: digest(record.compilerDigest, "$.compilerDigest"),
    runtimeDigest: digest(record.runtimeDigest, "$.runtimeDigest"),
    policyDigest: digest(record.policyDigest, "$.policyDigest"),
    inputHandles: inputHandleArray(record.inputHandles, "$.inputHandles"),
    outputHandles: outputHandleArray(record.outputHandles, "$.outputHandles"),
    resourceClassId: boundedId(record.resourceClassId, "$.resourceClassId"),
    deadline: boundedTimestamp(record.deadline, "$.deadline"),
    cancelFence: boundedId(record.cancelFence, "$.cancelFence"),
  };
  if (parsed.codeBundleRef !== `bundle_${parsed.bundleDigest}`) {
    throw invalid("$.codeBundleRef must equal bundle_<bundleDigest>");
  }
  if (new Set(parsed.inputHandles.map((input) => input.handle)).size !== parsed.inputHandles.length) {
    throw invalid("$.inputHandles contains duplicate opaque handles");
  }
  if (new Set(parsed.inputHandles.map((input) => `${input.receiptKind}:${input.receiptId}`)).size !== parsed.inputHandles.length) {
    throw invalid("$.inputHandles contains duplicate receipt identities");
  }
  if (new Set(parsed.outputHandles.map((value) => value.toLocaleLowerCase("en-US"))).size !== parsed.outputHandles.length) {
    throw invalid("$.outputHandles contains duplicate or case-colliding opaque handles");
  }
  return parsed;
}

export function sandboxUnavailableTerminal(
  invocationId: string,
  generation: number,
  detail: string,
): TransformTerminalV1 {
  return {
    protocolVersion: TRANSFORM_HOST_PROTOCOL_VERSION,
    operation: "transform_terminal",
    invocationId,
    generation,
    reason: "sandbox_unavailable",
    detail,
  };
}

function exactRecord(value: unknown, path: string, allowed: ReadonlySet<string>): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || types.isProxy(value)) {
    throw invalid(`${path} must be a plain non-Proxy object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalid(`${path} must have a plain object prototype`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") throw invalid(`${path} must not contain symbol fields`);
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw invalid(`${path}.${key} must be an enumerable data property`);
    }
    if (!allowed.has(key)) throw invalid(`${path} has unknown fields: ${key}`);
    record[key] = descriptor.value;
  }
  return record;
}

function boundedId(value: unknown, path: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value) || byteLength(value) > MAX_PROTOCOL_ID_BYTES) {
    throw invalid(`${path} must be a safe identifier of at most ${MAX_PROTOCOL_ID_BYTES} UTF-8 bytes`);
  }
  return value;
}

function boundedHandle(value: unknown, path: string): string {
  if (typeof value !== "string" || !SAFE_HANDLE.test(value) || byteLength(value) > MAX_PROTOCOL_ID_BYTES) {
    throw invalid(`${path} must be a bounded opaque handle`);
  }
  return value;
}

function digest(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw invalid(`${path} must be a lowercase SHA-256`);
  }
  return value;
}

function bundleRef(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^bundle_[0-9a-f]{64}$/u.test(value)) {
    throw invalid(`${path} must be bundle_<lowercase SHA-256>`);
  }
  return value;
}

function boundedNonNegativeInt(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1_000_000) {
    throw invalid(`${path} must be a non-negative integer no greater than 1000000`);
  }
  return value as number;
}

function boundedTimestamp(value: unknown, path: string): string {
  if (
    typeof value !== "string"
    || byteLength(value) > 40
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
  ) {
    throw invalid(`${path} must be a bounded canonical UTC timestamp`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw invalid(`${path} must be a real UTC timestamp`);
  const canonical = new Date(timestamp).toISOString();
  if (value !== canonical && value !== canonical.replace(".000Z", "Z")) {
    throw invalid(`${path} must be a canonical UTC timestamp`);
  }
  return value;
}

function outputHandleArray(value: unknown, path: string): string[] {
  const entries = exactArray(value, path, MAX_OUTPUT_HANDLES);
  return entries.map((entry, index) => boundedHandle(entry, `${path}[${index}]`));
}

function inputHandleArray(value: unknown, path: string): OpaqueInputHandleV1[] {
  const entries = exactArray(value, path, MAX_INPUT_HANDLES);
  return entries.map((entry, index) => {
    const itemPath = `${path}[${index}]`;
    const record = exactRecord(entry, itemPath, INPUT_HANDLE_KEYS);
    if (record.receiptKind !== "asset" && record.receiptKind !== "result") {
      throw invalid(`${itemPath}.receiptKind must be "asset" or "result"`);
    }
    return {
      handle: boundedHandle(record.handle, `${itemPath}.handle`),
      receiptKind: record.receiptKind,
      receiptId: boundedId(record.receiptId, `${itemPath}.receiptId`),
    };
  });
}

function exactArray(value: unknown, path: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw invalid(`${path} must be a plain non-Proxy array`);
  }
  if (value.length > maximum) throw invalid(`${path} exceeds the ${maximum}-entry limit`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries: unknown[] = [];
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key)) {
      throw invalid(`${path} has an unexpected array field`);
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw invalid(`${path}[${index}] must be an enumerable data property`);
    }
    entries.push(descriptor.value);
  }
  return entries;
}

function literal(value: unknown, expected: string, path: string): void {
  if (value !== expected) throw invalid(`${path} must be ${JSON.stringify(expected)}`);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function invalid(message: string): TransformHostError {
  return new TransformHostError("protocol_invalid", message);
}
