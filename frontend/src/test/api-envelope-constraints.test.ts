import { describe, expect, it, vi } from "vitest";
import { createAPIClient, type FetchLike } from "@/hooks/useAPI";
import { APIError } from "@/hooks/settingsContracts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/* ---- I1: tool_completed with non-null tool_call_id is runtime-scoped ---- */
describe("tool_completed runtime scope via payload", () => {
  const tcPayload = (sv: string, rid: string | null) => [{
    schema_version: sv, event_id: "e1", type: "tool_completed",
    task_id: "t1", run_id: rid, stage_attempt_id: null, sequence: 1, timestamp: "",
    payload: { type: "tool_completed", tool_name: "search", tool_call_id: "tc1", output_digest: null, output: null, is_error: false },
  }];

  it("rejects schema 1.0 (requires 2.0)", async () => {
    await expect(createAPIClient({ fetcher: vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ events: tcPayload("1.0", null) })) }).fetchEvents("t1")).rejects.toThrow(APIError);
  });

  it("rejects without run_id", async () => {
    await expect(createAPIClient({ fetcher: vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ events: tcPayload("2.0", null) })) }).fetchEvents("t1")).rejects.toThrow(APIError);
  });

  it("accepts with schema 2.0 and run_id", async () => {
    const page = await createAPIClient({ fetcher: vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ events: tcPayload("2.0", "r1") })) }).fetchEvents("t1");
    expect(page).toHaveLength(1);
    expect(page[0].schema_version).toBe("2.0");
  });
});

/* ---- I1: warning with message+code (no warning record) is runtime-scoped ---- */
describe("warning runtime scope via payload", () => {
  const warnPayload = (sv: string, rid: string | null) => [{
    schema_version: sv, event_id: "e1", type: "warning",
    task_id: "t1", run_id: rid, stage_attempt_id: null, sequence: 1, timestamp: "",
    payload: { type: "warning", message: "something happened", code: "WARN001", warning: null },
  }];

  it("rejects schema 1.0 (requires 2.0)", async () => {
    await expect(createAPIClient({ fetcher: vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ events: warnPayload("1.0", null) })) }).fetchEvents("t1")).rejects.toThrow(APIError);
  });

  it("rejects without run_id", async () => {
    await expect(createAPIClient({ fetcher: vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ events: warnPayload("2.0", null) })) }).fetchEvents("t1")).rejects.toThrow(APIError);
  });

  it("accepts fixture-shaped warning (warning record) under schema 1.0 without run_id", async () => {
    const wr = { warning_id: "w1", severity: "warning", stage: "discovery", code: "C", message: "m", source_id: null, asset_id: null, record_id: null, created_at: "" };
    const events = [{ schema_version: "1.0", event_id: "e1", type: "warning", task_id: "t1", run_id: null, stage_attempt_id: null, sequence: 1, timestamp: "", payload: { type: "warning", warning: wr, message: null, code: null } }];
    const page = await createAPIClient({ fetcher: vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ events })) }).fetchEvents("t1");
    expect(page).toHaveLength(1);
  });

  it("accepts runtime warning under schema 2.0 with run_id", async () => {
    const page = await createAPIClient({ fetcher: vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ events: warnPayload("2.0", "r1") })) }).fetchEvents("t1");
    expect(page).toHaveLength(1);
    expect(page[0].run_id).toBe("r1");
  });
});

/* ---- I2: declarative manifest field-level constraints ---- */
describe("declarative manifest field constraints", () => {
  const man = {
    name: "s1", display_name: "S1", version: "1", category: "cat", description: "",
    origin: "package", supported_sources: [], operations: ["search"],
    enabled: true, user_selectable: true, pipeline_supported: false,
  };
  const baseDM = {
    schema_version: "1.0", name: "s1", display_name: "S1", version: "1",
    category: "cat", description: "desc", supported_sources: ["pubmed"],
    user_selectable: true, pipeline_supported: false, enabled: true, requirements: [],
    operations: [{ name: "search", description: "Search", method: "POST", url: "https://api.example.com/search", query: {}, headers: {}, body: null, timeout_seconds: 30, extract: null, auth: null }],
  };
  function dm(overrides: Record<string, unknown>) {
    return { manifest: man, current_version: "1", versions: ["1"], package_kind: "manifest", warning: null, available: true, load_error: null, declarative_manifest: { ...baseDM, ...overrides } };
  }

  it("rejects timeout_seconds > 120", async () => {
    const ops = [{ ...baseDM.operations[0], timeout_seconds: 121 }];
    const api = createAPIClient({ fetcher: vi.fn<FetchLike>().mockResolvedValue(jsonResponse(dm({ operations: ops }))) });
    await expect(api.fetchSkill("s1")).rejects.toThrow(APIError);
  });

  it("rejects timeout_seconds <= 0", async () => {
    const ops = [{ ...baseDM.operations[0], timeout_seconds: 0 }];
    const api = createAPIClient({ fetcher: vi.fn<FetchLike>().mockResolvedValue(jsonResponse(dm({ operations: ops }))) });
    await expect(api.fetchSkill("s1")).rejects.toThrow(APIError);
  });

  it("rejects auth reference with invalid pattern", async () => {
    const ops = [{ ...baseDM.operations[0], auth: { source: "env", reference: "bad-ref!", location: "header", name: "X-Key" } }];
    const api = createAPIClient({ fetcher: vi.fn<FetchLike>().mockResolvedValue(jsonResponse(dm({ operations: ops }))) });
    await expect(api.fetchSkill("s1")).rejects.toThrow(APIError);
  });

  it("rejects operation name with invalid pattern", async () => {
    const ops = [{ ...baseDM.operations[0], name: "Search-API" }];
    const api = createAPIClient({ fetcher: vi.fn<FetchLike>().mockResolvedValue(jsonResponse(dm({ operations: ops }))) });
    await expect(api.fetchSkill("s1")).rejects.toThrow(APIError);
  });

  it("rejects extract with invalid pattern", async () => {
    const ops = [{ ...baseDM.operations[0], extract: "$invalid chars!" }];
    const api = createAPIClient({ fetcher: vi.fn<FetchLike>().mockResolvedValue(jsonResponse(dm({ operations: ops }))) });
    await expect(api.fetchSkill("s1")).rejects.toThrow(APIError);
  });

  it("rejects invalid HTTP method", async () => {
    const ops = [{ ...baseDM.operations[0], method: "TRACE", query: {}, headers: {}, body: null, timeout_seconds: 30, extract: null, auth: null }];
    const api = createAPIClient({ fetcher: vi.fn<FetchLike>().mockResolvedValue(jsonResponse(dm({ operations: ops }))) });
    await expect(api.fetchSkill("s1")).rejects.toThrow(APIError);
  });

  it("accepts valid full manifest", async () => {
    const api = createAPIClient({ fetcher: vi.fn<FetchLike>().mockResolvedValue(jsonResponse(dm({}))) });
    const detail = await api.fetchSkill("s1");
    expect(detail.declarative_manifest?.operations[0].method).toBe("POST");
  });
});
