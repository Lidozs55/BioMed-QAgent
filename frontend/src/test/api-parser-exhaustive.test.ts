import { describe, expect, it, vi } from "vitest";
import { parseEventPayload } from "@/lib/eventParsers";
import { assertRunStatus, assertTaskMode, assertMessageRole, assertEventType } from "@/lib/apiResponseParsers";
import { assertDeclarativeManifest } from "@/lib/apiEnvelopeParsers";
import { createAPIClient, type FetchLike } from "@/hooks/useAPI";
import { APIError } from "@/hooks/settingsContracts";

function o(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(data)) out[k] = data[k];
  return out;
}

/* ---- Finding 1: event payload field-level validation ---- */
describe("parseEventPayload — pipeline event family", () => {
  it("plan_ready — rejects missing specification", () => {
    expect(() => parseEventPayload(o({ type: "plan_ready" }), "plan_ready", "p")).toThrow(APIError);
  });

  it("plan_ready — accepts valid specification", () => {
    const r = parseEventPayload(o({ type: "plan_ready", specification: { foo: "bar" } }), "plan_ready", "p");
    expect(r.type).toBe("plan_ready");
  });

  it("stage_completed — rejects non-hex output_digest", () => {
    expect(() => parseEventPayload(o({ type: "stage_completed", stage: "discovery", output_digest: "not-hex" }), "stage_completed", "p")).toThrow(APIError);
  });

  it("stage_progress — preserves total and detail fields", () => {
    const r = parseEventPayload(o({ type: "stage_progress", stage: "acquisition", kind: "download", current: 5, total: 10, detail: { url: "x" } }), "stage_progress", "p");
    if (r.type !== "stage_progress") throw new Error();
    expect(r.total).toBe(10);
    const detail = r.detail;
    if (typeof detail !== "object" || detail === null) throw new Error("Expected object detail");
    expect("url" in detail && detail.url).toBe("x");
  });

  it("stage_failed — rejects missing error", () => {
    expect(() => parseEventPayload(o({ type: "stage_failed", stage: "discovery" }), "stage_failed", "p")).toThrow(APIError);
  });

  it("stage_failed — accepts valid error detail", () => {
    const r = parseEventPayload(o({ type: "stage_failed", stage: "processing", status: "failed", error: { code: "ERR", message: "fail", retryable: false, stage: null, details: {} } }), "stage_failed", "p");
    if (r.type !== "stage_failed") throw new Error();
    expect(r.error.code).toBe("ERR");
  });

  it("user_input_required — preserves expires_at and detail", () => {
    const r = parseEventPayload(o({ type: "user_input_required", request_id: "r1", prompt_kind: "plan_confirmation", summary: "s", expires_at: "2024-01-01T00:00:00Z", fixture_exempt: false, detail: { key: "val" } }), "user_input_required", "p");
    if (r.type !== "user_input_required") throw new Error();
    expect(r.expires_at).toBe("2024-01-01T00:00:00Z");
    const detail = r.detail;
    if (typeof detail !== "object" || detail === null) throw new Error("Expected object detail");
    expect("key" in detail && detail.key).toBe("val");
  });

  it("user_input_resumed — preserves detail", () => {
    const r = parseEventPayload(o({ type: "user_input_resumed", request_id: "r1", decision: "approve", detail: { key: "val" } }), "user_input_resumed", "p");
    if (r.type !== "user_input_resumed") throw new Error();
    const detail = r.detail;
    if (typeof detail !== "object" || detail === null) throw new Error("Expected object detail");
    expect("key" in detail && detail.key).toBe("val");
  });

  it("stage_skipped — preserves reused_stage_attempt_id", () => {
    const r = parseEventPayload(o({ type: "stage_skipped", stage: "discovery", status: "skipped", reason: "no data", reused_stage_attempt_id: "sa1" }), "stage_skipped", "p");
    if (r.type !== "stage_skipped") throw new Error();
    expect(r.reused_stage_attempt_id).toBe("sa1");
  });

  it("warning — rejects neither warning record nor message+code", () => {
    expect(() => parseEventPayload(o({ type: "warning" }), "warning", "p")).toThrow(APIError);
  });

  it("warning — accepts fixture shape with warning record", () => {
    const wr = { warning_id: "w1", severity: "warning", stage: "discovery", code: "C", message: "m", source_id: null, asset_id: null, record_id: null, created_at: "" } as const;
    const r = parseEventPayload(o({ type: "warning", warning: wr }), "warning", "p");
    if (r.type !== "warning") throw new Error();
    if (r.warning) expect(r.warning.warning_id).toBe("w1");
  });

  it("task_completed — validates validation summary", () => {
    const val = { status: "valid", checked_count: 5, failed_count: 0, report_path: "/r" } as const;
    const r = parseEventPayload(o({ type: "task_completed", validation: val }), "task_completed", "p");
    if (r.type !== "task_completed") throw new Error();
    expect(r.validation.checked_count).toBe(5);
  });
});

