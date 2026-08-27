import { types } from "node:util";

import { canonicalDigest } from "../adapters/identity.js";

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const INPUT_KEYS = new Set([
  "slotId", "taskId", "requirementId", "generation", "expectedGeneration",
  "capability", "familySpecDigest", "projectionDigest", "policyDigests",
  "inputAssetIds", "upstreamResultManifestIds", "deadline", "cancelFence",
]);
const CAPABILITY_KEYS = new Set(["scope", "id", "version", "digest", "status"]);
const REGISTERED_SLOT_IDS = new Set(["family_transform.fixed.v1"]);
const ALLOWED_SCOPES = new Set(["task", "user", "curated", "system"]);

export interface FixedTransformCapability {
  readonly scope: "example" | "task" | "user" | "curated" | "system";
  readonly id: string;
  readonly version: string;
  readonly digest: string;
  readonly status: "submitted" | "sandbox_executable" | "fixture_verified" | "shadow_verified" | "trusted_e2e_verified" | "activated" | "revoked" | "retired";
}

export interface FixedTransformSlotInput {
  readonly slotId: string;
  readonly taskId: string;
  readonly requirementId: string;
  readonly generation: number;
  readonly expectedGeneration: number;
  readonly capability: FixedTransformCapability;
  readonly familySpecDigest: string;
  readonly projectionDigest: string;
  readonly policyDigests: readonly string[];
  readonly inputAssetIds: readonly string[];
  readonly upstreamResultManifestIds: readonly string[];
  readonly deadline: string;
  readonly cancelFence: string;
}

export interface TransformSlotDecision {
  readonly decisionKind: "fixed_transform_slot.v1";
  readonly slotId: string;
  readonly taskId: string;
  readonly requirementId: string;
  readonly generation: number;
  readonly capabilityRef: string;
  readonly familySpecDigest: string;
  readonly projectionDigest: string;
  readonly policyDigests: readonly string[];
  readonly inputAssetIds: readonly string[];
  readonly upstreamResultManifestIds: readonly string[];
  readonly deadline: string;
  readonly cancelFence: string;
  readonly decisionDigest: string;
  readonly executable: false;
  readonly runtimeWired: false;
}

type DataRecord = Record<string, unknown>;

function record(value: unknown, keys: ReadonlySet<string>, label: string): DataRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value) || types.isProxy(value) || !Object.isFrozen(value)) {
    throw new TypeError(`${label} must be a frozen plain non-Proxy object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must have a plain prototype`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.length !== keys.size || ownKeys.some((key) => typeof key !== "string" || !keys.has(key))) {
    throw new TypeError(`${label} has unknown or missing fields`);
  }
  const result: DataRecord = Object.create(null) as DataRecord;
  for (const key of ownKeys) {
    const descriptor = descriptors[key as string];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${label}.${String(key)} must be an enumerable data property`);
    }
    result[key as string] = descriptor.value;
  }
  return result;
}

function id(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new TypeError(`${label} must be a safe identifier`);
  return value;
}
function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new TypeError(`${label} must be a lowercase sha256`);
  return value;
}
function generation(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative safe integer`);
  return value;
}
function frozenStrings(value: unknown, label: string, parser: (item: unknown, label: string) => string): string[] {
  if (!Array.isArray(value) || !Object.isFrozen(value)) throw new TypeError(`${label} must be a frozen array`);
  const parsed = value.map((item, index) => parser(item, `${label}[${index}]`));
  if (new Set(parsed).size !== parsed.length) throw new TypeError(`${label} must not contain duplicates`);
  return parsed;
}

export function admitFixedTransformSlot(input: FixedTransformSlotInput): TransformSlotDecision {
  const source = record(input, INPUT_KEYS, "slot input");
  const slotId = id(source.slotId, "slotId");
  if (!REGISTERED_SLOT_IDS.has(slotId)) throw new TypeError("slotId is not server-registered");
  const taskId = id(source.taskId, "taskId");
  const requirementId = id(source.requirementId, "requirementId");
  const currentGeneration = generation(source.generation, "generation");
  const expectedGeneration = generation(source.expectedGeneration, "expectedGeneration");
  if (currentGeneration !== expectedGeneration) throw new TypeError("slot generation is stale or from the future");
  const capability = record(source.capability, CAPABILITY_KEYS, "capability");
  const scope = capability.scope;
  if (typeof scope !== "string" || !ALLOWED_SCOPES.has(scope)) throw new TypeError("capability scope is not executable");
  const status = capability.status;
  if (status !== "activated") throw new TypeError("capability is not activated");
  const capabilityId = id(capability.id, "capability.id");
  const capabilityVersion = id(capability.version, "capability.version");
  const capabilityDigest = digest(capability.digest, "capability.digest");
  const familySpecDigest = digest(source.familySpecDigest, "familySpecDigest");
  const projectionDigest = digest(source.projectionDigest, "projectionDigest");
  const policyDigests = frozenStrings(source.policyDigests, "policyDigests", digest);
  const inputAssetIds = frozenStrings(source.inputAssetIds, "inputAssetIds", id);
  if (inputAssetIds.some((value) => !/^asset_[0-9a-f]{64}$/.test(value))) throw new TypeError("inputAssetIds must be content-addressed assets");
  const upstreamResultManifestIds = frozenStrings(source.upstreamResultManifestIds, "upstreamResultManifestIds", id);
  const deadline = typeof source.deadline === "string" && Number.isFinite(Date.parse(source.deadline))
    ? source.deadline : (() => { throw new TypeError("deadline must be an ISO timestamp"); })();
  const cancelFence = id(source.cancelFence, "cancelFence");
  const capabilityRef = `${scope}:${capabilityId}:${capabilityVersion}:${capabilityDigest}`;
  const decisionBody = {
    slot_id: slotId, task_id: taskId, requirement_id: requirementId, generation: currentGeneration,
    capability_ref: capabilityRef, family_spec_digest: familySpecDigest,
    projection_digest: projectionDigest, policy_digests: policyDigests,
    input_asset_ids: inputAssetIds, upstream_result_manifest_ids: upstreamResultManifestIds,
    deadline, cancel_fence: cancelFence,
  };
  return Object.freeze({
    decisionKind: "fixed_transform_slot.v1",
    slotId, taskId, requirementId, generation: currentGeneration, capabilityRef,
    familySpecDigest, projectionDigest,
    policyDigests: Object.freeze(policyDigests),
    inputAssetIds: Object.freeze(inputAssetIds),
    upstreamResultManifestIds: Object.freeze(upstreamResultManifestIds),
    deadline, cancelFence,
    decisionDigest: canonicalDigest(decisionBody),
    executable: false,
    runtimeWired: false,
  });
}
