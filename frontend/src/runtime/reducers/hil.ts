import type {
  EventEnvelope,
  EventPayload,
} from "../contracts";
import type { TaskProjection } from "../types";
import { upsertRun } from "./shared";

export function applyUserInputEvent(
  task: TaskProjection,
  envelope: EventEnvelope,
  payload: Extract<
    EventPayload,
    | { type: "user_input_required" }
    | { type: "user_input_resumed" }
  >,
): TaskProjection {
  const runId = envelope.run_id;
  if (runId === null) return task;
  if (payload.type === "user_input_required") {
    const next = upsertRun(
      task,
      runId,
      (run) => ({
        ...run,
        status: "awaiting_user_input",
        updatedAt: envelope.timestamp,
      }),
      "awaiting_user_input",
      envelope.timestamp,
    );
    return {
      ...next,
      summary: {
        ...next.summary,
        status: "awaiting_user_input",
        active_run_id: runId,
      },
      pendingUserInput: {
        runId,
        requestId: payload.request_id,
        promptKind: payload.prompt_kind,
        summary: payload.summary,
        expiresAt: payload.expires_at,
        fixtureExempt: payload.fixture_exempt,
        detail: payload.detail,
        sequence: envelope.sequence,
        timestamp: envelope.timestamp,
      },
    };
  }
  const next = upsertRun(
    task,
    runId,
    (run) => ({
      ...run,
      status: "running",
      updatedAt: envelope.timestamp,
    }),
    "running",
    envelope.timestamp,
  );
  return {
    ...next,
    summary: {
      ...next.summary,
      status: "running",
      active_run_id: runId,
    },
    pendingUserInput:
      next.pendingUserInput?.runId === runId &&
      next.pendingUserInput.requestId === payload.request_id
        ? null
        : next.pendingUserInput,
  };
}
