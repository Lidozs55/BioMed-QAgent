import { APIError } from "@/hooks/settingsContracts";
import type { EventPayload, JsonValue } from "@/runtime/contracts";
import { assertString, assertNumber, assertBoolean, assertObject, assertFinite, assertOptionalNull, assertHex64, assertPositiveInt, assertNonNegativeInt, assertOptionalNonNegativeInt, assertJsonRecord } from "./eventValidatorHelpers";

const STAGE_NAMES = ["discovery", "acquisition", "processing", "artifact_build", "validation"] as const;
const PROMPT_KINDS = ["plan_confirmation", "data_correction", "max_turns_reached", "no_progress"] as const;
const USER_DECISIONS = ["approve", "reject"] as const;
const SEVERITIES = ["info", "warning", "error"] as const;

function assertNonEmpty(v: unknown, path: string): string {
  const s = assertString(v, path);
  if (s.length === 0) throw new APIError(502, `Expected non-empty string at ${path}`);
  return s;
}

function parseErrorDetail(errObj: Record<string, unknown>, path: string): {
  code: string; message: string; retryable: boolean;
  stage: "discovery" | "acquisition" | "processing" | "artifact_build" | "validation" | null;
  details: Record<string, JsonValue>;
} {
  return {
    code: assertString(Reflect.get(errObj, "code"), path + ".code"),
    message: assertString(Reflect.get(errObj, "message"), path + ".message"),
    retryable: assertBoolean(Reflect.get(errObj, "retryable"), path + ".retryable"),
    stage: assertOptionalNull(Reflect.get(errObj, "stage"), path + ".stage", (v, p) => assertFinite(v, p, STAGE_NAMES)),
    details: assertJsonRecord(Reflect.get(errObj, "details"), path + ".details"),
  };
}

