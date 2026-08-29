import type { EventEnvelope, EventPayload } from "@biomed/contracts";
import { describe, expect, test } from "vitest";

import {
  reduceTaskEvents,
  type DurableTaskMetadata,
} from "../src/runtime/task-reducer.js";

const metadata: DurableTaskMetadata = {
  schema_version: 1,
  task_id: "task_steer",
  mode: "agent",
  databases: [],
  title: "Steered task",
  created_at: "2026-08-29T00:00:00.000Z",
};

function event(sequence: number, payload: EventPayload): EventEnvelope {
  return {
    schema_version: "2.0",
    event_id: `event_${sequence}`,
    type: payload.type,
    task_id: metadata.task_id,
    run_id: "run_1",
    stage_attempt_id: null,
    sequence,
    timestamp: `2026-08-29T00:00:0${sequence}.000Z`,
    payload,
  };
}

describe("reduceTaskEvents", () => {
  test("keeps a direction adjustment between separate assistant turns", () => {
    const snapshot = reduceTaskEvents(metadata, [
      event(1, { type: "run_queued", request_id: "request_1", input: "initial" }),
      event(2, { type: "assistant_delta", delta: "before " }),
      event(3, { type: "assistant_delta", delta: "steer" }),
      event(4, { type: "run_steered", input: "focus on TP53" }),
      event(5, { type: "assistant_delta", delta: "after steer" }),
    ]);

    expect(snapshot.messages).toMatchObject([
      { role: "user", content: "initial", sequence: 1 },
      { role: "assistant", content: "before steer", sequence: 2 },
      { role: "user", content: "focus on TP53", sequence: 4 },
      { role: "assistant", content: "after steer", sequence: 5 },
    ]);
  });
});
