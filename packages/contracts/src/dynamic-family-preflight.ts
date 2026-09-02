import { stableStringify } from "./family-transform.js";
import { normalizeSourceBindingKind, type SourceBindingKind } from "./family-transform.js";
import type { JsonValue } from "./json.js";
import {
  assertArray,
  assertHex64,
  assertNonNegativeInt,
  assertObject,
  assertString,
} from "./runtime/primitives.js";
import { APIError } from "./runtime/errors.js";

export interface DynamicFamilyPreflightTopologyDiagnostic {
  code: string;
  path: string;
  message: string;
  object_id: string | null;
}

export interface DynamicFamilyPreflightAcquisitionPlanEntry {
  binding_id: string;
  input_requirement_ref: string;
  source: string;
  mode: "registered" | "builtin";
  /** Normalized binding role; acquisition planning still covers every binding. */
  binding_kind: SourceBindingKind;
  asset_id: string | null;
  provider_id: string | null;
  request_digest: string;
}

export interface DynamicFamilyPreflightReceipt {
  schema_version: "1.0";
  task_id: string;
  requirement_id: string;
  generation: number;
  family_spec_digest: string;
  projection_digest: string;
  product_requirement_digest: string;
  host_descriptor_digest: string;
  submission_digest: string;
  /** Runtime transform-input roles only; provenance-only bindings are excluded. */
  required_input_roles: string[];
  output_closure: string[];
  topology_diagnostics: DynamicFamilyPreflightTopologyDiagnostic[];
  acquisition_plan: DynamicFamilyPreflightAcquisitionPlanEntry[];
  receipt_digest: string;
}