export function parsePipelineEventPayload(payloadObj: Record<string, unknown>, path: string): EventPayload {
  const payloadType = assertString(Reflect.get(payloadObj, "type"), path + ".type");
  switch (payloadType) {
    case "task_created":
      return { type: "task_created", topic: assertNonEmpty(Reflect.get(payloadObj, "topic"), path + ".topic") };
    case "plan_ready":
      return { type: "plan_ready", specification: assertJsonRecord(Reflect.get(payloadObj, "specification"), path + ".specification") };
    case "user_input_required":
      return {
        type: "user_input_required",
        request_id: assertString(Reflect.get(payloadObj, "request_id"), path + ".request_id"),
        prompt_kind: assertFinite(Reflect.get(payloadObj, "prompt_kind"), path + ".prompt_kind", PROMPT_KINDS),
        summary: assertString(Reflect.get(payloadObj, "summary"), path + ".summary"),
        expires_at: assertOptionalNull(Reflect.get(payloadObj, "expires_at"), path + ".expires_at", assertString),
        fixture_exempt: assertBoolean(Reflect.get(payloadObj, "fixture_exempt"), path + ".fixture_exempt"),
        detail: assertJsonRecord(Reflect.get(payloadObj, "detail"), path + ".detail"),
      };
    case "user_input_resumed":
      return {
        type: "user_input_resumed",
        request_id: assertString(Reflect.get(payloadObj, "request_id"), path + ".request_id"),
        decision: assertFinite(Reflect.get(payloadObj, "decision"), path + ".decision", USER_DECISIONS),
        detail: assertJsonRecord(Reflect.get(payloadObj, "detail"), path + ".detail"),
      };
    case "stage_started":
      return { type: "stage_started", stage: assertFinite(Reflect.get(payloadObj, "stage"), path + ".stage", STAGE_NAMES), attempt: assertPositiveInt(Reflect.get(payloadObj, "attempt"), path + ".attempt") };
    case "stage_completed": {
      const stage = assertFinite(Reflect.get(payloadObj, "stage"), path + ".stage", STAGE_NAMES);
      const status = assertString(Reflect.get(payloadObj, "status"), path + ".status");
      if (status !== "succeeded") throw new APIError(502, `Expected status "succeeded" at ${path}.status, got "${status}"`);
      return { type: "stage_completed", stage, status: "succeeded", output_digest: assertHex64(Reflect.get(payloadObj, "output_digest"), path + ".output_digest") };
    }
    case "stage_failed": {
      const errObj = assertObject(Reflect.get(payloadObj, "error"), path + ".error");
      const stage = assertFinite(Reflect.get(payloadObj, "stage"), path + ".stage", STAGE_NAMES);
      const status = assertString(Reflect.get(payloadObj, "status"), path + ".status");
      if (status !== "failed") throw new APIError(502, `Expected status "failed" at ${path}.status, got "${status}"`);
      return { type: "stage_failed", stage, status: "failed", error: parseErrorDetail(errObj, path + ".error") };
    }
    case "stage_skipped": {
      const stage = assertFinite(Reflect.get(payloadObj, "stage"), path + ".stage", STAGE_NAMES);
      const reason = assertString(Reflect.get(payloadObj, "reason"), path + ".reason");
      const reused_stage_attempt_id = assertOptionalNull(Reflect.get(payloadObj, "reused_stage_attempt_id"), path + ".reused_stage_attempt_id", assertString);
      const status = assertString(Reflect.get(payloadObj, "status"), path + ".status");
      if (status !== "skipped") throw new APIError(502, `Expected status "skipped" at ${path}.status, got "${status}"`);
      return { type: "stage_skipped", stage, status: "skipped", reason, reused_stage_attempt_id };
    }
    case "stage_progress": {
      const stage = assertFinite(Reflect.get(payloadObj, "stage"), path + ".stage", STAGE_NAMES);
      const kind = assertString(Reflect.get(payloadObj, "kind"), path + ".kind");
      const current = assertNonNegativeInt(Reflect.get(payloadObj, "current"), path + ".current");
      const total = assertOptionalNonNegativeInt(Reflect.get(payloadObj, "total"), path + ".total");
      const detail = assertJsonRecord(Reflect.get(payloadObj, "detail"), path + ".detail");
      return { type: "stage_progress", stage, kind, current, total, detail };
    }
    case "tool_called": {
      const tool_name = assertString(Reflect.get(payloadObj, "tool_name"), path + ".tool_name");
      const arguments_digest = assertHex64(Reflect.get(payloadObj, "arguments_digest"), path + ".arguments_digest");
      const arguments_ = assertOptionalNull(Reflect.get(payloadObj, "arguments"), path + ".arguments", assertJsonRecord);
      return { type: "tool_called", tool_name, arguments_digest, arguments: arguments_ };
    }
    case "tool_completed": {
      const tool_name = assertString(Reflect.get(payloadObj, "tool_name"), path + ".tool_name");
      const output_digest = assertOptionalNull(Reflect.get(payloadObj, "output_digest"), path + ".output_digest", assertHex64);
      const tool_call_id = assertOptionalNull(Reflect.get(payloadObj, "tool_call_id"), path + ".tool_call_id", assertString);
      const output = assertOptionalNull(Reflect.get(payloadObj, "output"), path + ".output", assertString);
      const is_error = assertBoolean(Reflect.get(payloadObj, "is_error"), path + ".is_error");
      if (!is_error && output_digest === null && tool_call_id === null) throw new APIError(502, "Tool completion requires output_digest or tool_call_id at " + path);
      return { type: "tool_completed", tool_name, output_digest, tool_call_id, output, is_error };
    }
    case "warning": {
      const warning = assertOptionalNull(Reflect.get(payloadObj, "warning"), path + ".warning", (v, p) => {
        const wr = assertObject(v, p);
        return {
          warning_id: assertString(Reflect.get(wr, "warning_id"), p + ".warning_id"),
          severity: assertFinite(Reflect.get(wr, "severity"), p + ".severity", SEVERITIES),
          stage: assertFinite(Reflect.get(wr, "stage"), p + ".stage", STAGE_NAMES),
          code: assertString(Reflect.get(wr, "code"), p + ".code"),
          message: assertString(Reflect.get(wr, "message"), p + ".message"),
          source_id: assertOptionalNull(Reflect.get(wr, "source_id"), p + ".source_id", assertString),
          asset_id: assertOptionalNull(Reflect.get(wr, "asset_id"), p + ".asset_id", assertString),
          record_id: assertOptionalNull(Reflect.get(wr, "record_id"), p + ".record_id", assertString),
          created_at: assertString(Reflect.get(wr, "created_at"), p + ".created_at"),
        };
      });
      const message = assertOptionalNull(Reflect.get(payloadObj, "message"), path + ".message", assertNonEmpty);
      const code = assertOptionalNull(Reflect.get(payloadObj, "code"), path + ".code", assertNonEmpty);
      const hasWarning = warning !== null;
      const hasMsgCode = message !== null && code !== null;
      if (hasWarning === hasMsgCode) throw new APIError(502, "Warning requires either warning record or message+code at " + path);
      return { type: "warning", warning, message, code };
    }
    case "artifact_produced": {
      const artObj = assertObject(Reflect.get(payloadObj, "artifact"), path + ".artifact");
      const artifact = {
        artifact_id: assertString(Reflect.get(artObj, "artifact_id"), path + ".artifact.artifact_id"),
        name: assertString(Reflect.get(artObj, "name"), path + ".artifact.name"),
        role: typeof Reflect.get(artObj, "role") === "string" ? Reflect.get(artObj, "role") as string : "audit_report",
        relative_path: assertString(Reflect.get(artObj, "relative_path"), path + ".artifact.relative_path"),
        media_type: assertString(Reflect.get(artObj, "media_type"), path + ".artifact.media_type"),
        size_bytes: assertNumber(Reflect.get(artObj, "size_bytes"), path + ".artifact.size_bytes"),
        sha256: assertString(Reflect.get(artObj, "sha256"), path + ".artifact.sha256"),
        generated_by_step_id: assertString(Reflect.get(artObj, "generated_by_step_id"), path + ".artifact.generated_by_step_id"),
      };
      return { type: "artifact_produced", artifact };
    }
    case "task_cancel_requested": {
      const reason = assertOptionalNull(Reflect.get(payloadObj, "reason"), path + ".reason", assertNonEmpty);
      return { type: "task_cancel_requested", reason };
    }
    case "task_cancelled":
      return { type: "task_cancelled", reason: assertString(Reflect.get(payloadObj, "reason"), path + ".reason") };
    case "task_recovered":
      return { type: "task_recovered", recovered_from_sequence: assertNonNegativeInt(Reflect.get(payloadObj, "recovered_from_sequence"), path + ".recovered_from_sequence") };
    case "task_completed": {
      const valObj = assertObject(Reflect.get(payloadObj, "validation"), path + ".validation");
      const validation = {
        status: assertFinite(Reflect.get(valObj, "status"), path + ".validation.status", ["valid", "invalid"] as const),
        checked_count: assertNonNegativeInt(Reflect.get(valObj, "checked_count"), path + ".validation.checked_count"),
        failed_count: assertNonNegativeInt(Reflect.get(valObj, "failed_count"), path + ".validation.failed_count"),
        report_path: assertString(Reflect.get(valObj, "report_path"), path + ".validation.report_path"),
      };
      return { type: "task_completed", validation };
    }
    case "task_failed": {
      const errObj = assertObject(Reflect.get(payloadObj, "error"), path + ".error");
      return { type: "task_failed", error: parseErrorDetail(errObj, path + ".error") };
    }
    default:
      throw new APIError(502, "Unknown pipeline event payload type " + payloadType);
  }
}
