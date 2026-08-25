import { APIError } from "@/api/errors";
import type { EventPayload } from "@/runtime/contracts";
import { parsePipelineEventPayload } from "./eventParsersPipeline";
import { parseRuntimeEventPayload } from "./eventParsersRuntime";

const PIPELINE_TYPES = new Set([
  "task_created", "plan_ready", "user_input_required", "user_input_resumed",
  "stage_started", "stage_completed", "stage_failed", "stage_skipped", "stage_progress",
  "tool_called", "tool_completed", "warning", "artifact_produced",
  "task_cancel_requested", "task_cancelled", "task_recovered", "task_completed", "task_failed",
]);

const RUNTIME_TYPES = new Set([
  "run_queued", "run_started", "run_finalizing", "run_completed", "run_failed",
  "run_cancel_requested", "run_cancelled", "run_interrupted", "publication_created",
  "assistant_delta", "assistant_reasoning_delta", "tool_started", "context_usage", "conversation_compacted",
  "conversation_compaction_started", "conversation_compaction_failed",
  "permission_requested", "permission_resolved",
  "operation_started", "operation_progress", "operation_completed", "operation_failed",
  "subagent_queued", "subagent_started", "subagent_progress", "subagent_completed",
  "subagent_failed", "subagent_cancel_requested", "subagent_cancelled",
  "subagent_interrupted", "subagent_input_required", "subagent_input_resumed",
]);

export function parseEventPayload(payloadObj: Record<string, unknown>, expectedType: string, path: string): EventPayload {
  const payloadType = Reflect.get(payloadObj, "type");
  if (payloadType !== expectedType) {
    throw new APIError(502, `Event payload type "${String(payloadType)}" does not match envelope type "${expectedType}" at ${path}`);
  }
  if (typeof payloadType !== "string") {
    throw new APIError(502, `Expected string event type at ${path}`);
  }
  if (PIPELINE_TYPES.has(payloadType)) return parsePipelineEventPayload(payloadObj, path);
  if (RUNTIME_TYPES.has(payloadType)) return parseRuntimeEventPayload(payloadObj, path);
  throw new APIError(502, "Unknown event payload type " + String(payloadType));
}