const RECEIPT_KEYS = new Set([
  "schema_version", "task_id", "requirement_id", "generation", "family_spec_digest",
  "projection_digest", "product_requirement_digest", "host_descriptor_digest", "submission_digest",
  "required_input_roles", "output_closure", "topology_diagnostics", "acquisition_plan", "receipt_digest",
]);
const DIAGNOSTIC_KEYS = new Set(["code", "path", "message", "object_id"]);
const PLAN_KEYS = new Set([
  "binding_id", "input_requirement_ref", "source", "mode", "binding_kind", "asset_id", "provider_id", "request_digest",
]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+\-]{0,255}$/u;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,1023}$/u;
const TOPOLOGY_PATH = /^\$[A-Za-z0-9_.$\[\]"@:+/\-]{0,1023}$/u;
const ASSET_ID = /^asset_[0-9a-f]{64}$/u;

function strictObject(value: unknown, path: string, keys: ReadonlySet<string>): Record<string, unknown> {
  const object = assertObject(value, path);
  const ownKeys = Object.keys(object);
  if (ownKeys.length !== keys.size || ownKeys.some((key) => !keys.has(key))) {
    throw new APIError(502, `Unknown or missing fields at ${path}`);
  }
  return object;
}

function safeId(value: unknown, path: string): string {
  const id = assertString(value, path, true);
  if (!SAFE_ID.test(id)) throw new APIError(502, `Invalid safe identifier at ${path}`);
  return id;
}

function safeRef(value: unknown, path: string): string {
  const ref = assertString(value, path, true);
  if (!SAFE_REF.test(ref)) throw new APIError(502, `Invalid safe reference at ${path}`);
  return ref;
}

function topologyPath(value: unknown, path: string): string {
  const ref = assertString(value, path, true);
  if (!TOPOLOGY_PATH.test(ref)) throw new APIError(502, `Invalid topology diagnostic path at ${path}`);
  return ref;
}

function nullableId(value: unknown, path: string): string | null {
  return value === null ? null : safeId(value, path);
}

function parseDiagnostic(value: unknown, path: string): DynamicFamilyPreflightTopologyDiagnostic {
  const object = strictObject(value, path, DIAGNOSTIC_KEYS);
  return {
    code: safeId(object.code, `${path}.code`),
    path: topologyPath(object.path, `${path}.path`),
    message: assertString(object.message, `${path}.message`, true),
    object_id: nullableId(object.object_id, `${path}.object_id`),
  };
}

function parsePlan(value: unknown, path: string): DynamicFamilyPreflightAcquisitionPlanEntry {
  const object = strictObject(value, path, PLAN_KEYS);
  const mode = assertString(object.mode, `${path}.mode`, true);
  if (mode !== "registered" && mode !== "builtin") {
    throw new APIError(502, `Unsupported acquisition plan mode at ${path}.mode`);
  }
  const assetId = object.asset_id === null ? null : safeRef(object.asset_id, `${path}.asset_id`);
  if (assetId !== null && !ASSET_ID.test(assetId)) {
    throw new APIError(502, `Acquisition plan asset_id is not an asset reference at ${path}.asset_id`);
  }
  const providerId = object.provider_id === null ? null : safeId(object.provider_id, `${path}.provider_id`);
  if (mode === "registered" && (assetId === null || providerId !== null)) {
    throw new APIError(502, `Registered acquisition plan entries require asset_id and no provider_id at ${path}`);
  }
  if (mode === "builtin" && (assetId !== null || providerId === null)) {
    throw new APIError(502, `Builtin acquisition plan entries require provider_id and no asset_id at ${path}`);
  }
  return {
    binding_id: safeId(object.binding_id, `${path}.binding_id`),
    input_requirement_ref: safeRef(object.input_requirement_ref, `${path}.input_requirement_ref`),
    source: safeId(object.source, `${path}.source`),
    mode,
    binding_kind: normalizeSourceBindingKind(object.binding_kind, `${path}.binding_kind`),
    asset_id: assetId,
    provider_id: providerId,
    request_digest: assertHex64(object.request_digest, `${path}.request_digest`),
  };
}

export function parseDynamicFamilyPreflightReceipt(
  value: unknown,
  path: string,
): DynamicFamilyPreflightReceipt {
  const object = strictObject(value, path, RECEIPT_KEYS);
  const requiredInputRoles = assertArray(
    object.required_input_roles,
    `${path}.required_input_roles`,
    (item, index) => safeRef(item, `${path}.required_input_roles[${index}]`),
  );
  const outputClosure = assertArray(
    object.output_closure,
    `${path}.output_closure`,
    (item, index) => safeId(item, `${path}.output_closure[${index}]`),
  );
  const topologyDiagnostics = assertArray(
    object.topology_diagnostics,
    `${path}.topology_diagnostics`,
    (item, index) => parseDiagnostic(item, `${path}.topology_diagnostics[${index}]`),
  );
  const acquisitionPlan = assertArray(
    object.acquisition_plan,
    `${path}.acquisition_plan`,
    (item, index) => parsePlan(item, `${path}.acquisition_plan[${index}]`),
  );
  if (new Set(acquisitionPlan.map((entry) => entry.binding_id)).size !== acquisitionPlan.length) {
    throw new APIError(502, `Duplicate acquisition plan binding at ${path}.acquisition_plan`);
  }
  if (object.schema_version !== "1.0") {
    throw new APIError(502, `Unsupported schema_version at ${path}.schema_version`);
  }
  return {
    schema_version: "1.0",
    task_id: safeId(object.task_id, `${path}.task_id`),
    requirement_id: safeId(object.requirement_id, `${path}.requirement_id`),
    generation: assertNonNegativeInt(object.generation, `${path}.generation`),
    family_spec_digest: assertHex64(object.family_spec_digest, `${path}.family_spec_digest`),
    projection_digest: assertHex64(object.projection_digest, `${path}.projection_digest`),
    product_requirement_digest: assertHex64(
      object.product_requirement_digest,
      `${path}.product_requirement_digest`,
    ),
    host_descriptor_digest: assertHex64(object.host_descriptor_digest, `${path}.host_descriptor_digest`),
    submission_digest: assertHex64(object.submission_digest, `${path}.submission_digest`),
    required_input_roles: requiredInputRoles,
    output_closure: outputClosure,
    topology_diagnostics: topologyDiagnostics,
    acquisition_plan: acquisitionPlan,
    receipt_digest: assertHex64(object.receipt_digest, `${path}.receipt_digest`),
  };
}

export function dynamicFamilyPreflightReceiptDigestBody(
  receipt: DynamicFamilyPreflightReceipt,
): Omit<DynamicFamilyPreflightReceipt, "receipt_digest"> {
  const parsed = parseDynamicFamilyPreflightReceipt(receipt, "$preflight_receipt");
  return {
    schema_version: parsed.schema_version,
    task_id: parsed.task_id,
    requirement_id: parsed.requirement_id,
    generation: parsed.generation,
    family_spec_digest: parsed.family_spec_digest,
    projection_digest: parsed.projection_digest,
    product_requirement_digest: parsed.product_requirement_digest,
    host_descriptor_digest: parsed.host_descriptor_digest,
    submission_digest: parsed.submission_digest,
    required_input_roles: parsed.required_input_roles,
    output_closure: parsed.output_closure,
    topology_diagnostics: parsed.topology_diagnostics,
    acquisition_plan: parsed.acquisition_plan,
  };
}

export function buildDynamicFamilyPreflightReceiptDigestCanonical(
  receipt: DynamicFamilyPreflightReceipt,
): string {
  return stableStringify(dynamicFamilyPreflightReceiptDigestBody(receipt) as unknown as JsonValue);
}

export async function computeDynamicFamilyPreflightReceiptDigest(
  receipt: DynamicFamilyPreflightReceipt,
): Promise<string> {
  const cryptoObject = globalThis.crypto;
  if (!cryptoObject?.subtle) throw new APIError(500, "Web Crypto is unavailable");
  const bytes = new TextEncoder().encode(buildDynamicFamilyPreflightReceiptDigestCanonical(receipt));
  const digest = await cryptoObject.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
