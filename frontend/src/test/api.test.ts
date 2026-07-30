import { describe, expect, it, vi } from "vitest";

import { APIError } from "@/hooks/settingsContracts";
import {
  createAPIClient,
  type FetchLike,
} from "@/hooks/useAPI";
import type {
  EventEnvelope,
  MessagePage,
  TaskPage,
  TaskRunAccepted,
  TaskSnapshot,
} from "@/runtime/contracts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const accepted: TaskRunAccepted = {
  schema_version: "1.0",
  request_id: "req_12345678-1234-1234-1234-123456789abc",
  task_id: "task_1",
  run_id: "run_1",
  status: "queued",
};

describe("runtime REST client", () => {
  it("creates a task with the approved body and exact request ID format", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(accepted, 202));
    const api = createAPIClient({
      fetcher,
      randomUUID: () => "12345678-1234-1234-1234-123456789abc",
    });

    await expect(
      api.createTask({
        input: "breast cancer gene expression",
        databases: ["pubmed", "geo"],
        mode: "fixture",
      }),
    ).resolves.toEqual(accepted);

    expect(fetcher).toHaveBeenCalledWith("/api/v1/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request_id: "req_12345678-1234-1234-1234-123456789abc",
        input: "breast cancer gene expression",
        databases: ["pubmed", "geo"],
        mode: "fixture",
      }),
    });
  });

  it("reuses the serialized body and request ID for one ambiguous retry", async () => {
    const fetcher = vi
      .fn<FetchLike>()
      .mockRejectedValueOnce(new TypeError("network reset"))
      .mockResolvedValueOnce(jsonResponse(accepted, 202));
    const api = createAPIClient({
      fetcher,
      randomUUID: () => "12345678-1234-1234-1234-123456789abc",
    });

    await api.createTask({ input: "question", databases: [], mode: "agent" });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][0]).toBe("/api/v1/tasks");
    expect(fetcher.mock.calls[1][0]).toBe("/api/v1/tasks");
    expect(fetcher.mock.calls[0][1]?.body).toBe(fetcher.mock.calls[1][1]?.body);
    expect(fetcher.mock.calls[0][1]?.body).toContain(
      '"request_id":"req_12345678-1234-1234-1234-123456789abc"',
    );
  });

  it("reuses an explicitly supplied request ID for a caller-owned retry", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(accepted, 202));
    const api = createAPIClient({ fetcher });

    await api.createTask(
      { input: "question", databases: [], mode: "agent" },
      { requestId: "req_12345678-1234-1234-1234-123456789abc" },
    );

    expect(fetcher.mock.calls[0][1]?.body).toContain(
      '"request_id":"req_12345678-1234-1234-1234-123456789abc"',
    );
  });

  it("surfaces continuation conflicts as typed errors without retry", async () => {
    const fetcher = vi
      .fn<FetchLike>()
      .mockResolvedValue(
        jsonResponse({ detail: "Task already has an active run" }, 409),
      );
    const api = createAPIClient({
      fetcher,
      randomUUID: () => "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    });

    const error = await api
      .continueTask("task/unsafe", { input: "follow up" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(APIError);
    expect(error).toMatchObject({
      status: 409,
      detail: "Task already has an active run",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("/api/v1/tasks/task%2Funsafe/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request_id: "req_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        input: "follow up",
      }),
    });
  });

  it("uses the authoritative page, snapshot, message, event, and cancel paths", async () => {
    const taskPage: TaskPage = {
      schema_version: "1.0",
      active_items: [],
      items: [],
      next_cursor: "next cursor",
    };
    const snapshot: TaskSnapshot = {
      schema_version: "1.0",
      task: {
        task_id: "task/1",
        mode: "agent",
        databases: [],
        title: "Task",
        status: "completed",
        active_run_id: null,
        created_at: "2026-07-14T00:00:00Z",
        updated_at: "2026-07-14T00:00:00Z",
        latest_sequence: 4,
      },
      runs: [],
      messages: [],
      older_messages_cursor: null,
    };
    const messagePage: MessagePage = {
      schema_version: "1.0",
      messages: [],
      next_cursor: null,
    };
    const event: EventEnvelope = {
      schema_version: "2.0",
      event_id: "event_1",
      type: "run_completed",
      task_id: "task/1",
      run_id: "run/1",
      stage_attempt_id: null,
      sequence: 4,
      timestamp: "2026-07-14T00:00:00Z",
      payload: { type: "run_completed" },
    };
    const normalizedSnapshot: TaskSnapshot = {
      ...snapshot,
      task: { ...snapshot.task, schema_version: undefined },
      subagents: snapshot.subagents ?? [],
    };
    const normalizedEvent: EventEnvelope = {
      ...event,
      subagent_id: null,
      parent_tool_call_id: null,
    };
    const fetcher = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(jsonResponse(taskPage))
      .mockResolvedValueOnce(jsonResponse(snapshot))
      .mockResolvedValueOnce(jsonResponse(messagePage))
      .mockResolvedValueOnce(jsonResponse({ events: [event] }))
      .mockResolvedValueOnce(jsonResponse(snapshot, 202))
      .mockResolvedValueOnce(jsonResponse(snapshot, 202));
    const api = createAPIClient({ fetcher });

    await expect(
      api.fetchTasks({ limit: 10, cursor: "next cursor" }),
    ).resolves.toEqual(taskPage);
    await expect(api.fetchTask("task/1")).resolves.toEqual(normalizedSnapshot);
    await expect(
      api.fetchMessages("task/1", { limit: 10, cursor: "older cursor" }),
    ).resolves.toEqual(messagePage);
    await expect(
      api.fetchEvents("task/1", { afterSequence: 3, limit: 20 }),
    ).resolves.toEqual([normalizedEvent]);
    await expect(api.cancelRun("task/1", "run/1")).resolves.toEqual(normalizedSnapshot);
    await expect(
      api.cancelSubagent("task/1", "run/1", "subagent/1"),
    ).resolves.toEqual(normalizedSnapshot);

    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/tasks?limit=10&cursor=next+cursor",
      "/api/v1/tasks/task%2F1",
      "/api/v1/tasks/task%2F1/messages?limit=10&cursor=older+cursor",
      "/api/v1/tasks/task%2F1/events?after_sequence=3&limit=20",
      "/api/v1/tasks/task%2F1/runs/run%2F1/cancel",
      "/api/v1/tasks/task%2F1/runs/run%2F1/subagents/subagent%2F1/cancel",
    ]);
  });

  it("keeps artifact list and download URLs keyed by artifact ID", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse({
        artifacts: [
          {
            artifact_id: "artifact/abc",
            name: "result.csv",
            size: 12,
            sha256: "a".repeat(64),
            media_type: "text/csv",
          },
        ],
      }),
    );
    const api = createAPIClient({ fetcher });

    await expect(api.fetchArtifacts("task/1")).resolves.toHaveLength(1);
    expect(api.getArtifactUrl("task/1", "artifact/abc")).toBe(
      "/api/v1/tasks/task%2F1/artifacts/artifact%2Fabc",
    );
  });

  it("builds the cache export URL without making a request", () => {
    const fetcher = vi.fn<FetchLike>();
    const api = createAPIClient({ fetcher });

    expect(api.getCacheExportUrl()).toBe("/api/v1/cache/export");
    // URL builder must not trigger a network call.
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("deletes a task only through the authoritative encoded DELETE endpoint", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    const api = createAPIClient({ fetcher });

    await expect(api.deleteTask("task/terminal")).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/tasks/task%2Fterminal",
      { method: "DELETE" },
    );
  });

});
