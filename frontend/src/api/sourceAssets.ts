/**
 * Read-only source-asset listing client (``GET /api/v1/tasks/:id/source-assets``).
 *
 * Strict parser for the Assets-panel projection of task-owned
 * SourceAssetRegistrationReceipts. Rejects unknown/missing fields and
 * malformed identifiers/hashes/roles/sizes; never coerces. Listing is
 * read-only — it neither mutates task state nor returns file bytes.
 */
import { APIError } from "@/api/errors";
import type { Http } from "@/api/http";
import {
  assertArray,
  assertHex64,
  assertNonNegativeInt,
  assertObject,
  assertString,
} from "@biomed/contracts";

/** Wire shape mirrors @biomed/contracts SourceAssetRegistrationReceipt. */
export interface RegisteredSourceAssetRef {
  schema_version: "1.0";
  asset_id: string;
  task_id: string;
  role: RegisteredSourceAssetRole;
}

export interface SourceAssetPathCompatibility {
  schema_version: "1.0";
  mode: SourceAssetReferenceMode;
  legacy_path: string | null;
  telemetry_event: SourceAssetReferenceTelemetry;
}

export interface SourceAssetRegistrationReceipt {
  schema_version: "1.0";
  receipt_id: string;
  task_id: string;
  asset_ref: RegisteredSourceAssetRef;
  source_id: string;
  relative_path: string;
  sha256: string;
  size_bytes: number;
  media_type: string;
  registered_at: string;
  path_compatibility: SourceAssetPathCompatibility;
}

export interface SourceAssetListPage {
  items: SourceAssetRegistrationReceipt[];
}

export type RegisteredSourceAssetRole = "source" | "mapping" | "metadata" | "carrier";
export type SourceAssetReferenceMode = "asset_id" | "legacy_task_path";
export type SourceAssetReferenceTelemetry =
  | "asset_ref_used"
  | "legacy_path_compatibility_used";

const RECEIPT_KEYS = [
  "schema_version", "receipt_id", "task_id", "asset_ref", "source_id",
  "relative_path", "sha256", "size_bytes", "media_type", "registered_at",
  "path_compatibility",
];
const REF_KEYS = ["schema_version", "asset_id", "task_id", "role"];
const COMPAT_KEYS = ["schema_version", "mode", "legacy_path", "telemetry_event"];
const ROLES: ReadonlySet<string> = new Set(["source", "mapping", "metadata", "carrier"]);
const MODES: ReadonlySet<string> = new Set(["asset_id", "legacy_task_path"]);
const TELEMETRY: ReadonlySet<string> = new Set(["asset_ref_used", "legacy_path_compatibility_used"]);
const RECEIPT_ID = /^receipt_[0-9a-f-]{36}$/;
const ASSET_ID = /^asset_[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SOURCE_ASSETS_PREFIX = "source_assets/";

function requireKeys(obj: Record<string, unknown>, keys: string[], path: string): void {
  for (const key of keys) {
    if (!(key in obj)) throw new APIError(502, `Missing field at ${path}.${key}`);
  }
  for (const key of Object.keys(obj)) {
    if (!keys.includes(key)) throw new APIError(502, `Unknown field at ${path}.${key}`);
  }
}

function parseRole(value: unknown, path: string): RegisteredSourceAssetRole {
  const role = assertString(value, path, true);
  if (!ROLES.has(role)) throw new APIError(502, `Invalid role at ${path}`);
  return role as RegisteredSourceAssetRole;
}

function parseRef(value: unknown, path: string, expectedTaskId: string): RegisteredSourceAssetRef {
  const obj = assertObject(value, path);
  requireKeys(obj, REF_KEYS, path);
  if (obj.schema_version !== "1.0") {
    throw new APIError(502, `Unsupported schema_version at ${path}.schema_version`);
  }
  const assetId = assertString(obj.asset_id, `${path}.asset_id`, true);
  if (!ASSET_ID.test(assetId)) throw new APIError(502, `Malformed asset_id at ${path}.asset_id`);
  const taskId = assertString(obj.task_id, `${path}.task_id`, true);
  if (!SAFE_ID.test(taskId)) throw new APIError(502, `Malformed task_id at ${path}.task_id`);
  if (taskId !== expectedTaskId) {
    throw new APIError(502, `asset_ref belongs to another task at ${path}`);
  }
  return {
    schema_version: "1.0",
    asset_id: assetId,
    task_id: taskId,
    role: parseRole(obj.role, `${path}.role`),
  };
}

function parsePathCompatibility(
  value: unknown,
  path: string,
): SourceAssetPathCompatibility {
  const obj = assertObject(value, path);
  requireKeys(obj, COMPAT_KEYS, path);
  if (obj.schema_version !== "1.0") {
    throw new APIError(502, `Unsupported schema_version at ${path}.schema_version`);
  }
  const mode = assertString(obj.mode, `${path}.mode`, true);
  if (!MODES.has(mode)) throw new APIError(502, `Invalid mode at ${path}.mode`);
  const telemetry = assertString(obj.telemetry_event, `${path}.telemetry_event`, true);
  if (!TELEMETRY.has(telemetry)) {
    throw new APIError(502, `Invalid telemetry_event at ${path}.telemetry_event`);
  }
  if (mode === "asset_id") {
    if (obj.legacy_path !== null) {
      throw new APIError(502, `asset_id mode requires a null legacy_path at ${path}.legacy_path`);
    }
    return {
      schema_version: "1.0",
      mode: "asset_id",
      legacy_path: null,
      telemetry_event: "asset_ref_used",
    };
  }
  const legacyPath = assertString(obj.legacy_path, `${path}.legacy_path`, true);
  if (!legacyPath.startsWith(SOURCE_ASSETS_PREFIX)) {
    throw new APIError(502, `legacy_path must stay in source_assets at ${path}.legacy_path`);
  }
  return {
    schema_version: "1.0",
    mode: "legacy_task_path",
    legacy_path: legacyPath,
    telemetry_event: "legacy_path_compatibility_used",
  };
}

function parseRelativePath(value: unknown, path: string): string {
  const relativePath = assertString(value, path, true);
  if (relativePath.includes("\\") || relativePath.startsWith("/")) {
    throw new APIError(502, `relative_path must be POSIX-relative at ${path}`);
  }
  const parts = relativePath.split("/");
  if (parts[0] !== "source_assets") {
    throw new APIError(502, `relative_path must stay in source_assets at ${path}`);
  }
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new APIError(502, `relative_path escapes source_assets at ${path}`);
  }
  return relativePath;
}

