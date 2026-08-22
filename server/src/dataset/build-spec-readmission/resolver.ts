import {
  assertArray,
  assertHex64,
  assertJsonValue,
  assertNonNegativeInt,
  assertObject,
  assertString,
  parseFamilySpec,
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
  type BuildSpecCapabilityRecord,
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
  "task_id",
  "build_id",
  "registry_generation",
  "registry_snapshot_digest",
  "family",
  "transforms",
  "policies",
  "assets",
  "results",
]);
const FAMILY_KEYS = new Set(["family_spec", "family_status"]);
const CAPABILITY_KEYS = new Set(["kind", "scope", "id", "version", "digest", "status"]);
const RECORD_KEYS = new Set([
  "binding_id",
  "source",
  "input_requirement_ref",
  "task_id",
  "build_id",
  "generation",
  "registered_ref",
  "receipt_digest",
]);

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

function parseCapability(value: unknown, path: string): BuildSpecCapabilityRecord {
  const object = strictRecord(value, path, CAPABILITY_KEYS);
  const kind = safeString(ownValue(object, "kind", path), `${path}.kind`);
  if (kind !== "dataset_transform" && kind !== "policy") {
    throw new BuildSpecResolutionError("invalid_context", `Unsupported capability kind at ${path}`, path);
  }
  const scope = safeString(ownValue(object, "scope", path), `${path}.scope`);
  if (!["example", "task", "user", "curated", "system"].includes(scope)) {
    throw new BuildSpecResolutionError("invalid_context", `Unsupported capability scope at ${path}`, path);
  }
  return {
    kind,
    scope: scope as BuildSpecCapabilityRecord["scope"],
    id: safeString(ownValue(object, "id", path), `${path}.id`),
    version: safeString(ownValue(object, "version", path), `${path}.version`),
    digest: safeHex(ownValue(object, "digest", path), `${path}.digest`),
    status: parseStatus(ownValue(object, "status", path), `${path}.status`),
  };
}

function parseRegisteredRecord(value: unknown, path: string): BuildSpecRegisteredRecord {
  const object = strictRecord(value, path, RECORD_KEYS);
  return {
    binding_id: safeString(ownValue(object, "binding_id", path), `${path}.binding_id`),
    source: safeString(ownValue(object, "source", path), `${path}.source`),
    input_requirement_ref: safeString(ownValue(object, "input_requirement_ref", path), `${path}.input_requirement_ref`),
    task_id: ownValue(object, "task_id", path) === null
      ? null
      : safeString(ownValue(object, "task_id", path), `${path}.task_id`),
    build_id: ownValue(object, "build_id", path) === null
      ? null
      : safeString(ownValue(object, "build_id", path), `${path}.build_id`),
    generation: safeGeneration(ownValue(object, "generation", path), `${path}.generation`),
    registered_ref: safeString(ownValue(object, "registered_ref", path), `${path}.registered_ref`),
    receipt_digest: safeHex(ownValue(object, "receipt_digest", path), `${path}.receipt_digest`),
  };
}

function parseContext(value: unknown): BuildSpecResolutionContext {
  const object = strictRecord(assertJsonValue(value, "$context"), "$context", CONTEXT_KEYS);
  const familyObject = strictRecord(ownValue(object, "family", "$context"), "$context.family", FAMILY_KEYS);
  let familySpec: FamilySpec;
  try {
    familySpec = parseFamilySpec(
      ownValue(familyObject, "family_spec", "$context.family"),
      "$context.family.family_spec",
    );
  } catch (error) {
    throw new BuildSpecResolutionError("invalid_context", error instanceof Error ? error.message : "Invalid family_spec", "$context.family.family_spec");
  }
  const transforms = assertArray(
    ownValue(object, "transforms", "$context"),
    "$context.transforms",
    (item, index) => parseCapability(item, `$context.transforms[${index}]`),
  );
  const policies = assertArray(
    ownValue(object, "policies", "$context"),
    "$context.policies",
    (item, index) => parseCapability(item, `$context.policies[${index}]`),
  );
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
    task_id: safeString(ownValue(object, "task_id", "$context"), "$context.task_id"),
    build_id: safeString(ownValue(object, "build_id", "$context"), "$context.build_id"),
    registry_generation: safeGeneration(ownValue(object, "registry_generation", "$context"), "$context.registry_generation"),
    registry_snapshot_digest: safeHex(ownValue(object, "registry_snapshot_digest", "$context"), "$context.registry_snapshot_digest"),
    family: {
      family_spec: familySpec,
      family_status: parseStatus(ownValue(familyObject, "family_status", "$context.family"), "$context.family.family_status"),
    },
    transforms,
    policies,
    assets,
    results,
  };
}

function resolutionError(code: BuildSpecResolutionError["code"], message: string, path: string): never {
  throw new BuildSpecResolutionError(code, message, path);
}

