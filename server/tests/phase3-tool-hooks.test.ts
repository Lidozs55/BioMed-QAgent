import { describe, expect, it } from "vitest";
import type { EventPayload } from "@biomed/contracts";
import { createPhase3ToolHooks } from "../src/runtime/phase3-composition.js";

/**
 * Tool hooks projected onto the V2 operation lifecycle (Design §15.1):
 * onQueryStarted → operation_started, onQuery → operation_progress +
 * terminal event, onProgress → once-per-run operation_started +
 * operation_progress.
 *
 * Regression: before this lifecycle existed the server emitted progress-only
 * events and every tool operation card stayed "running" forever (observed on
 * task_ts_818132eb-343f-4fc7-ae1d-78e475365078).
 */

function collect(): {
  payloads: EventPayload[];
  recordRunEvent: (payload: EventPayload) => Promise<void>;
} {
  const payloads: EventPayload[] = [];
  const recordRunEvent = async (payload: EventPayload): Promise<void> => {
    payloads.push(payload);
  };
  return { payloads, recordRunEvent };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("createPhase3ToolHooks query lifecycle", () => {
  it("opens with a readable label and closes with succeeded on success", async () => {
    const { payloads, recordRunEvent } = collect();
    const hooks = createPhase3ToolHooks(recordRunEvent, () => "run_1");

    hooks.onQueryStarted?.("TP53", "pubmed");
    await flush();
    hooks.onQuery?.("TP53", "pubmed", "success", 5);
    await flush();

    expect(payloads).toEqual([
      {
        type: "operation_started",
        operation_id: "tool:pubmed:query",
        label: "检索 PubMed",
        category: "discovery",
        attempt: 1,
      },
      {
        type: "operation_progress",
        operation_id: "tool:pubmed:query",
        kind: "query",
        current: 5,
        total: null,
        detail: { source: "pubmed", status: "success", query: "TP53" },
      },
      {
        type: "operation_completed",
        operation_id: "tool:pubmed:query",
        status: "succeeded",
      },
    ]);
  });

  it("maps failed → operation_failed and skipped → completed skipped", async () => {
    const { payloads, recordRunEvent } = collect();
    const hooks = createPhase3ToolHooks(recordRunEvent, () => "run_1");

    hooks.onQueryStarted?.("TCGA", "gdc");
    await flush();
    hooks.onQuery?.("TCGA", "gdc", "failed", 0);
    await flush();
    hooks.onQueryStarted?.("p53", "reactome");
    await flush();
    hooks.onQuery?.("p53", "reactome", "skipped", 0);
    await flush();

    const failed = payloads.find(
      (payload) => payload.type === "operation_failed",
    );
    expect(failed).toEqual({
      type: "operation_failed",
      operation_id: "tool:gdc:query",
      status: "failed",
      error: null,
    });
    const skipped = payloads.find(
      (payload) => payload.type === "operation_completed",
    );
    expect(skipped).toEqual({
      type: "operation_completed",
      operation_id: "tool:reactome:query",
      status: "skipped",
    });
  });

  it("treats not_found as a successful query with zero records", async () => {
    const { payloads, recordRunEvent } = collect();
    const hooks = createPhase3ToolHooks(recordRunEvent, () => "run_1");

    hooks.onQueryStarted?.("nope", "local_cache");
    await flush();
    hooks.onQuery?.("nope", "local_cache", "not_found", 0);
    await flush();

    expect(
      payloads.find((payload) => payload.type === "operation_completed"),
    ).toEqual({
      type: "operation_completed",
      operation_id: "tool:local_cache:query",
      status: "succeeded",
    });
  });

  it("falls back to the raw source in the label for unknown sources", async () => {
    const { payloads, recordRunEvent } = collect();
    const hooks = createPhase3ToolHooks(recordRunEvent, () => "run_1");

    hooks.onQueryStarted?.("x", "mystery_source");
    await flush();

    expect(payloads[0]).toMatchObject({
      type: "operation_started",
      operation_id: "tool:mystery_source:query",
      label: "检索 mystery_source",
    });
  });
});

describe("createPhase3ToolHooks progress lifecycle", () => {
  it("opens progress-only operations once per run with a stage label", async () => {
    let runId = "run_1";
    const { payloads, recordRunEvent } = collect();
    const hooks = createPhase3ToolHooks(recordRunEvent, () => runId);

    hooks.onProgress?.("discovery", "discovered_records", {
      current: 5,
      total: 20703,
      source: "geo",
      term: "TP53",
    });
    await flush();
    // Second aggregation report (another source) must not re-open the card.
    hooks.onProgress?.("discovery", "discovered_records", {
      current: 5,
      total: 39501,
      source: "pubmed",
      query: "TP53",
    });
    await flush();

    expect(payloads).toEqual([
      {
        type: "operation_started",
        operation_id: "tool:discovery:discovered_records",
        label: "发现记录",
        category: "discovery",
        attempt: 1,
      },
      {
        type: "operation_progress",
        operation_id: "tool:discovery:discovered_records",
        kind: "discovered_records",
        current: 5,
        total: 20703,
        detail: { current: 5, total: 20703, source: "geo", term: "TP53" },
      },
      {
        type: "operation_progress",
        operation_id: "tool:discovery:discovered_records",
        kind: "discovered_records",
        current: 5,
        total: 39501,
        detail: { current: 5, total: 39501, source: "pubmed", query: "TP53" },
      },
    ]);

    // A new run re-opens the card (operation items are run-scoped).
    runId = "run_2";
    hooks.onProgress?.("discovery", "discovered_records", {
      current: 1,
      total: 100,
    });
    await flush();
    const starts = payloads.filter(
      (payload) => payload.type === "operation_started",
    );
    expect(starts).toHaveLength(2);
  });
});