/** Strict SourceAssetRegistrationReceipt parser bound to the listed task. */
export function parseSourceAssetRegistrationReceipt(
  value: unknown,
  path: string,
  expectedTaskId: string,
): SourceAssetRegistrationReceipt {
  const obj = assertObject(value, path);
  requireKeys(obj, RECEIPT_KEYS, path);
  if (obj.schema_version !== "1.0") {
    throw new APIError(502, `Unsupported schema_version at ${path}.schema_version`);
  }
  const receiptId = assertString(obj.receipt_id, `${path}.receipt_id`, true);
  if (!RECEIPT_ID.test(receiptId)) {
    throw new APIError(502, `Malformed receipt_id at ${path}.receipt_id`);
  }
  const taskId = assertString(obj.task_id, `${path}.task_id`, true);
  if (!SAFE_ID.test(taskId) || taskId !== expectedTaskId) {
    throw new APIError(502, `Receipt belongs to another task at ${path}.task_id`);
  }
  const sha256 = assertHex64(obj.sha256, `${path}.sha256`);
  const assetRef = parseRef(obj.asset_ref, `${path}.asset_ref`, taskId);
  if (assetRef.asset_id !== `asset_${sha256}`) {
    throw new APIError(502, `asset_id does not bind sha256 at ${path}.asset_ref.asset_id`);
  }
  return {
    schema_version: "1.0",
    receipt_id: receiptId,
    task_id: taskId,
    asset_ref: assetRef,
    source_id: (() => {
      const sourceId = assertString(obj.source_id, `${path}.source_id`, true);
      if (!SAFE_ID.test(sourceId)) {
        throw new APIError(502, `Malformed source_id at ${path}.source_id`);
      }
      return sourceId;
    })(),
    relative_path: parseRelativePath(obj.relative_path, `${path}.relative_path`),
    sha256,
    size_bytes: assertNonNegativeInt(obj.size_bytes, `${path}.size_bytes`),
    media_type: assertString(obj.media_type, `${path}.media_type`, true),
    registered_at: assertString(obj.registered_at, `${path}.registered_at`, true),
    path_compatibility: parsePathCompatibility(
      obj.path_compatibility,
      `${path}.path_compatibility`,
    ),
  };
}

export function parseSourceAssetListPage(
  json: unknown,
  expectedTaskId: string,
): SourceAssetListPage {
  const obj = assertObject(json, "source-assets response");
  requireKeys(obj, ["items"], "source-assets response");
  const items = assertArray(
    obj.items,
    "source-assets response.items",
    (item, index) =>
      parseSourceAssetRegistrationReceipt(
        item,
        `source-assets response.items[${index}]`,
        expectedTaskId,
      ),
  );
  return { items };
}

export interface SourceAssetsApi {
  fetchSourceAssets: (taskId: string) => Promise<SourceAssetRegistrationReceipt[]>;
}

export function createSourceAssetsApi(http: Http): SourceAssetsApi {
  return {
    fetchSourceAssets: (taskId) => {
      const url = `${http.baseUrl}/tasks/${http.encodeId(taskId)}/source-assets`;
      return http.request(url).then((body) => parseSourceAssetListPage(body, taskId).items);
    },
  };
}
