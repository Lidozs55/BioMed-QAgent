import type { JsonValue } from "./json.js";
import { APIError } from "./runtime/errors.js";
import {
  assertArray,
  assertHex64,
  assertJsonValue,
  assertObject,
  assertString,
} from "./runtime/primitives.js";

export type CoreDerivedAssetOperationKind =
  | "archive_member_extraction"
  | "vlm_extraction"
  | "registered_parser";

export interface CoreDerivedAssetProvenance {
  schema_version: "1.0";
  task_id: string;
  asset_id: string;
  parent_asset_ids: string[];
  operation_kind: CoreDerivedAssetOperationKind;
  operation_result_id: string;
  implementation_id: string;
  implementation_version: string;
  parameters_digest: string;
  output_digest: string;
  evidence: JsonValue;
  created_at: string;
}

const KEYS = new Set([
  "schema_version", "task_id", "asset_id", "parent_asset_ids", "operation_kind",
  "operation_result_id", "implementation_id", "implementation_version",
  "parameters_digest", "output_digest", "evidence", "created_at",
]);
const KINDS = new Set<CoreDerivedAssetOperationKind>([
  "archive_member_extraction", "vlm_extraction", "registered_parser",
]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const ASSET_ID = /^asset_[0-9a-f]{64}$/u;

function safeId(value: unknown, path: string): string {
  const result = assertString(value, path, true);
  if (!SAFE_ID.test(result)) throw new APIError(502, `Invalid safe identifier at ${path}`);
  return result;
}

function assetId(value: unknown, path: string): string {
  const result = assertString(value, path, true);
  if (!ASSET_ID.test(result)) throw new APIError(502, `Invalid asset identifier at ${path}`);
  return result;
}

export function parseCoreDerivedAssetProvenance(
  value: unknown,
  path = "$derived_asset_provenance",
): CoreDerivedAssetProvenance {
  const object = assertObject(value, path);
  const keys = Object.keys(object);
  if (keys.length !== KEYS.size || keys.some((key) => !KEYS.has(key))) {
    throw new APIError(502, `Unknown or missing fields at ${path}`);
  }
  if (object.schema_version !== "1.0") {
    throw new APIError(502, `Unsupported schema_version at ${path}.schema_version`);
  }
  const kind = assertString(object.operation_kind, `${path}.operation_kind`, true);
  if (!KINDS.has(kind as CoreDerivedAssetOperationKind)) {
    throw new APIError(502, `Unsupported operation kind at ${path}.operation_kind`);
  }
  const parents = assertArray(
    object.parent_asset_ids,
    `${path}.parent_asset_ids`,
    (item, index) => assetId(item, `${path}.parent_asset_ids[${index}]`),
  );
  if (parents.length === 0 || new Set(parents).size !== parents.length) {
    throw new APIError(502, `parent_asset_ids must be a non-empty unique array at ${path}`);
  }
  const outputDigest = assertHex64(object.output_digest, `${path}.output_digest`);
  const outputAssetId = assetId(object.asset_id, `${path}.asset_id`);
  if (outputAssetId !== `asset_${outputDigest}`) {
    throw new APIError(502, `asset_id must bind output_digest at ${path}`);
  }
  const createdAt = assertString(object.created_at, `${path}.created_at`, true);
  if (Number.isNaN(Date.parse(createdAt))) {
    throw new APIError(502, `created_at must be ISO 8601 at ${path}.created_at`);
  }
  return {
    schema_version: "1.0",
    task_id: safeId(object.task_id, `${path}.task_id`),
    asset_id: outputAssetId,
    parent_asset_ids: parents,
    operation_kind: kind as CoreDerivedAssetOperationKind,
    operation_result_id: safeId(object.operation_result_id, `${path}.operation_result_id`),
    implementation_id: safeId(object.implementation_id, `${path}.implementation_id`),
    implementation_version: safeId(object.implementation_version, `${path}.implementation_version`),
    parameters_digest: assertHex64(object.parameters_digest, `${path}.parameters_digest`),
    output_digest: outputDigest,
    evidence: assertJsonValue(object.evidence, `${path}.evidence`),
    created_at: createdAt,
  };
}
