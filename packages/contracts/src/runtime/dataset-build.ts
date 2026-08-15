/**
 * Dataset build wire parsers (``BuildResult`` and friends).
 *
 * Single shared implementation of the ``BuildResult`` wire parser — this used
 * to be copy-pasted on the frontend (``apiResponseParsers.ts``,
 * ``eventParsersPipeline.ts``, ``eventParsersRuntime.ts``). All consumers now
 * import ``parseBuildResult`` from here.
 *
 * NOTE: the deterministic Dataset Core additionally validates ``BuildResult``
 * as a domain object (``extra="forbid"`` exact keys, cross-field invariants,
 * ``TypeError`` semantics) in ``server/src/dataset/contracts/result.ts``.
 * That stricter layer is intentionally separate — this module is the
 * lenient wire-boundary parser shared by both sides of the HTTP contract.
 */

import type { BindingFailureDetail, BuildResult, BuildResultStatus } from "../dataset-build.js";
import { APIError } from "./errors.js";
import {
  assertArray,
  assertNonNegativeInt,
  assertObject,
  assertOptionalNull,
  assertString,
  assertStringOrNull,
} from "./primitives.js";

export function assertBuildResultStatus(v: unknown, path: string): BuildResultStatus {
  if (typeof v !== "string") throw new APIError(502, `Expected BuildResultStatus string at ${path}, got ${typeof v}`);
  switch (v) {
    case "succeeded":
    case "partial_success":
    case "no_data":
    case "spec_rejected":
      return v;
    default:
      throw new APIError(502, `Invalid BuildResultStatus "${v}" at ${path}`);
  }
}

export function parseBuildResult(json: unknown, path: string): BuildResult {
  const obj = assertObject(json, path);
  return {
    status: assertBuildResultStatus(Reflect.get(obj, "status"), `${path}.status`),
    valid_row_count: assertNonNegativeInt(Reflect.get(obj, "valid_row_count"), `${path}.valid_row_count`),
    successful_sources: assertArray(Reflect.get(obj, "successful_sources"), `${path}.successful_sources`, (value, index) => assertString(value, `${path}.successful_sources[${index}]`)),
    rejected_sources: assertArray(Reflect.get(obj, "rejected_sources"), `${path}.rejected_sources`, (value, index) => assertString(value, `${path}.rejected_sources[${index}]`)),
    available_artifact_roles: assertArray(Reflect.get(obj, "available_artifact_roles"), `${path}.available_artifact_roles`, (value, index) => assertString(value, `${path}.available_artifact_roles[${index}]`)),
    publication_id: assertStringOrNull(Reflect.get(obj, "publication_id"), `${path}.publication_id`),
    reason_codes: assertArray(Reflect.get(obj, "reason_codes"), `${path}.reason_codes`, (value, index) => assertString(value, `${path}.reason_codes[${index}]`)),
    user_summary: assertString(Reflect.get(obj, "user_summary"), `${path}.user_summary`),
    recommended_next_action: assertString(Reflect.get(obj, "recommended_next_action"), `${path}.recommended_next_action`),
    build_id: assertOptionalNull(Reflect.get(obj, "build_id"), `${path}.build_id`, (value, p) => assertString(value, p, true)),
    binding_failures: parseBindingFailures(Reflect.get(obj, "binding_failures"), `${path}.binding_failures`),
  };
}

function parseBindingFailures(value: unknown, path: string): BindingFailureDetail[] {
  if (value === undefined || value === null) return [];
  return assertArray(value, path, (entry, index) => {
    const obj = assertObject(entry, `${path}[${index}]`);
    return {
      binding_id: assertString(Reflect.get(obj, "binding_id"), `${path}[${index}].binding_id`, true),
      reason_code: assertString(Reflect.get(obj, "reason_code"), `${path}[${index}].reason_code`, true),
      message: assertString(Reflect.get(obj, "message"), `${path}[${index}].message`),
    };
  });
}
