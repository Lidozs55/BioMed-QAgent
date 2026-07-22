import { describe, expect, it, vi } from "vitest";

import { createAPIClient, type FetchLike } from "@/hooks/useAPI";
import { APIError } from "@/hooks/settingsContracts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/* ------------------------------------------------------------------ */
/*  Malformed response tests for each non-settings response family     */
/*  Tests exercise the real createAPIClient boundary.                  */
/* ------------------------------------------------------------------ */

describe("task/admission response parsing", () => {
  it("rejects TaskRunAccepted with wrong status", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ status: "completed", request_id: "r1", task_id: "t1", run_id: "run1" }));
    const api = createAPIClient({ fetcher });
    await expect(api.createTask({ input: "test", databases: [], mode: "agent" })).rejects.toThrow(APIError);
  });

  it("rejects continueTask with wrong status", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ status: "failed", request_id: "r1", task_id: "t1", run_id: "run1" }));
    const api = createAPIClient({ fetcher });
    await expect(api.continueTask("t1", { input: "cont" })).rejects.toThrow(APIError);
  });

  it("rejects import admission with wrong status", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ status: "invalid", request_id: "r1", task_id: "t1", run_id: "run1" }));
    const api = createAPIClient({ fetcher });
    await expect(api.startImportTask({ files: [new File(["x"], "x.txt")] })).rejects.toThrow(APIError);
  });

  it("accepts valid TaskRunAccepted", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ status: "queued", request_id: "r1", task_id: "t1", run_id: "run1" }));
    const api = createAPIClient({ fetcher });
    const result = await api.createTask({ input: "test", databases: [], mode: "agent" });
    expect(result.status).toBe("queued");
    expect(result.task_id).toBe("t1");
  });
});

describe("task page/snapshot response parsing", () => {
  const validItem = { task_id: "t1", mode: "agent", databases: [], title: "", status: "completed", active_run_id: null, created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z", latest_sequence: 1 };

  it("rejects TaskPage with invalid mode", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ active_items: [{ ...validItem, mode: "invalid" }], items: [], next_cursor: null }));
    const api = createAPIClient({ fetcher });
    await expect(api.fetchTasks()).rejects.toThrow(APIError);
  });

  it("rejects TaskPage with invalid status", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ active_items: [{ ...validItem, status: "unknown_status" }], items: [], next_cursor: null }));
    const api = createAPIClient({ fetcher });
    await expect(api.fetchTasks()).rejects.toThrow(APIError);
  });

  it("rejects TaskSnapshot with invalid run status", async () => {
    const run = { run_id: "r1", task_id: "t1", request_id: "req1", status: "bogus_status", input: "", created_at: "", updated_at: "", started_at: null, finished_at: null, error: null };
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ task: validItem, runs: [run], messages: [], older_messages_cursor: null }));
    const api = createAPIClient({ fetcher });
    await expect(api.fetchTask("t1")).rejects.toThrow(APIError);
  });

  it("rejects cancelRun with invalid run status", async () => {
    const run = { run_id: "r1", task_id: "t1", request_id: "req1", status: "invalid", input: "", created_at: "", updated_at: "", started_at: null, finished_at: null, error: null };
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ task: validItem, runs: [run], messages: [], older_messages_cursor: null }));
    const api = createAPIClient({ fetcher });
    await expect(api.cancelRun("t1", "r1")).rejects.toThrow(APIError);
  });
});

describe("message page response parsing", () => {
  it("rejects MessagePage with invalid role", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ messages: [{ message_id: "m1", task_id: "t1", run_id: null, ordinal: 1, role: "systemish", content: "", created_at: "" }], next_cursor: null }));
    const api = createAPIClient({ fetcher });
    await expect(api.fetchMessages("t1")).rejects.toThrow(APIError);
  });

  it("rejects MessagePage with missing ordinal", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ messages: [{ message_id: "m1", task_id: "t1", run_id: null, role: "user", content: "", created_at: "" }], next_cursor: null }));
    const api = createAPIClient({ fetcher });
    await expect(api.fetchMessages("t1")).rejects.toThrow(APIError);
  });
});

