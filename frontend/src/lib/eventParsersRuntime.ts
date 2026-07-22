import { APIError } from "@/hooks/settingsContracts";
import type { EventPayload, JsonValue } from "@/runtime/contracts";
import { assertString, assertNumber, assertOptionalNull, assertJsonRecord } from "./eventValidatorHelpers";

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
    default:
      throw new APIError(502, "Unknown runtime event payload type " + payloadType);
  }
}
