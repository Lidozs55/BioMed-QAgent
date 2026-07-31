import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAPIClient, type FetchLike } from "@/hooks/useAPI";
import type { TaskSnapshot } from "@/runtime/contracts";
import {
  RuntimeController,
  type EventTransport,
} from "@/runtime/controller";
import { createInitialRuntimeState } from "@/runtime/reducer";
import { useAgentStore } from "@/stores/agentStore";

const CREATED_AT = "2026-07-30T00:00:00Z";

function snapshot(latestSequence: number): TaskSnapshot {
  return {
    task: {
      task_id: "task_1",
      mode: "agent",
      databases: ["pubmed"],
      title: "Managed research",
      status: "running",
      active_run_id: "run_1",
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
      latest_sequence: latestSequence,
    },
    runs: [],
    messages: [],
    subagents: [
      {
        subagent_id: "subagent_1",
        task_id: "task_1",
        run_id: "run_1",
        agent_type: "source_research",
        objective: "Research PubMed",
        target_source: "pubmed",
        status: latestSequence === 1 ? "running" : "cancel_requested",
        parent_tool_call_id: "tool_1",
        created_at: CREATED_AT,
        started_at: CREATED_AT,
        finished_at: null,
        progress_current: 1,
        progress_total: 2,
        progress_message: "Searching",
        result_summary: null,
        source_asset_ids: [],
        recipe_id: null,
        error_code: null,
        error_message: null,
        pending_request_id: null,
      },
    ],
    older_messages_cursor: null,
  };
}

function transport(): EventTransport {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    subscribe: vi.fn(),
    isSubscribed: vi.fn().mockReturnValue(false),
    unsubscribeAndWait: vi.fn().mockResolvedValue(undefined),
    recoverSubscription: vi.fn().mockResolvedValue(undefined),
  };
}

describe("managed subagent frontend flow", () => {
  beforeEach(() => {
    useAgentStore.setState(createInitialRuntimeState());
    useAgentStore.getState().hydrateTaskSnapshot(snapshot(1));
    useAgentStore.getState().setActiveTaskId("task_1");
  });

  it("cancels the selected child through the exact endpoint and replays to the returned sequence", async () => {
    const cancelled = snapshot(2);
    const fetcher = vi.fn<FetchLike>(async (input) => {
      const url = String(input);
      if (url.endsWith("/subagents/subagent_1/cancel")) {
        return new Response(JSON.stringify(cancelled), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/events?after_sequence=1&limit=1000")) {
        return new Response(
          JSON.stringify({
            events: [
              {
                schema_version: "2.0",
                event_id: "event_cancel_requested",
                type: "subagent_cancel_requested",
                task_id: "task_1",
                run_id: "run_1",
                subagent_id: "subagent_1",
                parent_tool_call_id: "tool_1",
                stage_attempt_id: null,
                sequence: 2,
                timestamp: CREATED_AT,
                payload: {
                  type: "subagent_cancel_requested",
                  subagent_id: "subagent_1",
                  reason: null,
                },
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const controller = new RuntimeController(
      createAPIClient({ fetcher }),
      transport(),
    );

    await controller.cancelSubagent("task_1", "run_1", "subagent_1");

    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/tasks/task_1/runs/run_1/subagents/subagent_1/cancel",
      expect.objectContaining({ method: "POST" }),
    );
    expect(useAgentStore.getState().tasksById.task_1.lastSequence).toBe(2);
  });
});
