/**
 * Deterministic operation digests (Python
 * ``app/datasets/runtime/executor.py``: ``_sha256_json``,
 * ``_compute_input_digest``, ``_compute_parameter_digest``).
 *
 * The reuse contract (ARCHITECTURE §5.2): a SUCCEEDED attempt is reused only
 * when input, parameter **and implementation version** digests all match, so
 * an upgraded adapter/parser never serves stale output and a changed source
 * file (sha256/size) invalidates every checkpoint.
 */

import { createHash } from "node:crypto";
import type { SourceAsset } from "../contracts/index.js";
import type { OperationSpec } from "./operations.js";

/**
 * Canonical JSON serialization matching Python ``json.dumps(
 * ensure_ascii=False, separators=(",", ":"), sort_keys=True)``: object keys
 * are sorted recursively and unicode is emitted as-is.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts = keys.map(
    (key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`,
  );
  return `{${parts.join(",")}}`;
}

/** sha256 over the canonical JSON of *payload* (Python ``_sha256_json``). */
export function sha256Json(payload: unknown): string {
  return createHash("sha256").update(stableStringify(payload), "utf8").digest("hex");
}

export interface DigestScope {
  buildId: string;
  /** Upstream operation outputs keyed by operation_id. */
  upstream: Readonly<Record<string, Record<string, unknown>>>;
  parameterScope: Readonly<Record<string, unknown>>;
  sourceAssets?: Readonly<Record<string, SourceAsset>>;
  mappingAssets?: Readonly<Record<string, SourceAsset>>;
  implementationVersions?: Readonly<Record<string, string>>;
}

/**
 * Input digest for one operation: build/operation identity, per-upstream
 * output digests, the parameter scope, and (when present) the source and
 * mapping asset closures.  Changing any of these invalidates every
 * checkpoint (digest closure).
 */
export function computeInputDigest(op: OperationSpec, scope: DigestScope): string {
  const payload: Record<string, unknown> = {
    build_id: scope.buildId,
    operation_id: op.operation_id,
    upstream: Object.fromEntries(
      Object.entries(scope.upstream).map(([operationId, value]) => [
        operationId,
        sha256Json(value),
      ]),
    ),
  };
  payload["parameter_scope"] = scope.parameterScope;
  if (scope.sourceAssets && Object.keys(scope.sourceAssets).length > 0) {
    payload["source_assets"] = Object.fromEntries(
      Object.entries(scope.sourceAssets)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([bindingId, asset]) => [
          bindingId,
          { sha256: asset.sha256, size_bytes: asset.size_bytes },
        ]),
    );
  }
  if (scope.mappingAssets && Object.keys(scope.mappingAssets).length > 0) {
    payload["mapping_assets"] = Object.fromEntries(
      Object.entries(scope.mappingAssets)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([bindingId, asset]) => [
          bindingId,
          { sha256: asset.sha256, size_bytes: asset.size_bytes },
        ]),
    );
  }
  return sha256Json(payload);
}

/**
 * Parameter digest: the implementation version is part of the reuse contract
 * (ARCHITECTURE §5.2), so an upgraded adapter/parser never serves stale
 * output under a matching parameter digest.
 */
export function computeParameterDigest(op: OperationSpec, scope: DigestScope): string {
  return sha256Json({
    build_id: scope.buildId,
    operation_id: op.operation_id,
    parameters: scope.parameterScope,
    implementation_version: scope.implementationVersions?.[op.operation_id] ?? null,
  });
}

/** Marker for a value Python serializes as a float (json.dumps emits 1.0). */
export interface PyFloat {
  readonly __pyFloat: number;
}

/** Wrap a number so ``pythonJsonDumps`` emits Python float form (``1.0``). */
export function pyFloat(value: number): PyFloat {
  return { __pyFloat: value };
}

/**
 * Python ``json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True)``
 * equivalent: object keys sorted recursively, 2-space indentation, unicode
 * preserved.  ``PyFloat`` markers emit Python float repr (``1.0``).
 */
export function pythonJsonDumps(value: unknown, indentLevel = 2): string {
  const format = (item: unknown, level: number): string => {
    if (isPyFloat(item)) return pythonFloatStr(item.__pyFloat);
    if (item === null) return "null";
    if (typeof item === "string") return JSON.stringify(item);
    if (typeof item === "number") {
      return Number.isInteger(item) ? String(item) : String(item);
    }
    if (typeof item === "boolean") return item ? "true" : "false";
    if (Array.isArray(item)) {
      if (item.length === 0) return "[]";
      const inner = " ".repeat(indentLevel * (level + 1));
      const closing = " ".repeat(indentLevel * level);
      return (
        "[\n" +
        item
          .map((entry) => `${inner}${format(entry, level + 1)}`)
          .join(",\n") +
        `\n${closing}]`
      );
    }
    const record = item as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.length === 0) return "{}";
    const inner = " ".repeat(indentLevel * (level + 1));
    const closing = " ".repeat(indentLevel * level);
    return (
      "{\n" +
      keys
        .map((key) => `${inner}${JSON.stringify(key)}: ${format(record[key], level + 1)}`)
        .join(",\n") +
      `\n${closing}}`
    );
  };
  return format(value, 0);
}

function isPyFloat(value: unknown): value is PyFloat {
  return (
    typeof value === "object" &&
    value !== null &&
    "__pyFloat" in value &&
    typeof (value as PyFloat).__pyFloat === "number"
  );
}

/** Python ``repr`` of a float (``1.0``, ``0.5``, ``1e+21``). */
function pythonFloatStr(value: number): string {
  const text = String(value);
  return Number.isInteger(value) ? `${text}.0` : text;
}