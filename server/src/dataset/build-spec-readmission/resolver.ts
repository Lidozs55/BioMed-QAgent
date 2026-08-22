import {
  assertArray,
  assertHex64,
  assertNonNegativeInt,
  assertObject,
  assertString,
  parseDatasetBuildProposal2,
  parseResolvedDatasetBuildSpec2,
  stableStringify,
  verifyFamilySpecDigest,
  type DatasetBuildProposal2,
  type FamilySpec,
  type JsonValue,
  type ResolvedDatasetBuildSpec2,
} from "@biomed/contracts";

import {
  BuildSpecResolutionError,
  type BuildSpecRegisteredRecord,
  type BuildSpecResolution,
  type BuildSpecResolutionContext,
  type BuildSpecResolutionEvidence,
  type FamilyStatus,
} from "./types.js";

const FAMILY_STATUSES: readonly FamilyStatus[] = [
  "submitted",
  "sandbox_executable",
  "fixture_verified",
  "shadow_verified",
  "trusted_e2e_verified",
  "activated",
  "revoked",
  "retired",
];

const CONTEXT_KEYS = new Set([
  "registry_generation",
  "registry_snapshot_digest",
  "family",
  "assets",
  "results",
]);
const FAMILY_KEYS = new Set(["family_spec", "family_status"]);
const RECORD_KEYS = new Set(["binding_id", "task_id", "generation", "registered_ref", "receipt_digest"]);

function ownValue(object: Record<string, unknown>, key: string, path: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !("value" in descriptor)) {
    throw new BuildSpecResolutionError("invalid_context", `Missing data property at ${path}.${key}`, `${path}.${key}`);
  }
  return descriptor.value;
}

function strictRecord(value: unknown, path: string, allowed: ReadonlySet<string>): Record<string, unknown> {
  const object = assertObject(value, path);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      throw new BuildSpecResolutionError("invalid_context", `Unknown field "${key}" at ${path}`, `${path}.${key}`);
    }
  }
  return object;
}

function safeString(value: unknown, path: string): string {
  try {
    return assertString(value, path, true);
  } catch (error) {
    throw new BuildSpecResolutionError("invalid_context", error instanceof Error ? error.message : `Invalid string at ${path}`, path);
  }
}

function safeHex(value: unknown, path: string): string {
  try {
    return assertHex64(value, path);
  } catch (error) {
    throw new BuildSpecResolutionError("invalid_context", error instanceof Error ? error.message : `Invalid digest at ${path}`, path);
  }
}

function safeGeneration(value: unknown, path: string): number {
  try {
    return assertNonNegativeInt(value, path);
  } catch (error) {
    throw new BuildSpecResolutionError("invalid_context", error instanceof Error ? error.message : `Invalid generation at ${path}`, path);
  }
}

function parseStatus(value: unknown, path: string): FamilyStatus {
  const status = safeString(value, path);
  if (!FAMILY_STATUSES.includes(status as FamilyStatus)) {
    throw new BuildSpecResolutionError("invalid_context", `Unknown family status "${status}" at ${path}`, path);
  }
  return status as FamilyStatus;
}

function parseRegisteredRecord(value: unknown, path: string): BuildSpecRegisteredRecord {
  const object = strictRecord(value, path, RECORD_KEYS);
  return {
    binding_id: safeString(ownValue(object, "binding_id", path), `${path}.binding_id`),
    task_id: safeString(ownValue(object, "task_id", path), `${path}.task_id`),
    generation: safeGeneration(ownValue(object, "generation", path), `${path}.generation`),
    registered_ref: safeString(ownValue(object, "registered_ref", path), `${path}.registered_ref`),
    receipt_digest: safeHex(ownValue(object, "receipt_digest", path), `${path}.receipt_digest`),
  };
}

function parseContext(value: unknown): BuildSpecResolutionContext {
  const object = strictRecord(value, "$context", CONTEXT_KEYS);
  const familyObject = strictRecord(ownValue(object, "family", "$context"), "$context.family", FAMILY_KEYS);
  let familySpec: FamilySpec;
  try {
    familySpec = assertObject(ownValue(familyObject, "family_spec", "$context.family"), "$context.family.family_spec") as unknown as FamilySpec;
  } catch (error) {
    throw new BuildSpecResolutionError("invalid_context", error instanceof Error ? error.message : "Invalid family_spec", "$context.family.family_spec");
  }
  const assets = assertArray(
    ownValue(object, "assets", "$context"),
    "$context.assets",
    (item, index) => parseRegisteredRecord(item, `$context.assets[${index}]`),
  );
  const results = assertArray(
    ownValue(object, "results", "$context"),
    "$context.results",
    (item, index) => parseRegisteredRecord(item, `$context.results[${index}]`),
  );
  return {
    registry_generation: safeGeneration(ownValue(object, "registry_generation", "$context"), "$context.registry_generation"),
    registry_snapshot_digest: safeHex(ownValue(object, "registry_snapshot_digest", "$context"), "$context.registry_snapshot_digest"),
    family: {
      family_spec: familySpec,
      family_status: parseStatus(ownValue(familyObject, "family_status", "$context.family"), "$context.family.family_status"),
    },
    assets,
    results,
  };
}