function resolveCapabilityRefs(
  refs: readonly { scope: string; id: string; version: string; digest: string }[],
  records: readonly BuildSpecCapabilityRecord[],
  kind: BuildSpecCapabilityRecord["kind"],
): string[] {
  return refs.map((ref) => {
    const matches = records.filter((record) =>
      record.kind === kind
      && record.scope === ref.scope
      && record.id === ref.id
      && record.version === ref.version
      && record.digest === ref.digest,
    );
    if (matches.length === 0) {
      resolutionError("unknown_capability", `No exact ${kind} capability for ${ref.id}@${ref.version}`, `$.${kind}s`);
    }
    if (matches.length > 1) {
      resolutionError("capability_ambiguous", `Multiple exact ${kind} capabilities for ${ref.id}@${ref.version}`, `$.${kind}s`);
    }
    const capability = matches[0]!;
    if (capability.scope === "example") {
      resolutionError("example_execution_forbidden", `Example ${kind} cannot execute`, `$.${kind}s`);
    }
    if (capability.status === "revoked" || capability.status === "retired") {
      resolutionError("family_revoked", `${kind} capability is revoked or retired`, `$.${kind}s`);
    }
    if (capability.status !== "activated") {
      resolutionError("capability_not_activated", `${kind} capability is not activated`, `$.${kind}s`);
    }
    return `${capability.scope}:${capability.id}:${capability.version}:${capability.digest}`;
  });
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
  binding: DatasetBuildProposal2["source_bindings"][number],
  label: "asset" | "result",
): BuildSpecRegisteredRecord | null {
  const matches = records.filter((record) =>
    record.binding_id === binding.binding_id
    && record.source === binding.source
    && record.input_requirement_ref === binding.input_requirement_ref,
  );
  if (matches.length > 1) {
    resolutionError(
      "duplicate_binding",
      `Duplicate ${label} binding "${binding.binding_id}"`,
      `$.${label}s`,
    );
  }
  return matches[0] ?? null;
}

function resolveBinding(
  binding: DatasetBuildProposal2["source_bindings"][number],
  context: BuildSpecResolutionContext,
): [ResolvedDatasetBuildSpec2["source_bindings"][number], string] {
  const asset = findUniqueRecord(context.assets, binding, "asset");
  const result = findUniqueRecord(context.results, binding, "result");
  if (asset && result) {
    resolutionError("ambiguous_binding", `Binding "${binding.binding_id}" matches both asset and result`, `$.source_bindings.${binding.binding_id}`);
  }
  const record = asset ?? result;
  if (!record) {
    resolutionError("unknown_binding", `No registered asset or result for binding "${binding.binding_id}"`, `$.source_bindings.${binding.binding_id}`);
  }
  if (record.task_id !== null && record.task_id !== context.task_id) {
    resolutionError("cross_task_binding", `Binding "${binding.binding_id}" belongs to another task`, `$.source_bindings.${binding.binding_id}`);
  }
  if (record.build_id !== null && record.build_id !== context.build_id) {
    resolutionError("build_mismatch", `Binding "${binding.binding_id}" belongs to another build`, `$.source_bindings.${binding.binding_id}`);
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

export async function resolveDatasetBuildProposal2(
  proposalInput: unknown,
  contextInput: unknown,
): Promise<BuildSpecResolution> {
  let proposal: DatasetBuildProposal2;
  try {
    proposal = parseDatasetBuildProposal2(proposalInput, "$proposal");
  } catch (error) {
    throw new BuildSpecResolutionError("invalid_proposal", error instanceof Error ? error.message : "Invalid proposal", "$proposal");
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
  const familySpec = context.family.family_spec;
  if (
    proposal.family_spec_ref.scope !== familySpec.scope
    || proposal.family_spec_ref.id !== familySpec.family_spec_id
    || proposal.family_spec_ref.version !== familySpec.semantic_version
    || proposal.family_spec_ref.digest !== familySpec.canonical_digest
  ) {
    resolutionError("family_spec_digest_mismatch", "Proposal family spec reference does not exactly match the verified registry family", "$.proposal.family_spec_ref");
  }
  const orderedCapabilityRefs = [
    ...resolveCapabilityRefs(proposal.transform_refs, context.transforms, "dataset_transform"),
    ...resolveCapabilityRefs(proposal.policy_refs, context.policies, "policy"),
  ];
  if (context.family.family_spec.scope === "example") {
    resolutionError("example_execution_forbidden", "Example-scoped family specs cannot execute", "$.context.family.family_spec.scope");
  }
  const resolvedBindings: ResolvedDatasetBuildSpec2["source_bindings"] = [];
  if (proposal.build_id !== context.build_id) {
    resolutionError("build_mismatch", "Proposal build_id does not match the Core resolution context", "$.proposal.build_id");
  }
  const orderedReceiptDigests: string[] = [];
  for (const binding of proposal.source_bindings) {
    const [resolvedBinding, receiptDigest] = resolveBinding(binding, context);
    resolvedBindings.push(resolvedBinding);
    orderedReceiptDigests.push(receiptDigest);
  }
  const resolved = parseResolvedDatasetBuildSpec2({
    ...proposal,
    spec_kind: "resolved",
    source_bindings: resolvedBindings,
  }, "$resolved");
  const [proposalDigest, resolvedDigest] = await Promise.all([digest(proposal), digest(resolved)]);
  const evidence: BuildSpecResolutionEvidence = {
    task_id: context.task_id,
    build_id: context.build_id,
    registry_generation: context.registry_generation,
    proposal_digest: proposalDigest,
    resolved_digest: resolvedDigest,
    registry_snapshot_digest: context.registry_snapshot_digest,
    ordered_receipt_digests: orderedReceiptDigests,
    ordered_capability_refs: orderedCapabilityRefs,
  };
  return { resolved, evidence };
}

export const resolveBuildSpec2 = resolveDatasetBuildProposal2;