describe("event page response parsing", () => {
  it("rejects EventPage with invalid schema_version", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ events: [{ schema_version: "3.0", event_id: "e1", type: "run_queued", task_id: "t1", run_id: null, stage_attempt_id: null, sequence: 1, timestamp: "", payload: {} }] }));
    const api = createAPIClient({ fetcher });
    await expect(api.fetchEvents("t1")).rejects.toThrow(APIError);
  });

  it("rejects EventPage with unknown event type", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ events: [{ schema_version: "1.0", event_id: "e1", type: "made_up_type", task_id: "t1", run_id: null, stage_attempt_id: null, sequence: 1, timestamp: "", payload: {} }] }));
    const api = createAPIClient({ fetcher });
    await expect(api.fetchEvents("t1")).rejects.toThrow(APIError);
  });

  it("rejects EventPage with mismatched payload type (envelope says run_queued, payload says stage_started)", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ events: [{ schema_version: "1.0", event_id: "e1", type: "run_queued", task_id: "t1", run_id: null, stage_attempt_id: null, sequence: 1, timestamp: "", payload: { type: "stage_started", stage: "discovery", attempt: 1 } }] }));
    const api = createAPIClient({ fetcher });
    await expect(api.fetchEvents("t1")).rejects.toThrow(APIError);
  });

  it("rejects EventPage with missing required payload field (run_queued missing request_id)", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ events: [{ schema_version: "1.0", event_id: "e1", type: "run_queued", task_id: "t1", run_id: null, stage_attempt_id: null, sequence: 1, timestamp: "", payload: { type: "run_queued" } }] }));
    const api = createAPIClient({ fetcher });
    await expect(api.fetchEvents("t1")).rejects.toThrow(APIError);
  });

  it("accepts valid EventPage with run_queued payload (runtime event requires 2.0+run_id)", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ events: [{ schema_version: "2.0", event_id: "e1", type: "run_queued", task_id: "t1", run_id: "r1", stage_attempt_id: null, sequence: 1, timestamp: "2024-01-01T00:00:00Z", payload: { type: "run_queued", request_id: "r1", input: "test" } }] }));
    const api = createAPIClient({ fetcher });
    const page = await api.fetchEvents("t1");
    expect(page).toHaveLength(1);
    expect(page[0].type).toBe("run_queued");
    expect(page[0].schema_version).toBe("2.0");
  });

  /* ---- Envelope invariant tests ---- */

  const baseEvent = (overrides: Record<string, unknown>) => [{ schema_version: "1.0", event_id: "e1", type: "run_queued", task_id: "t1", run_id: null, stage_attempt_id: null, sequence: 1, timestamp: "", payload: { type: "run_queued", request_id: "r1", input: "test" }, ...overrides }];
  const rej = (events: Record<string, unknown>[]) => expect(createAPIClient({ fetcher: vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ events })) }).fetchEvents("t1")).rejects.toThrow(APIError);

  it("rejects empty event_id", () => rej(baseEvent({ event_id: "" })));
  it("rejects empty task_id", () => rej(baseEvent({ task_id: "" })));
  it("rejects sequence 0 (<1)", () => rej(baseEvent({ sequence: 0 })));
  it("rejects stage event without stage_attempt_id", () => rej(baseEvent({ type: "stage_started", run_id: "r1", payload: { type: "stage_started", stage: "discovery", attempt: 1 } })));
  it("rejects runtime event with schema 1.0", () => rej(baseEvent({ type: "run_queued", run_id: "r1", payload: { type: "run_queued", request_id: "r1", input: "test" } })));
  it("rejects runtime event without run_id", () => rej([{ schema_version: "2.0", event_id: "e1", type: "run_queued", task_id: "t1", run_id: null, stage_attempt_id: null, sequence: 1, timestamp: "", payload: { type: "run_queued", request_id: "r1", input: "test" } }]));

  it("accepts valid runtime envelope (2.0, run_id, stage_attempt_id)", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ events: [{ schema_version: "2.0", event_id: "e1", type: "stage_started", task_id: "t1", run_id: "r1", stage_attempt_id: "sa1", sequence: 1, timestamp: "2024-01-01T00:00:00Z", payload: { type: "stage_started", stage: "discovery", attempt: 1 } }] }));
    const page = await createAPIClient({ fetcher }).fetchEvents("t1");
    expect(page).toHaveLength(1);
    expect(page[0].run_id).toBe("r1");
    expect(page[0].stage_attempt_id).toBe("sa1");
    expect(page[0].schema_version).toBe("2.0");
  });
});

