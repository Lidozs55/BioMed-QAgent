/**
 * Core operation event → stable EventPayload mapping (M2, I-05).
 *
 * Dataset Core internal types never reach the frontend: the sink converts
 * them into the frozen operation_* payloads the durable event log and the
 * frontend reducer already understand. Execution lifecycle events ride on a
 * synthetic ``execution:<requirementId>`` operation identity so the UI groups them
 * without new event types.
 */

import type { EventPayload } from "@biomed/contracts";

import type { CoreOperationEvent } from "../runtime/executor.js";

export function coreEventToPayload(
  event: CoreOperationEvent,
  requirementId: string,
): EventPayload {
  switch (event.type) {
    case "execution_started":
      return {
        type: "operation_started",
        operation_id: `execution:${requirementId}`,
        label: "数据处理",
        category: "execution",
      };
    case "operation_started":
      return {
        type: "operation_started",
        operation_id: event.operationId,
        label: event.label ?? undefined,
        category: event.category,
        attempt: event.attempt,
      };
    case "operation_completed":
      return {
        type: "operation_completed",
        operation_id: event.operationId,
        status: event.status,
        output_digest: event.outputDigest ?? undefined,
        reused_operation_attempt_id: event.reusedOperationAttemptId ?? undefined,
      };
    case "operation_failed":
      return {
        type: "operation_failed",
        operation_id: event.operationId,
        status: event.status,
        error: event.error === null ? null : {
          code: event.error.code,
          message: event.error.message,
          retryable: false,
          stage: null,
          details: {},
        },
      };
    case "execution_completed":
      return {
        type: "operation_completed",
        operation_id: `execution:${requirementId}`,
        status: "succeeded",
      };
    case "execution_failed":
      return {
        type: "operation_failed",
        operation_id: `execution:${requirementId}`,
        status: "failed",
        error: event.error === null ? null : {
          code: event.error.code,
          message: event.error.message,
          retryable: false,
          stage: null,
          details: {},
        },
      };
    case "execution_cancelled":
      return {
        type: "operation_failed",
        operation_id: `execution:${requirementId}`,
        status: "cancelled",
      };
  }
}
