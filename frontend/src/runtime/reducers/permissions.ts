import type { EventEnvelope, EventPayload } from "../contracts";
import type { TaskProjection } from "../types";
import { upsertItem, upsertRun } from "./shared";

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
  const itemId = `permission:${runId}:${payload.request_id}`;
  if (payload.type === "permission_requested") {
    const projected = upsertItem(
      upsertRun(task, runId, (run) => ({ ...run }), "running", envelope.timestamp),
      {
        kind: "permission",
        itemId,
        runId,
        sequence: envelope.sequence,
        createdAt: envelope.timestamp,
        requestId: payload.request_id,
        capability: payload.capability,
        summary: payload.summary,
        status: "requested",
        grantScope: null,
      },
    );
    return {
      ...projected,
      pendingPermission: {
        runId,
        requestId: payload.request_id,
        capability: payload.capability,
        scope: payload.scope,
        resource: payload.resource,
        canonicalResource: payload.canonical_resource,
        command: payload.command,
        cwd: payload.cwd,
        summary: payload.summary,
        sequence: envelope.sequence,
        timestamp: envelope.timestamp,
      },
    };
  }
  const existing = task.items.find((item) => item.itemId === itemId);
  const projected = existing?.kind === "permission"
    ? upsertItem(task, {
        ...existing,
        status: payload.decision === "allow" ? "allowed" : "denied",
        grantScope: payload.grant_scope,
      })
    : task;
  const pending = projected.pendingPermission;
  // A stale/superseded resolution may close its own historical item, but must
  // not dismiss the newer currently pending request.
  if (
    pending === null ||
    pending.runId !== runId ||
    pending.requestId !== payload.request_id
  ) {
    return projected;
  }
  return { ...projected, pendingPermission: null };
}