describe("database envelope response parsing", () => {
  it("rejects database envelope with invalid origin", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ databases: [{ id: "d1", name: "D1", category: "cat", description: "", origin: "unknown_origin" }] }));
    const api = createAPIClient({ fetcher });
    await expect(api.fetchDatabases()).rejects.toThrow(APIError);
  });

  it("accepts valid database envelope", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ databases: [{ id: "d1", name: "D1", category: "cat", description: "desc" }] }));
    const api = createAPIClient({ fetcher });
    const dbs = await api.fetchDatabases();
    expect(dbs).toHaveLength(1);
    expect(dbs[0].id).toBe("d1");
  });
});

describe("artifact envelope response parsing", () => {
  it("rejects artifact envelope with missing size", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ artifacts: [{ artifact_id: "a1", name: "A1", sha256: "abc", media_type: "csv" }] }));
    const api = createAPIClient({ fetcher });
    await expect(api.fetchArtifacts("t1")).rejects.toThrow(APIError);
  });

  it("accepts valid artifact envelope", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ artifacts: [{ artifact_id: "a1", name: "A1", size: 100, sha256: "abc", media_type: "csv" }] }));
    const api = createAPIClient({ fetcher });
    const arts = await api.fetchArtifacts("t1");
    expect(arts).toHaveLength(1);
    expect(arts[0].name).toBe("A1");
  });
});

describe("skill envelope/detail/validation response parsing", () => {
  it("rejects skill envelope with invalid origin", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ skills: [{ name: "s1", display_name: "S1", version: "1", category: "cat", description: "", origin: "bad", supported_sources: [], operations: [], enabled: true, user_selectable: true, pipeline_supported: false }] }));
    const api = createAPIClient({ fetcher });
    await expect(api.fetchSkills()).rejects.toThrow(APIError);
  });

  it("rejects skill detail with invalid package_kind", async () => {
    const manifest = { name: "s1", display_name: "S1", version: "1", category: "cat", description: "", origin: "package", supported_sources: [], operations: [], enabled: true, user_selectable: true, pipeline_supported: false };
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ manifest, current_version: "1", versions: ["1"], package_kind: "exe", warning: null, available: true, load_error: null, declarative_manifest: null }));
    const api = createAPIClient({ fetcher });
    await expect(api.fetchSkill("s1")).rejects.toThrow(APIError);
  });

  it("rejects skill detail with malformed declarative manifest (missing operations)", async () => {
    const manifest = { name: "s1", display_name: "S1", version: "1", category: "cat", description: "", origin: "package", supported_sources: [], operations: [], enabled: true, user_selectable: true, pipeline_supported: false };
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ manifest, current_version: "1", versions: ["1"], package_kind: "manifest", warning: null, available: true, load_error: null, declarative_manifest: { name: "s1", display_name: "S1", version: "1", category: "cat", description: "", supported_sources: [], user_selectable: true, pipeline_supported: false } }));
    const api = createAPIClient({ fetcher });
    await expect(api.fetchSkill("s1")).rejects.toThrow(APIError);
  });

  it("rejects skill validation with wrong field type", async () => {
    const skill = { name: "s1", display_name: "S1", version: "1", category: "cat", description: "", origin: "package", supported_sources: [], operations: [], enabled: true, user_selectable: true, pipeline_supported: false };
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ valid: "maybe", skill }));
    const api = createAPIClient({ fetcher });
    await expect(api.validateSkill(new File([], "x.yaml"))).rejects.toThrow(APIError);
  });

  it("accepts valid skill detail with declarative manifest fields preserved", async () => {
    const manifest = { name: "s1", display_name: "S1", version: "1", category: "cat", description: "desc", origin: "package", supported_sources: ["pubmed"], operations: ["search"], enabled: true, user_selectable: true, pipeline_supported: false };
    const skillJson = { manifest, current_version: "1", versions: ["1"], package_kind: "manifest", warning: null, available: true, load_error: null, declarative_manifest: { schema_version: "1.0", name: "s1", display_name: "S1", version: "1", category: "cat", description: "desc", supported_sources: ["pubmed"], user_selectable: true, pipeline_supported: false, enabled: true, requirements: [], operations: [{ name: "search", description: "PubMed search", method: "POST", url: "https://api.example.com/search", query: {}, headers: {}, body: null, timeout_seconds: 30, extract: null, auth: null }] } };
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(skillJson));
    const api = createAPIClient({ fetcher });
    const detail = await api.fetchSkill("s1");
    expect(detail.manifest.name).toBe("s1");
    expect(detail.manifest.origin).toBe("package");
    expect(detail.package_kind).toBe("manifest");
    expect(detail.declarative_manifest?.operations).toHaveLength(1);
    expect(detail.declarative_manifest?.operations[0].method).toBe("POST");
    expect(detail.declarative_manifest?.pipeline_supported).toBe(false);
  });

  it("accepts valid skill validation", async () => {
    const skill = { name: "s1", display_name: "S1", version: "1", category: "cat", description: "desc", origin: "package", supported_sources: [], operations: [], enabled: true, user_selectable: true, pipeline_supported: false };
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ valid: true, skill, warning: null }));
    const api = createAPIClient({ fetcher });
    const result = await api.validateSkill(new File([], "x.yaml"));
    expect(result.valid).toBe(true);
    expect(result.skill.name).toBe("s1");
  });
});

