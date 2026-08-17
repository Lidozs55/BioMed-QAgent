import { APIError } from "@/api/errors";
import { parseBuildResult } from "@biomed/contracts";
import type {
  EventPayload,
  JsonValue,
  SubagentRequest,
  SubagentResult,
} from "@/runtime/contracts";
import {
  assertString,
  assertNumber,
  assertOptionalNull,
  assertJsonRecord,
  assertArray,
  assertFinite,
  assertHex64,
  assertNonNegativeInt,
  ERROR_CODES,
  STAGE_NAMES,
  SUBAGENT_ERROR_CODES,
  SUBAGENT_PROMPT_KINDS,
  SUBAGENT_STATUSES,
  SUBAGENT_TYPES,
} from "@biomed/contracts";
import { parseErrorDetail } from "./eventParsersPipeline";

export type SubagentEventPayload = Extract<
  EventPayload,
  { type: `subagent_${string}` }
>;

function assertRequiredString(value: unknown, path: string): string {
  return assertString(value, path, true);
}

function assertStringArray(value: unknown, path: string): string[] {
  return assertArray(value, path, (entry, index) =>
    assertRequiredString(entry, `${path}[${index}]`),
  );
}

function parseSubagentRequest(value: unknown, path: string): SubagentRequest {
  const request = assertJsonRecord(value, path);
  return {
    agent_type: assertFinite(Reflect.get(request, "agent_type"), `${path}.agent_type`, SUBAGENT_TYPES),
    objective: assertRequiredString(Reflect.get(request, "objective"), `${path}.objective`),
    target_source: assertOptionalNull(
      Reflect.get(request, "target_source"),
      `${path}.target_source`,
      assertRequiredString,
    ),
    domain: assertRequiredString(Reflect.get(request, "domain"), `${path}.domain`),
    capability: assertRequiredString(Reflect.get(request, "capability"), `${path}.capability`),
    inputs: assertJsonRecord(Reflect.get(request, "inputs"), `${path}.inputs`),
  };
}

