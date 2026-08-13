/**
 * Core operation event → stable EventPayload mapping (M2, I-05).
 *
 * Dataset Core internal types never reach the frontend: the sink converts
 * them into the frozen operation_* payloads the durable event log and the
 * frontend reducer already understand. Build lifecycle events ride on a
 * synthetic ``build:<buildId>`` operation identity so the UI groups them
 * without new event types.
 */

import type { EventPayload } from "@biomed/contracts";

import type { CoreOperationEvent } from "../runtime/executor.js";

export function coreEventToPayload(
  event: CoreOperationEvent,
  buildId: string,
): EventPayload {
  switch (event.type) {
    case "build_started":
      return {
        type: "operation_started",
        operation_id: `build:${buildId}`,
        label: "构建",
        category: "build",
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
    case "build_completed":
      return {
        type: "operation_completed",
        operation_id: `build:${buildId}`,
        status: "succeeded",
      };
    case "build_failed":
      return {
        type: "operation_failed",
        operation_id: `build:${buildId}`,
        status: "failed",
        error: event.error === null ? null : {
          code: event.error.code,
          message: event.error.message,
          retryable: false,
          stage: null,
          details: {},
        },
      };
    case "build_cancelled":
      return {
        type: "operation_failed",
        operation_id: `build:${buildId}`,
        status: "cancelled",
      };
  }
}