describe("parseEventPayload — runtime event family", () => {
  it("tool_started — preserves arguments optional", () => {
    const r = parseEventPayload(o({ type: "tool_started", tool_call_id: "tc1", tool_name: "search", arguments: { query: "cancer" } }), "tool_started", "p");
    if (r.type !== "tool_started") throw new Error();
    expect(r.arguments).toEqual({ query: "cancer" });
  });

  it("tool_started — accepts null arguments", () => {
    const r = parseEventPayload(o({ type: "tool_started", tool_call_id: "tc2", tool_name: "search" }), "tool_started", "p");
    if (r.type !== "tool_started") throw new Error();
    expect(r.arguments).toBeNull();
  });

  it("assistant_delta — accepts minimal delta without stream metadata", () => {
    const r = parseEventPayload(o({ type: "assistant_delta", delta: "text" }), "assistant_delta", "p");
    if (r.type !== "assistant_delta") throw new Error();
    expect(r.delta).toBe("text");
  });

  it("run_cancel_requested — validates reason is optional string|null", () => {
    const r = parseEventPayload(o({ type: "run_cancel_requested", reason: "manual" }), "run_cancel_requested", "p");
    if (r.type !== "run_cancel_requested") throw new Error();
    expect(r.reason).toBe("manual");
  });

  it("conversation_compacted — validates summary_digest is hex", () => {
    expect(() => parseEventPayload(o({ type: "conversation_compacted", covered_through_run_id: "r1", summary_digest: "bad" }), "conversation_compacted", "p")).toThrow(APIError);
  });

  it("run_queued — validates input is non-empty", () => {
    expect(() => parseEventPayload(o({ type: "run_queued", request_id: "r1", input: "" }), "run_queued", "p")).toThrow(APIError);
  });
});

/* ---- Finding 2: finite union parsers use explicit branches ---- */
describe("finite union parsers return narrowed literals", () => {
  it("assertRunStatus", () => { expect(assertRunStatus("queued", "p")).toBe("queued"); });
  it("assertTaskMode", () => { expect(assertTaskMode("agent", "p")).toBe("agent"); });
  it("assertMessageRole", () => { expect(assertMessageRole("user", "p")).toBe("user"); });
  it("assertEventType", () => { expect(assertEventType("run_queued", "p")).toBe("run_queued"); });
});

