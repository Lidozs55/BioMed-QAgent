import type { EventEnvelope, EventPayload, TaskExecutionContext } from "@biomed/contracts";
import { parseTaskExecutionContext } from "@biomed/contracts";
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

function frozenContext(): TaskExecutionContext {
  return parseTaskExecutionContext({
    schema_version: "1.0",
    kind: "frozen_evaluation",
    manifest_id: "gold-v1",
    case_id: "gold6",
    manifest_sha256: "a".repeat(64),
    case_spec_sha256: "b".repeat(64),
    prompt_sha256: "f30ab31099da23c75a3e0037ee303b8814c7c124bc1e84be149d2c6f4c8fc298",
    runtime_profile_sha256: "c".repeat(64),
    expected_family: "bioactivity_measurement",
    required_tables: ["paper_records", "chart_points"],
    allowed_sources: ["PubMed", "Europe PMC"],
    source_selection: { papers: ["PMC10408569"] },
    success_definition: "registered bioactivity publication with reverified artifact hashes",
    forbidden_shortcuts: ["prompt modification"],
  });
}

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
      event(1, { type: "run_queued", request_id: "request_1", input: "initial", execution_context: null }),
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

  test("projects the frozen execution context onto the run record", () => {
    const context = frozenContext();
    const snapshot = reduceTaskEvents(metadata, [
      event(1, { type: "run_queued", request_id: "request_1", input: "initial", execution_context: context }),
      event(2, { type: "run_completed" }),
    ]);

    expect(snapshot.runs[0]?.execution_context).toEqual(context);
    expect(snapshot.runs[0]?.execution_context?.case_id).toBe("gold6");
  });

  test("normalizes legacy run_queued events without an execution context to null", () => {
    const legacy = event(1, { type: "run_queued", request_id: "request_1", input: "initial", execution_context: null });
    // Events persisted before the frozen-context feature lack the key entirely.
    delete (legacy.payload as { execution_context?: unknown }).execution_context;

    const snapshot = reduceTaskEvents(metadata, [legacy]);

    expect(snapshot.runs[0]?.execution_context).toBeNull();
  });
});
