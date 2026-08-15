import type { EventEnvelope, EventPayload } from "../contracts";
import type { TaskProjection } from "../types";
import { upsertRun } from "./shared";

/**
 * Agent permission control plane reducer (plan §30–§31).
 *
 * Unlike business HIL (``user_input_required``), a permission request does
 * not transition the run out of ``running`` — exactly one tool call is
 * suspended and resumes with the same tool call. The frontend keeps the
 * pending request on the projection so a reconnect can re-render the
 * approval card from the durable event stream.
 */
export function applyPermissionEvent(
  task: TaskProjection,
  envelope: EventEnvelope,
  payload: Extract<
    EventPayload,
    | { type: "permission_requested" }
    | { type: "permission_resolved" }
  >,
): TaskProjection {
  const runId = envelope.run_id;
  if (runId === null) return task;
  if (payload.type === "permission_requested") {
    return {
      ...upsertRun(task, runId, (run) => ({ ...run }), "running", envelope.timestamp),
      pendingPermission: {
        runId,
        requestId: payload.request_id,
        capability: payload.capability,
        scope: payload.scope,
        resource: payload.resource,
        command: payload.command,
        cwd: payload.cwd,
        summary: payload.summary,
        sequence: envelope.sequence,
        timestamp: envelope.timestamp,
      },
    };
  }
  const pending = task.pendingPermission;
  // A resolved event clears the pending request only when it matches the
  // currently pending identity; a stale/superseded resolution must not
  // dismiss a newer request.
  if (
    pending === null ||
    pending.runId !== runId ||
    pending.requestId !== payload.request_id
  ) {
    return task;
  }
  return { ...task, pendingPermission: null };
}