function resolutionError(code: BuildSpecResolutionError["code"], message: string, path: string): never {
  throw new BuildSpecResolutionError(code, message, path);
}

function digest(value: JsonValue | DatasetBuildProposal2 | ResolvedDatasetBuildSpec2): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    return Promise.reject(new BuildSpecResolutionError("invalid_context", "Web Crypto is unavailable", "$crypto"));
  }
  const bytes = new TextEncoder().encode(stableStringify(value));
  return subtle.digest("SHA-256", bytes).then((buffer) =>
    Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join(""),
  );
}

function findUniqueRecord(
  records: readonly BuildSpecRegisteredRecord[],
  bindingId: string,
  label: "asset" | "result",
): BuildSpecRegisteredRecord | null {
  const matches = records.filter((record) => record.binding_id === bindingId);
  if (matches.length > 1) {
    resolutionError("duplicate_binding", `Duplicate ${label} binding "${bindingId}"`, `$.${label}s`);
  }
  return matches[0] ?? null;
}

function resolveBinding(
  binding: DatasetBuildProposal2["source_bindings"][number],
  context: BuildSpecResolutionContext,
): [ResolvedDatasetBuildSpec2["source_bindings"][number], string] {
  const asset = findUniqueRecord(context.assets, binding.binding_id, "asset");
  const result = findUniqueRecord(context.results, binding.binding_id, "result");
  if (asset && result) {
    resolutionError("ambiguous_binding", `Binding "${binding.binding_id}" matches both asset and result`, `$.source_bindings.${binding.binding_id}`);
  }
  const record = asset ?? result;
  if (!record) {
    resolutionError("unknown_binding", `No registered asset or result for binding "${binding.binding_id}"`, `$.source_bindings.${binding.binding_id}`);
  }
  if (record.task_id !== contextTaskId(context)) {
    resolutionError("cross_task_binding", `Binding "${binding.binding_id}" belongs to another task`, `$.source_bindings.${binding.binding_id}`);
  }
  if (record.generation !== context.registry_generation) {
    resolutionError("stale_generation", `Binding "${binding.binding_id}" is from generation ${record.generation}`, `$.source_bindings.${binding.binding_id}`);
  }
  if (context.family.family_spec.scope === "example") {
    resolutionError("example_execution_forbidden", "Example-scoped family specs cannot execute", "$.family.family_spec.scope");
  }
  return [
    {
      binding_id: binding.binding_id,
      source: binding.source,
      registered_asset_ref: asset ? record.registered_ref : null,
      registered_result_ref: result ? record.registered_ref : null,
      parameters: binding.parameters,
    },
    record.receipt_digest,
  ];
}

function contextTaskId(context: BuildSpecResolutionContext): string {
  const records = [...context.assets, ...context.results];
  const taskIds = new Set(records.map((record) => record.task_id));
  if (taskIds.size !== 1) {
    resolutionError("invalid_context", "Context records must identify exactly one task", "$.assets");
  }
  return [...taskIds][0] as string;
}

export async function resolveDatasetBuildProposal2(
  proposalInput: unknown,
  contextInput: unknown,
): Promise<BuildSpecResolution> {
  let proposal: DatasetBuildProposal2;
  try {
    proposal = parseDatasetBuildProposal2(proposalInput, "$proposal");
  } catch (error) {
    throw new BuildSpecResolutionError("invalid_context", error instanceof Error ? error.message : "Invalid proposal", "$proposal");
  }
  const context = parseContext(contextInput);
  if (context.family.family_status === "revoked") {
    resolutionError("family_revoked", "Family spec is revoked", "$.context.family.family_status");
  }
  if (context.family.family_status !== "activated") {
    resolutionError("family_not_activated", "Family spec is not activated", "$.context.family.family_status");
  }
  if (!(await verifyFamilySpecDigest(context.family.family_spec))) {
    resolutionError("family_spec_digest_mismatch", "Family spec digest does not match its canonical body", "$.context.family.family_spec.canonical_digest");
  }
  if (context.family.family_spec.canonical_digest !== proposal.family_spec_ref.digest) {
    resolutionError("family_spec_digest_mismatch", "Proposal family spec digest does not match the registry family spec", "$.proposal.family_spec_ref.digest");
  }
  const resolvedBindings: ResolvedDatasetBuildSpec2["source_bindings"] = [];
  const orderedReceiptRefs: string[] = [];
  for (const binding of proposal.source_bindings) {
    const [resolvedBinding, receiptDigest] = resolveBinding(binding, context);
    resolvedBindings.push(resolvedBinding);
    orderedReceiptRefs.push(receiptDigest);
  }
  const resolved = parseResolvedDatasetBuildSpec2({
    ...proposal,
    spec_kind: "resolved",
    source_bindings: resolvedBindings,
  }, "$resolved");
  const [proposalDigest, resolvedDigest] = await Promise.all([digest(proposal), digest(resolved)]);
  const evidence: BuildSpecResolutionEvidence = {
    proposal_digest: proposalDigest,
    resolved_digest: resolvedDigest,
    registry_snapshot_digest: context.registry_snapshot_digest,
    ordered_receipt_refs: orderedReceiptRefs,
  };
  return { resolved, evidence };
}

export const resolveBuildSpec2 = resolveDatasetBuildProposal2;