/* ---- Finding 3: declarative manifest field preservation ---- */
describe("assertDeclarativeManifest field preservation", () => {
  it("parses schema_version from response", () => {
    const m = assertDeclarativeManifest({
      schema_version: "1.0", name: "s1", display_name: "S1", version: "1",
      category: "discovery", description: "desc", supported_sources: [],
      operations: [{ name: "search", description: "Search", method: "POST", url: "https://x.com/api", query: {}, headers: {}, body: null, timeout_seconds: 30, extract: null, auth: null }],
      user_selectable: true, pipeline_supported: false, enabled: true, requirements: [],
    }, "d");
    expect(m?.schema_version).toBe("1.0");
  });

  it("rejects missing schema_version", () => {
    expect(() => assertDeclarativeManifest({
      name: "s1", display_name: "S1", version: "1",
      category: "discovery", description: "desc", supported_sources: [],
      operations: [{ name: "search", description: "Search", method: "POST", url: "https://x.com/api" }],
      user_selectable: true, pipeline_supported: false,
    }, "d")).toThrow(APIError);
  });

  it("parses pipeline_supported from response", () => {
    const m = assertDeclarativeManifest({
      schema_version: "1.0", name: "s1", display_name: "S1", version: "1",
      category: "discovery", description: "desc", supported_sources: [],
      operations: [{ name: "search", description: "Search", method: "POST", url: "https://x.com/api", query: {}, headers: {}, body: null, timeout_seconds: 30, extract: null, auth: null }],
      user_selectable: true, pipeline_supported: false, enabled: true, requirements: [],
    }, "d");
    expect(m?.pipeline_supported).toBe(false);
  });

  it("preserves operation query/headers/body/timeout_seconds/extract", () => {
    const m = assertDeclarativeManifest({
      schema_version: "1.0", name: "s1", display_name: "S1", version: "1",
      category: "discovery", description: "desc", supported_sources: [],
      operations: [{ name: "search", description: "Search", method: "POST", url: "https://x.com/api", query: { q: "test" }, headers: { "X-Api": "key" }, body: { input: "x" }, timeout_seconds: 60, extract: "data.results", auth: null }],
      user_selectable: true, pipeline_supported: false, enabled: true, requirements: [],
    }, "d");
    expect(m?.operations[0].query).toEqual({ q: "test" });
    expect(m?.operations[0].headers).toEqual({ "X-Api": "key" });
    expect(m?.operations[0].body).toEqual({ input: "x" });
    expect(m?.operations[0].timeout_seconds).toBe(60);
    expect(m?.operations[0].extract).toBe("data.results");
  });

  it("preserves enabled field", () => {
    const m = assertDeclarativeManifest({
      schema_version: "1.0", name: "s1", display_name: "S1", version: "1",
      category: "discovery", description: "desc", supported_sources: [],
      operations: [{ name: "search", description: "Search", method: "POST", url: "https://x.com/api", query: {}, headers: {}, body: null, timeout_seconds: 30, extract: null, auth: null }],
      user_selectable: true, pipeline_supported: false, enabled: false, requirements: [],
    }, "d");
    expect(m?.enabled).toBe(false);
  });

  it("rejects stage_started with non-positive attempt", () => {
    expect(() => parseEventPayload(o({ type: "stage_started", stage: "discovery", attempt: 0 }), "stage_started", "p")).toThrow(APIError);
  });

  it("rejects stage_progress with negative current", () => {
    expect(() => parseEventPayload(o({ type: "stage_progress", stage: "discovery", kind: "parse", current: -1, total: null, detail: {} }), "stage_progress", "p")).toThrow(APIError);
  });

  it("rejects assistant_delta with from_chunk_index > through_chunk_index", () => {
    expect(() => parseEventPayload(o({ type: "assistant_delta", delta: "text", stream_id: "s1", from_chunk_index: 5, through_chunk_index: 2 }), "assistant_delta", "p")).toThrow(APIError);
  });

  it("stage_completed/failed/skipped validates wire status", () => {
    expect(() => parseEventPayload(o({ type: "stage_completed", stage: "discovery", status: "failed", output_digest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }), "stage_completed", "p")).toThrow(APIError);
    expect(() => parseEventPayload(o({ type: "stage_failed", stage: "discovery", status: "succeeded", error: { code: "ERR", message: "fail", retryable: false, stage: null, details: {} } }), "stage_failed", "p")).toThrow(APIError);
    expect(() => parseEventPayload(o({ type: "stage_skipped", stage: "discovery", status: "failed", reason: "no data", reused_stage_attempt_id: null }), "stage_skipped", "p")).toThrow(APIError);
  });

  it("preserves operation auth field", () => {
    const m = assertDeclarativeManifest({
      schema_version: "1.0", name: "s1", display_name: "S1", version: "1",
      category: "discovery", description: "desc", supported_sources: [],
      operations: [{ name: "search", description: "Search", method: "POST", url: "https://x.com/api", query: {}, headers: {}, body: null, timeout_seconds: 30, extract: null, auth: { source: "env", reference: "API_KEY", location: "header", name: "X-Key", prefix: "Bearer " } }],
      user_selectable: true, pipeline_supported: false, enabled: true, requirements: [],
    }, "d");
    expect(m?.operations[0].auth).toBeDefined();
    expect(m?.operations[0].auth?.reference).toBe("API_KEY");
    expect(m?.operations[0].auth?.location).toBe("header");
    expect(m?.operations[0].auth?.prefix).toBe("Bearer ");
  });

  /* ---- RED tests for missing packages.py constraints ---- */

  it("RED: rejects URL with ws:// scheme (HTTP required)", () => {
    expect(() => assertDeclarativeManifest({
      schema_version: "1.0", name: "s1", display_name: "S1", version: "1",
      category: "discovery", description: "desc", supported_sources: [],
      operations: [{ name: "search", description: "Search", method: "GET", url: "ws://x.com/api", query: {}, headers: {}, body: null, timeout_seconds: 30, extract: null, auth: null }],
      user_selectable: true, pipeline_supported: false, enabled: true, requirements: [],
    }, "d")).toThrow(APIError);
  });

  it("RED: rejects URL with embedded credentials", () => {
    expect(() => assertDeclarativeManifest({
      schema_version: "1.0", name: "s1", display_name: "S1", version: "1",
      category: "discovery", description: "desc", supported_sources: [],
      operations: [{ name: "search", description: "Search", method: "GET", url: "https://user:pass@x.com/api", query: {}, headers: {}, body: null, timeout_seconds: 30, extract: null, auth: null }],
      user_selectable: true, pipeline_supported: false, enabled: true, requirements: [],
    }, "d")).toThrow(APIError);
  });

  it("RED: rejects localhost URL", () => {
    expect(() => assertDeclarativeManifest({
      schema_version: "1.0", name: "s1", display_name: "S1", version: "1",
      category: "discovery", description: "desc", supported_sources: [],
      operations: [{ name: "search", description: "Search", method: "GET", url: "http://localhost:8080/api", query: {}, headers: {}, body: null, timeout_seconds: 30, extract: null, auth: null }],
      user_selectable: true, pipeline_supported: false, enabled: true, requirements: [],
    }, "d")).toThrow(APIError);
  });

  it("RED: rejects header name containing CR", () => {
    expect(() => assertDeclarativeManifest({
      schema_version: "1.0", name: "s1", display_name: "S1", version: "1",
      category: "discovery", description: "desc", supported_sources: [],
      operations: [{ name: "search", description: "Search", method: "GET", url: "https://x.com/api", query: {}, headers: { "Content-Type\rInjected": "x" }, body: null, timeout_seconds: 30, extract: null, auth: null }],
      user_selectable: true, pipeline_supported: false, enabled: true, requirements: [],
    }, "d")).toThrow(APIError);
  });

  it("RED: rejects header name containing LF", () => {
    expect(() => assertDeclarativeManifest({
      schema_version: "1.0", name: "s1", display_name: "S1", version: "1",
      category: "discovery", description: "desc", supported_sources: [],
      operations: [{ name: "search", description: "Search", method: "GET", url: "https://x.com/api", query: {}, headers: { "X-Custom\nEvil": "x" }, body: null, timeout_seconds: 30, extract: null, auth: null }],
      user_selectable: true, pipeline_supported: false, enabled: true, requirements: [],
    }, "d")).toThrow(APIError);
  });

  it("RED: rejects header name with placeholder braces", () => {
    expect(() => assertDeclarativeManifest({
      schema_version: "1.0", name: "s1", display_name: "S1", version: "1",
      category: "discovery", description: "desc", supported_sources: [],
      operations: [{ name: "search", description: "Search", method: "GET", url: "https://x.com/api", query: {}, headers: { "X-{user}": "x" }, body: null, timeout_seconds: 30, extract: null, auth: null }],
      user_selectable: true, pipeline_supported: false, enabled: true, requirements: [],
    }, "d")).toThrow(APIError);
  });

  it("RED: rejects manifest name not matching ^[a-z][a-z0-9_]*$", () => {
    expect(() => assertDeclarativeManifest({
      schema_version: "1.0", name: "MySkill", display_name: "S1", version: "1",
      category: "discovery", description: "desc", supported_sources: [],
      operations: [{ name: "search", description: "Search", method: "GET", url: "https://x.com/api", query: {}, headers: {}, body: null, timeout_seconds: 30, extract: null, auth: null }],
      user_selectable: true, pipeline_supported: false, enabled: true, requirements: [],
    }, "d")).toThrow(APIError);
  });

  it("RED: rejects duplicate operation names", () => {
    expect(() => assertDeclarativeManifest({
      schema_version: "1.0", name: "s1", display_name: "S1", version: "1",
      category: "discovery", description: "desc", supported_sources: [],
      operations: [
        { name: "search", description: "Search", method: "GET", url: "https://x.com/api", query: {}, headers: {}, body: null, timeout_seconds: 30, extract: null, auth: null },
        { name: "search", description: "Search again", method: "POST", url: "https://x.com/api2", query: {}, headers: {}, body: null, timeout_seconds: 30, extract: null, auth: null },
      ],
      user_selectable: true, pipeline_supported: false, enabled: true, requirements: [],
    }, "d")).toThrow(APIError);
  });

  it("RED: rejects declarative manifest with non-empty requirements", () => {
    expect(() => assertDeclarativeManifest({
      schema_version: "1.0", name: "s1", display_name: "S1", version: "1",
      category: "discovery", description: "desc", supported_sources: [],
      operations: [{ name: "search", description: "Search", method: "GET", url: "https://x.com/api", query: {}, headers: {}, body: null, timeout_seconds: 30, extract: null, auth: null }],
      user_selectable: true, pipeline_supported: false, enabled: true, requirements: ["numpy"],
    }, "d")).toThrow(APIError);
  });

  it("RED: rejects empty display_name", () => {
    expect(() => assertDeclarativeManifest({
      schema_version: "1.0", name: "s1", display_name: "", version: "1",
      category: "discovery", description: "desc", supported_sources: [],
      operations: [{ name: "search", description: "Search", method: "GET", url: "https://x.com/api", query: {}, headers: {}, body: null, timeout_seconds: 30, extract: null, auth: null }],
      user_selectable: true, pipeline_supported: false, enabled: true, requirements: [],
    }, "d")).toThrow(APIError);
  });

  it("RED: rejects empty description", () => {
    expect(() => assertDeclarativeManifest({
      schema_version: "1.0", name: "s1", display_name: "S1", version: "1",
      category: "discovery", description: "", supported_sources: [],
      operations: [{ name: "search", description: "Search", method: "GET", url: "https://x.com/api", query: {}, headers: {}, body: null, timeout_seconds: 30, extract: null, auth: null }],
      user_selectable: true, pipeline_supported: false, enabled: true, requirements: [],
    }, "d")).toThrow(APIError);
  });

  it("RED: rejects empty version", () => {
    expect(() => assertDeclarativeManifest({
      schema_version: "1.0", name: "s1", display_name: "S1", version: "",
      category: "discovery", description: "desc", supported_sources: [],
      operations: [{ name: "search", description: "Search", method: "GET", url: "https://x.com/api", query: {}, headers: {}, body: null, timeout_seconds: 30, extract: null, auth: null }],
      user_selectable: true, pipeline_supported: false, enabled: true, requirements: [],
    }, "d")).toThrow(APIError);
  });
});

