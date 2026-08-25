import { describe, expect, it } from "vitest";
import { parseEventPayload } from "@/lib/eventParsers";
import { assertRunStatus, assertTaskMode, assertMessageRole, assertEventType, parseEventPage } from "@/lib/apiResponseParsers";
import { APIError } from "@/api/errors";

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

  it("user_input_required — parses a formal durable HIL request", () => {
    const digest = "a".repeat(64);
    const r = parseEventPayload(o({
      type: "user_input_required",
      request_id: "hil_1",
      prompt_kind: "data_correction",
      summary: "review mapping",
      expires_at: null,
      fixture_exempt: false,
      detail: { review_type: "field_mapping" },
      hil_request: {
        request_id: "hil_1",
        task_id: "task_1",
        run_id: "run_1",
        build_id: "build_1",
        kind: "semantic_review",
        review_type: "field_mapping",
        status: "pending",
        blocking: true,
        subject: { mapping_ids: ["map_1"] },
        review_items: [],
        summary: "review mapping",
        evidence_digest: digest,
        policy_ref: "dataset.field_mapping.v1",
        created_at: "2026-08-16T00:00:00Z",
        resolved_at: null,
      },
    }), "user_input_required", "p");
    if (r.type !== "user_input_required") throw new Error();
    expect(r.hil_request).toMatchObject({
      request_id: "hil_1",
      evidence_digest: digest,
      review_type: "field_mapping",
    });
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

  it("task_completed — parses optional build_result with binding failures", () => {
    const r = parseEventPayload(
      o({
        type: "task_completed",
        validation: { status: "invalid", checked_count: 1, failed_count: 1, report_path: "/r" },
        build_result: {
          status: "no_data",
          valid_row_count: 0,
          successful_sources: [],
          rejected_sources: ["gse"],
          available_artifact_roles: [],
          publication_id: null,
          reason_codes: ["no_primary_data"],
          user_summary: "",
          recommended_next_action: "",
          build_id: "build_task_1",
          binding_failures: [
            { binding_id: "gse", reason_code: "empty_series_matrix", message: "metadata only" },
          ],
        },
      }),
      "task_completed",
      "p",
    );
    if (r.type !== "task_completed") throw new Error();
    expect(r.build_result?.build_id).toBe("build_task_1");
    expect(r.build_result?.binding_failures).toEqual([
      { binding_id: "gse", reason_code: "empty_series_matrix", message: "metadata only" },
    ]);
  });

  it("task_completed — build_result absent yields null", () => {
    const r = parseEventPayload(o({ type: "task_completed", validation: { status: "valid", checked_count: 1, failed_count: 0, report_path: "/r" } }), "task_completed", "p");
    if (r.type !== "task_completed") throw new Error();
    expect(r.build_result).toBeNull();
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
    expect(() => parseEventPayload(o({ type: "conversation_compacted", compaction_id: "c1", covered_through_run_id: "r1", summary_digest: "bad" }), "conversation_compacted", "p")).toThrow(APIError);
  });

  it("conversation_compaction_started — parses a compact request status", () => {
    const r = parseEventPayload(
      o({ type: "conversation_compaction_started", compaction_id: "c1", covered_through_run_id: "r1" }),
      "conversation_compaction_started",
      "p",
    );
    expect(r).toEqual({
      type: "conversation_compaction_started",
      compaction_id: "c1",
      covered_through_run_id: "r1",
    });
  });

  it("conversation_compaction_failed — accepts no_content and error reasons", () => {
    const noContent = parseEventPayload(
      o({
        type: "conversation_compaction_failed",
        compaction_id: "c1",
        covered_through_run_id: "r1",
        reason: "no_content",
        message: "Nothing to compact",
      }),
      "conversation_compaction_failed",
      "p",
    );
    expect(noContent).toEqual({
      type: "conversation_compaction_failed",
      compaction_id: "c1",
      covered_through_run_id: "r1",
      reason: "no_content",
      message: "Nothing to compact",
    });
    expect(() => parseEventPayload(
      o({
        type: "conversation_compaction_failed",
        compaction_id: "c1",
        covered_through_run_id: "r1",
        reason: "unexpected",
      }),
      "conversation_compaction_failed",
      "p",
    )).toThrow(APIError);
  });

  it("context_usage — parses runtime usage and accepts unknown tokens after compaction", () => {
    const r = parseEventPayload(
      o({
        type: "context_usage",
        tokens: null,
        context_window: 131_072,
        percent: null,
        source: "runtime",
      }),
      "context_usage",
      "p",
    );
    expect(r).toEqual({
      type: "context_usage",
      tokens: null,
      context_window: 131_072,
      percent: null,
      source: "runtime",
    });
  });

  it("context_usage — rejects non-runtime sources and invalid token counts", () => {
    expect(() => parseEventPayload(
      o({ type: "context_usage", tokens: -1, context_window: 131_072, percent: 1, source: "runtime" }),
      "context_usage",
      "p",
    )).toThrow(APIError);
    expect(() => parseEventPayload(
      o({ type: "context_usage", tokens: 1, context_window: 131_072, percent: 1, source: "ui_estimate" }),
      "context_usage",
      "p",
    )).toThrow(APIError);
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

  it("run_completed — accepts build_result with empty user_summary/recommended_next_action", () => {
    const r = parseEventPayload(
      o({
        type: "run_completed",
        build_result: {
          status: "no_data",
          valid_row_count: 0,
          successful_sources: [],
          rejected_sources: [],
          available_artifact_roles: [],
          publication_id: null,
          build_id: "build_parser_1",
          reason_codes: ["no_primary_data"],
          user_summary: "",
          recommended_next_action: "",
        },
      }),
      "run_completed",
      "p",
    );
    if (r.type !== "run_completed") throw new Error();
    expect(r.build_result?.user_summary).toBe("");
    expect(r.build_result?.recommended_next_action).toBe("");
    expect(r.build_result?.build_id).toBe("build_parser_1");
  });

  it("run_completed — parses build_id and per-binding failure details (K2)", () => {
    const r = parseEventPayload(
      o({
        type: "run_completed",
        build_result: {
          status: "no_data",
          valid_row_count: 0,
          successful_sources: [],
          rejected_sources: ["gse", "gdc"],
          available_artifact_roles: [],
          publication_id: null,
          reason_codes: ["no_primary_data"],
          user_summary: "",
          recommended_next_action: "",
          build_id: "build_run_1",
          binding_failures: [
            { binding_id: "gse", reason_code: "empty_series_matrix", message: "metadata only" },
            { binding_id: "gdc", reason_code: "build_error", message: "checksum mismatch" },
          ],
        },
      }),
      "run_completed",
      "p",
    );
    if (r.type !== "run_completed") throw new Error();
    expect(r.build_result?.build_id).toBe("build_run_1");
    expect(r.build_result?.binding_failures).toHaveLength(2);
    expect(r.build_result?.binding_failures?.[0]).toEqual({
      binding_id: "gse",
      reason_code: "empty_series_matrix",
      message: "metadata only",
    });
  });

  it("permission_requested — accepts every permission resource scope", () => {
    for (const scope of [
      "workspace",
      "task_output",
      "framework_internal",
      "sensitive",
      "project",
      "external",
    ] as const) {
      const r = parseEventPayload(
        o({
          type: "permission_requested",
          request_id: `permission_${scope}`,
          capability: "fs.read",
          scope,
          resource: "D:\\resource",
          canonical_resource: "D:\\resource",
          command: null,
          cwd: null,
          summary: "读取资源",
        }),
        "permission_requested",
        "p",
      );
      if (r.type !== "permission_requested") throw new Error();
      expect(r.scope).toBe(scope);
    }
  });

  it("publication_created — parses the full publication payload", () => {
    const r = parseEventPayload(
      o({
        type: "publication_created",
        publication_id: "pub_1",
        run_id: "run_1",
        manifest_sha256: "a".repeat(64),
        supersedes_publication_id: null,
        published_at: "2026-08-06T00:00:00Z",
      }),
      "publication_created",
      "p",
    );
    if (r.type !== "publication_created") throw new Error();
    expect(r.publication_id).toBe("pub_1");
    expect(r.run_id).toBe("run_1");
    expect(r.manifest_sha256).toBe("a".repeat(64));
    expect(r.supersedes_publication_id).toBeNull();
    expect(r.published_at).toBe("2026-08-06T00:00:00Z");
  });
});

/* ---- V2 operation lifecycle family (T3 stage mirror) ---- */
describe("parseEventPayload — operation lifecycle family", () => {
  it("operation_started — parses label/category/attempt", () => {
    const r = parseEventPayload(
      o({ type: "operation_started", operation_id: "stage:discovery", label: "文献/数据发现", category: "discovery", attempt: 1 }),
      "operation_started",
      "p",
    );
    if (r.type !== "operation_started") throw new Error();
    expect(r.operation_id).toBe("stage:discovery");
    expect(r.label).toBe("文献/数据发现");
    expect(r.category).toBe("discovery");
    expect(r.attempt).toBe(1);
  });

  it("operation_started — tolerates missing optional fields", () => {
    const r = parseEventPayload(o({ type: "operation_started", operation_id: "op_1" }), "operation_started", "p");
    if (r.type !== "operation_started") throw new Error();
    expect(r.operation_id).toBe("op_1");
  });

  it("operation_progress — preserves kind/current/total/detail", () => {
    const r = parseEventPayload(
      o({ type: "operation_progress", operation_id: "stage:discovery", kind: "discovered_records", current: 10, total: 64, detail: { source: "geo" } }),
      "operation_progress",
      "p",
    );
    if (r.type !== "operation_progress") throw new Error();
    expect(r.kind).toBe("discovered_records");
    expect(r.current).toBe(10);
    expect(r.total).toBe(64);
    const detail = r.detail;
    if (typeof detail !== "object" || detail === null) throw new Error("Expected object detail");
    expect("source" in detail && detail.source).toBe("geo");
  });

  it("operation_completed — defaults status to succeeded", () => {
    const r = parseEventPayload(
      o({ type: "operation_completed", operation_id: "op_1", output_digest: "a".repeat(64) }),
      "operation_completed",
      "p",
    );
    if (r.type !== "operation_completed") throw new Error();
    expect(r.status).toBe("succeeded");
    expect(r.output_digest).toBe("a".repeat(64));
  });

  it("operation_completed — accepts skipped and rejects unknown status", () => {
    const r = parseEventPayload(o({ type: "operation_completed", operation_id: "op_1", status: "skipped" }), "operation_completed", "p");
    if (r.type !== "operation_completed") throw new Error();
    expect(r.status).toBe("skipped");
    expect(() => parseEventPayload(o({ type: "operation_completed", operation_id: "op_1", status: "bogus" }), "operation_completed", "p")).toThrow(APIError);
  });

  it("operation_failed — parses error detail and status", () => {
    const r = parseEventPayload(
      o({ type: "operation_failed", operation_id: "op_1", status: "failed", error: { code: "parse_error", message: "boom", retryable: false, stage: null, details: {} } }),
      "operation_failed",
      "p",
    );
    if (r.type !== "operation_failed") throw new Error();
    expect(r.status).toBe("failed");
    expect(r.error?.code).toBe("parse_error");
    expect(() => parseEventPayload(o({ type: "operation_failed", operation_id: "op_1", status: "succeeded" }), "operation_failed", "p")).toThrow(APIError);
  });
});

/* ---- EventEnvelope replay (REST GET /tasks/{id}/events) ---- */
describe("parseEventPage — operation events in full envelopes", () => {
  function envelope(type: string, sequence: number, payload: Record<string, unknown>) {
    return {
      schema_version: "2.0",
      event_id: `event_${sequence}`,
      type,
      task_id: "task_1",
      run_id: "run_1",
      stage_attempt_id: null,
      subagent_id: null,
      parent_tool_call_id: null,
      sequence,
      timestamp: "2026-08-09T13:12:00.000000Z",
      payload: o({ schema_version: "1.0", ...payload }),
    };
  }

  it("operation_progress envelope replays without Unknown event type", () => {
    const page = { events: [
      envelope("run_queued", 1, { type: "run_queued", request_id: "req_1", input: "x" }),
      envelope("stage_progress", 99, { type: "stage_progress", stage: "discovery", kind: "discovered_records", current: 10, total: 64, detail: {} }),
      envelope("operation_progress", 100, { type: "operation_progress", operation_id: "stage:discovery", label: "文献/数据发现", category: "discovery", kind: "discovered_records", current: 10, total: 64, detail: { source: "geo" } }),
    ] };
    const r = parseEventPage(page);
    expect(r.events.map((e) => e.type)).toEqual(["run_queued", "stage_progress", "operation_progress"]);
    if (r.events[2].payload.type !== "operation_progress") throw new Error();
    expect(r.events[2].payload.operation_id).toBe("stage:discovery");
  });

  it("operation_completed/operation_failed envelopes replay", () => {
    const page = { events: [
      envelope("operation_completed", 150, { type: "operation_completed", operation_id: "op_1", status: "succeeded", output_digest: "a".repeat(64) }),
      envelope("operation_failed", 151, { type: "operation_failed", operation_id: "op_2", status: "failed", error: { code: "parse_error", message: "boom", retryable: false, stage: null, details: {} } }),
    ] };
    const r = parseEventPage(page);
    expect(r.events.map((e) => e.type)).toEqual(["operation_completed", "operation_failed"]);
  });
});

/* ---- finite union parsers ---- */
describe("finite union parsers return narrowed literals", () => {
  it("assertRunStatus", () => { expect(assertRunStatus("queued", "p")).toBe("queued"); });
  it("assertTaskMode", () => { expect(assertTaskMode("agent", "p")).toBe("agent"); });
  it("assertMessageRole", () => { expect(assertMessageRole("user", "p")).toBe("user"); });
  it("assertEventType", () => { expect(assertEventType("run_queued", "p")).toBe("run_queued"); });
  it("assertEventType — operation lifecycle types accepted", () => {
    expect(assertEventType("operation_started", "p")).toBe("operation_started");
    expect(assertEventType("operation_progress", "p")).toBe("operation_progress");
    expect(assertEventType("operation_completed", "p")).toBe("operation_completed");
    expect(assertEventType("operation_failed", "p")).toBe("operation_failed");
    expect(() => assertEventType("bogus_event", "p")).toThrow(APIError);
  });
});
