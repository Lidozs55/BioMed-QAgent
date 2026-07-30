import { APIError } from "@/hooks/settingsContracts";
import type {
  EventPayload,
  JsonValue,
  SubagentErrorCode,
  SubagentPromptKind,
  SubagentRequest,
  SubagentResult,
  SubagentStatus,
  SubagentType,
} from "@/runtime/contracts";
import { assertString, assertNumber, assertOptionalNull, assertJsonRecord } from "./eventValidatorHelpers";

function assertSubagentType(value: unknown, path: string): SubagentType {
  if (value === "source_research" || value === "skill_builder") return value;
  throw new APIError(502, `Invalid subagent type at ${path}`);
}

function assertSubagentStatus(value: unknown, path: string): SubagentStatus {
  switch (value) {
    case "queued":
    case "running":
    case "completed":
    case "failed":
    case "cancel_requested":
    case "cancelled":
    case "interrupted":
      return value;
    default:
      throw new APIError(502, `Invalid subagent status at ${path}`);
  }
}

function assertSubagentErrorCode(
  value: unknown,
  path: string,
): SubagentErrorCode {
  switch (value) {
    case "not_found":
    case "capability_gap":
    case "extraction_failed":
    case "auth_required":
    case "captcha_required":
    case "credential_required":
    case "payment_required":
    case "policy_denied":
    case "rate_limited":
    case "timed_out":
    case "cancelled":
    case "internal_error":
      return value;
    default:
      throw new APIError(502, `Invalid subagent error code at ${path}`);
  }
}

function assertSubagentPromptKind(
  value: unknown,
  path: string,
): SubagentPromptKind {
  switch (value) {
    case "authentication":
    case "captcha":
    case "api_key_or_credential":
    case "payment":
    case "terms_approval":
    case "confirmation":
      return value;
    default:
      throw new APIError(502, `Invalid subagent prompt kind at ${path}`);
  }
}

function assertStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    throw new APIError(502, `Expected string array at ${path}`);
  }
  return value.map((entry, index) => assertString(entry, `${path}[${index}]`));
}

function parseSubagentRequest(value: unknown, path: string): SubagentRequest {
  const request = assertJsonRecord(value, path);
  return {
    agent_type: assertSubagentType(Reflect.get(request, "agent_type"), `${path}.agent_type`),
    objective: assertString(Reflect.get(request, "objective"), `${path}.objective`),
    target_source: assertOptionalNull(
      Reflect.get(request, "target_source"),
      `${path}.target_source`,
      assertString,
    ),
    domain: assertString(Reflect.get(request, "domain"), `${path}.domain`),
    capability: assertString(Reflect.get(request, "capability"), `${path}.capability`),
    inputs: assertJsonRecord(Reflect.get(request, "inputs"), `${path}.inputs`),
  };
}

function parseSubagentResult(value: unknown, path: string): SubagentResult {
  const result = assertJsonRecord(value, path);
  const status = assertSubagentStatus(Reflect.get(result, "status"), `${path}.status`);
  if (
    status !== "completed" &&
    status !== "failed" &&
    status !== "cancelled" &&
    status !== "interrupted"
  ) {
    throw new APIError(502, `Expected terminal subagent status at ${path}.status`);
  }
  return {
    subagent_id: assertString(Reflect.get(result, "subagent_id"), `${path}.subagent_id`),
    status,
    summary: assertString(Reflect.get(result, "summary"), `${path}.summary`),
    source_asset_ids: assertStringArray(
      Reflect.get(result, "source_asset_ids"),
      `${path}.source_asset_ids`,
    ),
    recipe_id: assertOptionalNull(
      Reflect.get(result, "recipe_id"),
      `${path}.recipe_id`,
      assertString,
    ),
    warnings: assertStringArray(Reflect.get(result, "warnings"), `${path}.warnings`),
    error_code: assertOptionalNull(
      Reflect.get(result, "error_code"),
      `${path}.error_code`,
      assertSubagentErrorCode,
    ),
    error_message: assertOptionalNull(
      Reflect.get(result, "error_message"),
      `${path}.error_message`,
      assertString,
    ),
  };
}