/* ---- database create/delete ---- */
describe("database create/delete request paths", () => {
  it("calls createDatabase with correct URL and method", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(new Response("{}", { status: 200 }));
    const api = createAPIClient({ fetcher });
    const manifest = { schema_version: "1.0" as const, name: "test-db", display_name: "Test", version: "1", category: "discovery", description: "", supported_sources: ["test"], operations: [{ name: "search", description: "Search", method: "GET" as const, url: "https://api.example.com/search", query: {}, headers: {}, body: null, timeout_seconds: 30, extract: null, auth: null }], user_selectable: true, pipeline_supported: false as const, enabled: true, requirements: [] };
    await api.createDatabase(manifest);
    expect(fetcher).toHaveBeenCalledWith("/api/v1/databases", expect.objectContaining({ method: "POST" }));
  });

  it("calls deleteDatabase with correct URL and method", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(new Response("{}", { status: 200 }));
    const api = createAPIClient({ fetcher });
    await api.deleteDatabase("test-db");
    expect(fetcher).toHaveBeenCalledWith("/api/v1/databases/test-db", expect.objectContaining({ method: "DELETE" }));
  });
});

/* ---- startImportTask valid multipart ---- */
describe("startImportTask multipart request", () => {
  it("sends FormData body with request_id, input, ordered files identity and no Content-Type header", async () => {
    const appendSpy = vi.spyOn(FormData.prototype, "append");
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ status: "queued", request_id: "req_abc", task_id: "t1", run_id: "r1" }));
    const api = createAPIClient({ fetcher, randomUUID: () => "abc" });
    const fileA = new File(["a"], "a.csv", { type: "text/csv" });
    const fileB = new File(["b"], "b.csv", { type: "text/csv" });
    const result = await api.startImportTask({ files: [fileA, fileB], note: "my note" });
    expect(result.task_id).toBe("t1");
    expect(appendSpy).toHaveBeenCalledWith("files", fileA, fileA.name);
    expect(appendSpy).toHaveBeenCalledWith("files", fileB, fileB.name);
    const calls = fetcher.mock.calls[0];
    if (calls === undefined) throw new Error("Expected fetch call");
    const [, init] = calls;
    if (init === undefined) throw new Error("Expected init object");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.headers).toBeUndefined();
    if (init.body instanceof FormData) {
      expect(init.body.get("request_id")).toBe("req_abc");
      expect(init.body.get("input")).toBe("my note");
      const entries = init.body.getAll("files");
      expect(entries).toHaveLength(2);
    }
    appendSpy.mockRestore();
  });
});

describe("uploadSkill body", () => {
  it("sends FormData body with the exact file identity to upload", async () => {
    const setSpy = vi.spyOn(FormData.prototype, "set");
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(new Response("{}", { status: 200 }));
    const api = createAPIClient({ fetcher });
    const file = new File(['{"name":"test"}'], "test-skill.yaml", { type: "application/x-yaml" });
    await api.uploadSkill(file);
    expect(setSpy).toHaveBeenCalledWith("file", file, file.name);
    const calls = fetcher.mock.calls[0];
    if (calls === undefined) throw new Error("Expected fetch call");
    const [, init] = calls;
    if (init === undefined) throw new Error("Expected init object");
    expect(init.method).toBe("POST");
    expect(init.headers).toBeUndefined();
    expect(init.body).toBeInstanceOf(FormData);
    setSpy.mockRestore();
  });
});