function parseSubagentResult(value: unknown, path: string): SubagentResult {
  const result = assertJsonRecord(value, path);
  const status = assertFinite(Reflect.get(result, "status"), `${path}.status`, SUBAGENT_STATUSES);
  if (
    status !== "completed" &&
    status !== "failed" &&
    status !== "cancelled" &&
    status !== "interrupted"
  ) {
    throw new APIError(502, `Expected terminal subagent status at ${path}.status`);
  }
  return {
    subagent_id: assertRequiredString(Reflect.get(result, "subagent_id"), `${path}.subagent_id`),
    status,
    summary: assertRequiredString(Reflect.get(result, "summary"), `${path}.summary`),
    source_asset_ids: assertStringArray(
      Reflect.get(result, "source_asset_ids"),
      `${path}.source_asset_ids`,
    ),
    recipe_id: assertOptionalNull(
      Reflect.get(result, "recipe_id"),
      `${path}.recipe_id`,
      assertRequiredString,
    ),
    warnings: assertStringArray(Reflect.get(result, "warnings"), `${path}.warnings`),
    error_code: assertOptionalNull(
      Reflect.get(result, "error_code"),
      `${path}.error_code`,
      (v, p) => assertFinite(v, p, SUBAGENT_ERROR_CODES),
    ),
    error_message: assertOptionalNull(
      Reflect.get(result, "error_message"),
      `${path}.error_message`,
      assertRequiredString,
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
    case "run_completed": {
      const rawBuildResult = Reflect.get(payloadObj, "build_result");
      return {
        type: "run_completed",
        build_result:
          rawBuildResult === undefined || rawBuildResult === null
            ? null
            : parseBuildResult(rawBuildResult, path + ".build_result"),
      };
    }
    case "run_failed":
      return {
        type: "run_failed",
        error: assertString(Reflect.get(payloadObj, "error"), path + ".error"),
        error_code: assertOptionalNull(
          Reflect.get(payloadObj, "error_code"),
          path + ".error_code",
          (v, p) => assertFinite(v, p, ERROR_CODES),
        ),
      };
    case "run_cancel_requested": {
      const reason = assertOptionalNull(Reflect.get(payloadObj, "reason"), path + ".reason", assertString);
      return { type: "run_cancel_requested", reason };
    }
    case "run_cancelled": {
      const reason = assertOptionalNull(Reflect.get(payloadObj, "reason"), path + ".reason", assertString);
      return {
        type: "run_cancelled",
        reason,
        cancelled_at_stage: assertOptionalNull(
          Reflect.get(payloadObj, "cancelled_at_stage"),
          path + ".cancelled_at_stage",
          (v, p) => assertFinite(v, p, STAGE_NAMES),
        ),
      };
    }
    case "run_interrupted":
      return { type: "run_interrupted", reason: assertString(Reflect.get(payloadObj, "reason"), path + ".reason") };
    case "publication_created":
      return {
        type: "publication_created",
        publication_id: assertRequiredString(Reflect.get(payloadObj, "publication_id"), path + ".publication_id"),
        run_id: assertRequiredString(Reflect.get(payloadObj, "run_id"), path + ".run_id"),
        manifest_sha256: assertHex64(Reflect.get(payloadObj, "manifest_sha256"), path + ".manifest_sha256"),
        supersedes_publication_id: assertOptionalNull(
          Reflect.get(payloadObj, "supersedes_publication_id"),
          path + ".supersedes_publication_id",
          assertRequiredString,
        ),
        published_at: assertRequiredString(Reflect.get(payloadObj, "published_at"), path + ".published_at"),
      };
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
        subagent_id: assertRequiredString(Reflect.get(payloadObj, "subagent_id"), path + ".subagent_id"),
        request: parseSubagentRequest(Reflect.get(payloadObj, "request"), path + ".request"),
      };
    case "subagent_started":
      return {
        type: "subagent_started",
        subagent_id: assertRequiredString(Reflect.get(payloadObj, "subagent_id"), path + ".subagent_id"),
      };
    case "subagent_progress":
      return {
        type: "subagent_progress",
        subagent_id: assertRequiredString(Reflect.get(payloadObj, "subagent_id"), path + ".subagent_id"),
        current: assertNonNegativeInt(Reflect.get(payloadObj, "current"), path + ".current"),
        total: assertOptionalNull(Reflect.get(payloadObj, "total"), path + ".total", assertNonNegativeInt),
        message: assertOptionalNull(Reflect.get(payloadObj, "message"), path + ".message", assertRequiredString),
      };
    case "subagent_completed":
    case "subagent_failed":
    case "subagent_cancelled":
    case "subagent_interrupted": {
      const subagent_id = assertRequiredString(Reflect.get(payloadObj, "subagent_id"), path + ".subagent_id");
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
        subagent_id: assertRequiredString(Reflect.get(payloadObj, "subagent_id"), path + ".subagent_id"),
        reason: assertOptionalNull(Reflect.get(payloadObj, "reason"), path + ".reason", assertRequiredString),
      };
    case "subagent_input_required":
      return {
        type: "subagent_input_required",
        subagent_id: assertRequiredString(Reflect.get(payloadObj, "subagent_id"), path + ".subagent_id"),
        request_id: assertRequiredString(Reflect.get(payloadObj, "request_id"), path + ".request_id"),
        summary: assertRequiredString(Reflect.get(payloadObj, "summary"), path + ".summary"),
        prompt_kind: assertFinite(Reflect.get(payloadObj, "prompt_kind"), path + ".prompt_kind", SUBAGENT_PROMPT_KINDS),
        expires_at: assertOptionalNull(Reflect.get(payloadObj, "expires_at"), path + ".expires_at", assertRequiredString),
        detail: assertJsonRecord(Reflect.get(payloadObj, "detail"), path + ".detail"),
      };
    case "subagent_input_resumed": {
      const decision = assertRequiredString(Reflect.get(payloadObj, "decision"), path + ".decision");
      if (decision !== "approve" && decision !== "reject") {
        throw new APIError(502, `Invalid subagent decision at ${path}.decision`);
      }
      return {
        type: "subagent_input_resumed",
        subagent_id: assertRequiredString(Reflect.get(payloadObj, "subagent_id"), path + ".subagent_id"),
        request_id: assertRequiredString(Reflect.get(payloadObj, "request_id"), path + ".request_id"),
        decision,
        detail: assertJsonRecord(Reflect.get(payloadObj, "detail"), path + ".detail"),
      };
    }
    /* ---- Agent permission control plane (plan §30) ---- */
    case "permission_requested": {
      const capability = assertRequiredString(Reflect.get(payloadObj, "capability"), path + ".capability");
      if (capability !== "fs.read" && capability !== "fs.write" && capability !== "fs.edit" && capability !== "process.exec") {
        throw new APIError(502, `Invalid permission capability at ${path}.capability`);
      }
      const scope = assertRequiredString(Reflect.get(payloadObj, "scope"), path + ".scope");
      if (
        scope !== "workspace" &&
        scope !== "task_output" &&
        scope !== "framework_internal" &&
        scope !== "sensitive" &&
        scope !== "project" &&
        scope !== "external"
      ) {
        throw new APIError(502, `Invalid permission scope at ${path}.scope`);
      }
      return {
        type: "permission_requested",
        request_id: assertRequiredString(Reflect.get(payloadObj, "request_id"), path + ".request_id"),
        capability,
        scope,
        resource: assertOptionalNull(Reflect.get(payloadObj, "resource"), path + ".resource", assertRequiredString),
        canonical_resource: assertOptionalNull(Reflect.get(payloadObj, "canonical_resource"), path + ".canonical_resource", assertRequiredString),
        command: assertOptionalNull(Reflect.get(payloadObj, "command"), path + ".command", assertRequiredString),
        cwd: assertOptionalNull(Reflect.get(payloadObj, "cwd"), path + ".cwd", assertRequiredString),
        summary: assertRequiredString(Reflect.get(payloadObj, "summary"), path + ".summary"),
      };
    }
    case "permission_resolved": {
      const decision = assertRequiredString(Reflect.get(payloadObj, "decision"), path + ".decision");
      if (decision !== "allow" && decision !== "deny") {
        throw new APIError(502, `Invalid permission decision at ${path}.decision`);
      }
      const rawScope = Reflect.get(payloadObj, "grant_scope");
      let grant_scope: "once" | "run" | "task" | "persistent" | null = null;
      if (rawScope !== null && rawScope !== undefined) {
        if (rawScope !== "once" && rawScope !== "run" && rawScope !== "task" && rawScope !== "persistent") {
          throw new APIError(502, `Invalid permission grant_scope at ${path}.grant_scope`);
        }
        grant_scope = rawScope;
      }
      return {
        type: "permission_resolved",
        request_id: assertRequiredString(Reflect.get(payloadObj, "request_id"), path + ".request_id"),
        decision,
        grant_scope,
      };
    }
    /* ---- V2 build-execution lifecycle (Design §15.1; T3 stage mirror) ---- */
    case "operation_started": {
      const label = Reflect.get(payloadObj, "label");
      const category = Reflect.get(payloadObj, "category");
      const attempt = Reflect.get(payloadObj, "attempt");
      return {
        type: "operation_started",
        operation_id: assertRequiredString(Reflect.get(payloadObj, "operation_id"), path + ".operation_id"),
        label: typeof label === "string" ? label : undefined,
        category: typeof category === "string" ? category : undefined,
        attempt: attempt === undefined || attempt === null ? undefined : assertNumber(attempt, path + ".attempt"),
      };
    }
    case "operation_progress": {
      const detail = Reflect.get(payloadObj, "detail");
      return {
        type: "operation_progress",
        operation_id: assertRequiredString(Reflect.get(payloadObj, "operation_id"), path + ".operation_id"),
        kind: assertRequiredString(Reflect.get(payloadObj, "kind"), path + ".kind"),
        current: assertNonNegativeInt(Reflect.get(payloadObj, "current"), path + ".current"),
        total: assertOptionalNull(Reflect.get(payloadObj, "total"), path + ".total", assertNonNegativeInt),
        detail: detail === undefined || detail === null ? undefined : assertJsonRecord(detail, path + ".detail"),
      };
    }
    case "operation_completed": {
      const rawStatus = Reflect.get(payloadObj, "status");
      const status = rawStatus === undefined || rawStatus === null ? "succeeded" : rawStatus;
      if (status !== "succeeded" && status !== "skipped") {
        throw new APIError(502, `Invalid operation status "${String(status)}" at ${path}.status`);
      }
      const outputDigest = Reflect.get(payloadObj, "output_digest");
      const reused = Reflect.get(payloadObj, "reused_operation_attempt_id");
      return {
        type: "operation_completed",
        operation_id: assertRequiredString(Reflect.get(payloadObj, "operation_id"), path + ".operation_id"),
        status,
        output_digest: outputDigest === undefined || outputDigest === null ? undefined : assertHex64(outputDigest, path + ".output_digest"),
        reused_operation_attempt_id: reused === undefined || reused === null ? null : assertRequiredString(reused, path + ".reused_operation_attempt_id"),
      };
    }
    case "operation_failed": {
      const rawStatus = Reflect.get(payloadObj, "status");
      if (rawStatus !== "failed" && rawStatus !== "cancelled") {
        throw new APIError(502, `Invalid operation status "${String(rawStatus)}" at ${path}.status`);
      }
      const rawError = Reflect.get(payloadObj, "error");
      return {
        type: "operation_failed",
        operation_id: assertRequiredString(Reflect.get(payloadObj, "operation_id"), path + ".operation_id"),
        status: rawStatus,
        error: rawError === undefined || rawError === null ? null : parseErrorDetail(assertJsonRecord(rawError, path + ".error"), path + ".error"),
      };
    }
    default:
      throw new APIError(502, "Unknown runtime event payload type " + payloadType);
  }
}

export function isValidSubagentEventPayload(
  payloadObj: Record<string, unknown>,
): boolean {
  return parseSubagentEventPayload(payloadObj) !== null;
}

export function parseSubagentEventPayload(
  payloadObj: Record<string, unknown>,
): SubagentEventPayload | null {
  try {
    const payload = parseRuntimeEventPayload(payloadObj, "websocket.payload");
    return isSubagentEventPayload(payload) ? payload : null;
  } catch {
    return null;
  }
}

function isSubagentEventPayload(
  payload: EventPayload,
): payload is SubagentEventPayload {
  return payload.type.startsWith("subagent_");
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