/* ---- Finding 3: multipart File identity via actual RequestInit.body ---- */
describe("uploadSkill exact File identity via fetch body", () => {
  it("captures exact File reference from actual FormData body", async () => {
    const setSpy = vi.spyOn(FormData.prototype, "set");
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(new Response("{}", { status: 200 }));
    const api = createAPIClient({ fetcher });
    const file = new File(['{"name":"test"}'], "test-skill.yaml", { type: "application/x-yaml" });

    await api.uploadSkill(file);
    expect(setSpy).toHaveBeenCalledWith("file", file, file.name);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const call = fetcher.mock.calls[0];
    expect(call).toBeDefined();
    const [url, init] = call;
    expect(url).toBe("/api/v1/skills/upload");
    if (init === undefined) throw new Error("Expected init object");
    expect(init.method).toBe("POST");
    expect(init.headers).toBeUndefined();
    expect(init.body).toBeInstanceOf(FormData);
    setSpy.mockRestore();
  });
});

describe("startImportTask FormData fields via fetch body", () => {
  it("includes request_id, input, and files fields with exact File objects", async () => {
    const appendSpy = vi.spyOn(FormData.prototype, "append");
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(new Response(JSON.stringify({ status: "queued", request_id: "req_abc", task_id: "t1", run_id: "r1" }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const api = createAPIClient({ fetcher, randomUUID: () => "custom" });
    const fileA = new File(["a"], "a.csv", { type: "text/csv" });
    const fileB = new File(["b"], "b.csv", { type: "text/csv" });

    await api.startImportTask({ files: [fileA, fileB], note: "my note" });
    expect(appendSpy).toHaveBeenCalledWith("files", fileA, fileA.name);
    expect(appendSpy).toHaveBeenCalledWith("files", fileB, fileB.name);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const call = fetcher.mock.calls[0];
    expect(call).toBeDefined();
    const [url, init] = call;
    expect(url).toBe("/api/v1/import/tasks");
    if (init === undefined) throw new Error("Expected init object");
    expect(init.method).toBe("POST");
    expect(init.headers).toBeUndefined();
    expect(init.body).toBeInstanceOf(FormData);
    if (init.body instanceof FormData) {
      expect(init.body.get("request_id")).toBe("req_custom");
      expect(init.body.get("input")).toBe("my note");
      const entries = init.body.getAll("files");
      expect(entries).toHaveLength(2);
    }
    appendSpy.mockRestore();
  });

  it("trims note before sending via actual FormData body", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(new Response(JSON.stringify({ status: "queued", request_id: "req_abc", task_id: "t1", run_id: "r1" }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const api = createAPIClient({ fetcher, randomUUID: () => "trim" });

    await api.startImportTask({ files: [], note: "  padded note  " });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const call = fetcher.mock.calls[0];
    expect(call).toBeDefined();
    const [, init] = call;
    if (init === undefined) throw new Error("Expected init object");
    expect(init.body).toBeInstanceOf(FormData);
    if (init.body instanceof FormData) {
      expect(init.body.get("input")).toBe("padded note");
    }
  });
});