export function parseRuntimeEventPayload(payloadObj: Record<string, unknown>, path: string): EventPayload {
  const payloadType = assertString(Reflect.get(payloadObj, "type"), path + ".type");
  switch (payloadType) {
    case "run_queued": {
      const input = assertString(Reflect.get(payloadObj, "input"), path + ".input");
      if (input.length === 0) throw new APIError(502, "Expected non-empty input at " + path + ".input");
      return { type: "run_queued", request_id: assertString(Reflect.get(payloadObj, "request_id"), path + ".request_id"), input };
    }
    case "run_started":
      return { type: "run_started" };
    case "run_finalizing":
      return { type: "run_finalizing" };
    case "run_completed":
      return { type: "run_completed" };
    case "run_failed":
      return { type: "run_failed", error: assertString(Reflect.get(payloadObj, "error"), path + ".error") };
    case "run_cancel_requested": {
      const reason = assertOptionalNull(Reflect.get(payloadObj, "reason"), path + ".reason", assertString);
      return { type: "run_cancel_requested", reason };
    }
    case "run_cancelled": {
      const reason = assertOptionalNull(Reflect.get(payloadObj, "reason"), path + ".reason", assertString);
      return { type: "run_cancelled", reason };
    }
    case "run_interrupted":
      return { type: "run_interrupted", reason: assertString(Reflect.get(payloadObj, "reason"), path + ".reason") };
    case "assistant_delta": {
      const delta = assertString(Reflect.get(payloadObj, "delta"), path + ".delta");
      const stream_id = Reflect.get(payloadObj, "stream_id");
      const from_chunk_index = Reflect.get(payloadObj, "from_chunk_index");
      const through_chunk_index = Reflect.get(payloadObj, "through_chunk_index");
      if (stream_id === null || stream_id === undefined) {
        if (stream_id === null) return { type: "assistant_delta", delta, stream_id: null, from_chunk_index: null, through_chunk_index: null };
        return { type: "assistant_delta", delta };
      }
      const fci = assertNumber(from_chunk_index, path + ".from_chunk_index");
      const tci = assertNumber(through_chunk_index, path + ".through_chunk_index");
      if (fci > tci) throw new APIError(502, `from_chunk_index (${fci}) exceeds through_chunk_index (${tci}) at ${path}`);
      return {
        type: "assistant_delta", delta,
        stream_id: assertString(stream_id, path + ".stream_id"),
        from_chunk_index: fci,
        through_chunk_index: tci,
      };
    }
    case "assistant_reasoning_delta":
      return { type: "assistant_reasoning_delta", delta: assertString(Reflect.get(payloadObj, "delta"), path + ".delta") };
    case "tool_started": {
      const tool_call_id = assertString(Reflect.get(payloadObj, "tool_call_id"), path + ".tool_call_id");
      const tool_name = assertString(Reflect.get(payloadObj, "tool_name"), path + ".tool_name");
      const rawArgs = Reflect.get(payloadObj, "arguments");
      const arguments_: Record<string, JsonValue> | null = rawArgs === null || rawArgs === undefined ? null : assertJsonRecord(rawArgs, path + ".arguments");
      return { type: "tool_started", tool_call_id, tool_name, arguments: arguments_ };
    }
    case "conversation_compacted": {
      const covered_through_run_id = assertString(Reflect.get(payloadObj, "covered_through_run_id"), path + ".covered_through_run_id");
      const summary_digest = assertString(Reflect.get(payloadObj, "summary_digest"), path + ".summary_digest");
      if (!/^[0-9a-f]{64}$/.test(summary_digest)) throw new APIError(502, "Expected 64-char hex string at " + path + ".summary_digest");
      return { type: "conversation_compacted", covered_through_run_id, summary_digest };
    }
    case "subagent_queued":
      return {
        type: "subagent_queued",
        subagent_id: assertString(Reflect.get(payloadObj, "subagent_id"), path + ".subagent_id"),
        request: parseSubagentRequest(Reflect.get(payloadObj, "request"), path + ".request"),
      };
    case "subagent_started":
      return {
        type: "subagent_started",
        subagent_id: assertString(Reflect.get(payloadObj, "subagent_id"), path + ".subagent_id"),
      };
    case "subagent_progress":
      return {
        type: "subagent_progress",
        subagent_id: assertString(Reflect.get(payloadObj, "subagent_id"), path + ".subagent_id"),
        current: assertNumber(Reflect.get(payloadObj, "current"), path + ".current"),
        total: assertOptionalNull(Reflect.get(payloadObj, "total"), path + ".total", assertNumber),
        message: assertOptionalNull(Reflect.get(payloadObj, "message"), path + ".message", assertString),
      };
    case "subagent_completed":
    case "subagent_failed":
    case "subagent_cancelled":
    case "subagent_interrupted": {
      const subagent_id = assertString(Reflect.get(payloadObj, "subagent_id"), path + ".subagent_id");
      const result = parseSubagentResult(Reflect.get(payloadObj, "result"), path + ".result");
      const expectedStatus = typeToTerminalStatus(payloadType);
      if (result.subagent_id !== subagent_id || result.status !== expectedStatus) {
        throw new APIError(502, `Terminal subagent result must match ${payloadType} at ${path}`);
      }
      return { type: payloadType, subagent_id, result };
    }
    case "subagent_cancel_requested":
      return {
        type: "subagent_cancel_requested",
        subagent_id: assertString(Reflect.get(payloadObj, "subagent_id"), path + ".subagent_id"),
        reason: assertOptionalNull(Reflect.get(payloadObj, "reason"), path + ".reason", assertString),
      };
    case "subagent_input_required":
      return {
        type: "subagent_input_required",
        subagent_id: assertString(Reflect.get(payloadObj, "subagent_id"), path + ".subagent_id"),
        request_id: assertString(Reflect.get(payloadObj, "request_id"), path + ".request_id"),
        summary: assertString(Reflect.get(payloadObj, "summary"), path + ".summary"),
        prompt_kind: assertSubagentPromptKind(Reflect.get(payloadObj, "prompt_kind"), path + ".prompt_kind"),
        expires_at: assertOptionalNull(Reflect.get(payloadObj, "expires_at"), path + ".expires_at", assertString),
        detail: assertJsonRecord(Reflect.get(payloadObj, "detail"), path + ".detail"),
      };
    case "subagent_input_resumed": {
      const decision = assertString(Reflect.get(payloadObj, "decision"), path + ".decision");
      if (decision !== "approve" && decision !== "reject") {
        throw new APIError(502, `Invalid subagent decision at ${path}.decision`);
      }
      return {
        type: "subagent_input_resumed",
        subagent_id: assertString(Reflect.get(payloadObj, "subagent_id"), path + ".subagent_id"),
        request_id: assertString(Reflect.get(payloadObj, "request_id"), path + ".request_id"),
        decision,
        detail: assertJsonRecord(Reflect.get(payloadObj, "detail"), path + ".detail"),
      };
    }
    default:
      throw new APIError(502, "Unknown runtime event payload type " + payloadType);
  }
}

function typeToTerminalStatus(
  type: "subagent_completed" | "subagent_failed" | "subagent_cancelled" | "subagent_interrupted",
): SubagentResult["status"] {
  switch (type) {
    case "subagent_completed":
      return "completed";
    case "subagent_failed":
      return "failed";
    case "subagent_cancelled":
      return "cancelled";
    case "subagent_interrupted":
      return "interrupted";
  }
}
