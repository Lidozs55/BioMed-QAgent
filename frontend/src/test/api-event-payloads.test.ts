import { describe, expect, it } from "vitest";
import { parseEventPayload } from "@/lib/eventParsers";
import { assertRunStatus, assertTaskMode, assertMessageRole, assertEventType } from "@/lib/apiResponseParsers";
import { APIError } from "@/hooks/settingsContracts";

function o(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(data)) out[k] = data[k];
  return out;
}

/* ---- pipeline event family ---- */
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

  it("subagent_queued — validates required request fields and preserves forward-compatible fields", () => {
    const r = parseEventPayload(
      o({
        type: "subagent_queued",
        subagent_id: "subagent_1",
        request: {
          agent_type: "source_research",
          objective: "Find datasets",
          domain: "genomics",
          capability: "dataset_search",
          inputs: { gene: "TP53" },
          future_detail: "kept by the backend",
        },
        future_payload_detail: { version: 3 },
      }),
      "subagent_queued",
      "p",
    );
    if (r.type !== "subagent_queued") throw new Error();
    expect(r.request.objective).toBe("Find datasets");
  });

  it("subagent_progress — rejects missing subagent_id", () => {
    expect(() =>
      parseEventPayload(
        o({ type: "subagent_progress", current: 1, total: 2 }),
        "subagent_progress",
        "p",
      ),
    ).toThrow(APIError);
  });

  it("subagent_completed — validates terminal result fields", () => {
    const r = parseEventPayload(
      o({
        type: "subagent_completed",
        subagent_id: "subagent_1",
        result: {
          subagent_id: "subagent_1",
          status: "completed",
          summary: "Found source",
          source_asset_ids: ["source_1"],
          recipe_id: null,
          warnings: [],
          error_code: null,
          error_message: null,
        },
      }),
      "subagent_completed",
      "p",
    );
    if (r.type !== "subagent_completed") throw new Error();
    expect(r.result.source_asset_ids).toEqual(["source_1"]);
  });
});

/* ---- finite union parsers ---- */
describe("finite union parsers return narrowed literals", () => {
  it("assertRunStatus", () => { expect(assertRunStatus("queued", "p")).toBe("queued"); });
  it("assertTaskMode", () => { expect(assertTaskMode("agent", "p")).toBe("agent"); });
  it("assertMessageRole", () => { expect(assertMessageRole("user", "p")).toBe("user"); });
  it("assertEventType", () => { expect(assertEventType("run_queued", "p")).toBe("run_queued"); });
});
