import { describe, expect, it, vi } from "vitest";

import { createAPIClient, type FetchLike } from "@/hooks/useAPI";
import { APIError } from "@/hooks/settingsContracts";

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

/* ---- setSkillEnabled ---- */
describe("setSkillEnabled", () => {
  it("succeeds with 200 on enable", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(new Response("{}", { status: 200 }));
    const api = createAPIClient({ fetcher });
    await expect(api.setSkillEnabled("s1", true)).resolves.toBeUndefined();
  });
});

/* ---- rollbackSkill ---- */
describe("rollbackSkill", () => {
  it("succeeds with 200", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(new Response("{}", { status: 200 }));
    const api = createAPIClient({ fetcher });
    await expect(api.rollbackSkill("s1")).resolves.toBeUndefined();
  });
});

/* ---- fetchSkills exact preservation ---- */
describe("fetchSkills exact preservation", () => {
  it("preserves all fields from valid skill list response", async () => {
    const skills = [{ name: "pubmed", display_name: "PubMed", version: "1", category: "discovery", description: "Papers", origin: "package", supported_sources: ["pubmed"], operations: ["search"], enabled: true, user_selectable: true, pipeline_supported: true, available: true, load_error: null }];
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ skills }));
    const api = createAPIClient({ fetcher });
    const result = await api.fetchSkills();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("pubmed");
    expect(result[0].origin).toBe("package");
    expect(result[0].available).toBe(true);
    expect(result[0].load_error).toBeNull();
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
