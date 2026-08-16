import { describe, expect, it, vi } from "vitest";

import { createAPIClient, type FetchLike } from "@/hooks/useAPI";
import { APIError } from "@/api/errors";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/* ---- resumeRun ---- */
describe("resumeRun", () => {
  it("accepts valid resume response", async () => {
    const snapshot = { task: { task_id: "t1", mode: "agent", databases: [], title: "", status: "awaiting_user_input", active_run_id: null, created_at: "", updated_at: "", latest_sequence: 1 }, runs: [{ run_id: "r1", task_id: "t1", request_id: "req1", status: "awaiting_user_input", input: "", created_at: "", updated_at: "", started_at: null, finished_at: null, error: null }], messages: [{ message_id: "m1", task_id: "t1", run_id: "r1", ordinal: 1, role: "user", content: "cont", created_at: "" }], older_messages_cursor: null };
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(snapshot));
    const api = createAPIClient({ fetcher });
    const result = await api.resumeRun("t1", "r1", { request_id: "req1", decision: "approve", detail: {} });
    expect(result.task.task_id).toBe("t1");
  });
});

/* ---- setDatabaseEnabled ---- */
describe("setDatabaseEnabled", () => {
  it("succeeds with 200 on enable", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(new Response("{}", { status: 200 }));
    const api = createAPIClient({ fetcher });
    await expect(api.setDatabaseEnabled("geo", true)).resolves.toBeUndefined();
  });

  it("posts to the disable endpoint", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(new Response("{}", { status: 200 }));
    const api = createAPIClient({ fetcher });
    await api.setDatabaseEnabled("geo", false);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/databases/geo/disable",
      { method: "POST" },
    );
  });
});

/* ---- fetchDatabases exact preservation ---- */
describe("fetchDatabases exact preservation", () => {
  it("preserves all fields from a valid database list response", async () => {
    const databases = [{ id: "pubmed", name: "PubMed", category: "discovery", description: "Papers", origin: "builtin", version: "1", pipeline_supported: true, available: true, enabled: true, capability: "pipeline_supported" }];
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ databases }));
    const api = createAPIClient({ fetcher });
    const result = await api.fetchDatabases();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("pubmed");
    expect(result[0].origin).toBe("builtin");
    expect(result[0].enabled).toBe(true);
    expect(result[0].capability).toBe("pipeline_supported");
  });
});

/* ---- saveSettings preserves response ---- */
describe("saveSettings preserves response", () => {
  it("returns parsed settings after save", async () => {
    const saved = { base_url: "https://example.com/v1", api_key: "sk-****", api_key_configured: true, model_name: "qwen-plus", max_tokens: 8192, context_window: 131072, context_window_source: "catalog", safety_reserve_ratio: 0.05, safety_reserve_tokens: 16384, compaction_trigger_ratio: 0.85, compaction_target_ratio: 0.60, available_input_tokens: 110592, advanced: { temperature: 0.7 } };
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(saved));
    const api = createAPIClient({ fetcher });
    const result = await api.saveSettings({ model_name: "qwen-plus" });
    expect(result.model_name).toBe("qwen-plus");
    expect(result.context_window_source).toBe("catalog");
    expect(result.advanced.temperature).toBe(0.7);
  });
});

/* ---- valid user_input_required event ---- */
describe("event payload valid construction", () => {
  it("accepts valid user_input_required event", async () => {
    const event = { schema_version: "2.0", event_id: "e1", type: "user_input_required", task_id: "t1", run_id: "r1", stage_attempt_id: null, sequence: 1, timestamp: "2024-01-01T00:00:00Z", payload: { type: "user_input_required", request_id: "req1", prompt_kind: "plan_confirmation", summary: "Approve plan?", expires_at: null, fixture_exempt: false, detail: {} } };
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ events: [event] }));
    const api = createAPIClient({ fetcher });
    const page = await api.fetchEvents("t1");
    expect(page).toHaveLength(1);
    expect(page[0].type).toBe("user_input_required");
  });

  it("rejects user_input_required with invalid prompt_kind", async () => {
    const event = { schema_version: "2.0", event_id: "e1", type: "user_input_required", task_id: "t1", run_id: "r1", stage_attempt_id: null, sequence: 1, timestamp: "2024-01-01T00:00:00Z", payload: { type: "user_input_required", request_id: "req1", prompt_kind: "invalid_kind", summary: "Approve plan?", expires_at: null, fixture_exempt: false, detail: {} } };
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ events: [event] }));
    const api = createAPIClient({ fetcher });
    await expect(api.fetchEvents("t1")).rejects.toThrow(APIError);
  });

  it.each([
    ["request_id", "nested_request", "t1", "r1"],
    ["task_id", "req1", "other_task", "r1"],
    ["run_id", "req1", "t1", "other_run"],
  ])("rejects a formal HIL event with mismatched nested %s", async (_field, requestId, taskId, runId) => {
    const event = {
      schema_version: "2.0",
      event_id: "e_hil_mismatch",
      type: "user_input_required",
      task_id: "t1",
      run_id: "r1",
      stage_attempt_id: null,
      sequence: 1,
      timestamp: "2024-01-01T00:00:00Z",
      payload: {
        type: "user_input_required",
        request_id: "req1",
        prompt_kind: "data_correction",
        summary: "Review mapping",
        expires_at: null,
        fixture_exempt: false,
        detail: {},
        hil_request: {
          schema_version: "1.0",
          request_id: requestId,
          task_id: taskId,
          run_id: runId,
          build_id: "build_1",
          kind: "semantic_review",
          review_type: "field_mapping",
          status: "pending",
          blocking: true,
          subject: { mapping_ids: ["map_1"] },
          review_items: [],
          summary: "Review mapping",
          evidence_digest: "a".repeat(64),
          policy_ref: "dataset.field_mapping.v1",
          created_at: "2024-01-01T00:00:00Z",
          resolved_at: null,
        },
      },
    };
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ events: [event] }));
    await expect(createAPIClient({ fetcher }).fetchEvents("t1")).rejects.toThrow(APIError);
  });

  it("rejects event with mismatched tool_started type", async () => {
    const event = { schema_version: "2.0", event_id: "e1", type: "tool_started", task_id: "t1", run_id: "r1", stage_attempt_id: null, sequence: 1, timestamp: "", payload: { type: "run_queued", request_id: "r1", input: "" } };
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ events: [event] }));
    const api = createAPIClient({ fetcher });
    await expect(api.fetchEvents("t1")).rejects.toThrow(APIError);
  });

  it("rejects stage_progress with missing kind", async () => {
    const event = { schema_version: "2.0", event_id: "e1", type: "stage_progress", task_id: "t1", run_id: "r1", stage_attempt_id: "sa1", sequence: 1, timestamp: "", payload: { type: "stage_progress", stage: "discovery", current: 5, total: null, detail: {} } };
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ events: [event] }));
    const api = createAPIClient({ fetcher });
    await expect(api.fetchEvents("t1")).rejects.toThrow(APIError);
  });

  it("accepts valid run_started event (no payload fields)", async () => {
    const event = { schema_version: "2.0", event_id: "e1", type: "run_started", task_id: "t1", run_id: "r1", stage_attempt_id: null, sequence: 2, timestamp: "2024-01-01T00:00:00Z", payload: { type: "run_started" } };
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ events: [event] }));
    const api = createAPIClient({ fetcher });
    const page = await api.fetchEvents("t1");
    expect(page).toHaveLength(1);
    expect(page[0].type).toBe("run_started");
  });
});
