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

/** Narrow EventPayload to the operation lifecycle family and its members. */
const ofType = <T extends EventPayload["type"]>(
  payloads: EventPayload[],
  type: T,
): Array<Extract<EventPayload, { type: T }>> =>
  payloads.filter((p): p is Extract<EventPayload, { type: T }> => p.type === type);

/** operation_ids in emission order (all tool-query events are lifecycle events). */
const queryOperationIds = (payloads: EventPayload[]): string[] =>
  payloads.flatMap((p) =>
    p.type === "operation_started" ||
    p.type === "operation_progress" ||
    p.type === "operation_completed" ||
    p.type === "operation_failed"
      ? [p.operation_id]
      : [],
  );

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
        operation_id: "tool:pubmed:query:1",
        label: "检索 PubMed",
        category: "discovery",
        attempt: 1,
      },
      {
        type: "operation_progress",
        operation_id: "tool:pubmed:query:1",
        kind: "query",
        current: 5,
        total: null,
        detail: { source: "pubmed", status: "success", query: "TP53" },
      },
      {
        type: "operation_completed",
        operation_id: "tool:pubmed:query:1",
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
      operation_id: "tool:gdc:query:1",
      status: "failed",
      error: null,
    });
    const skipped = payloads.find(
      (payload) => payload.type === "operation_completed",
    );
    expect(skipped).toEqual({
      type: "operation_completed",
      operation_id: "tool:reactome:query:1",
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
      operation_id: "tool:local_cache:query:1",
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
      operation_id: "tool:mystery_source:query:1",
      label: "检索 mystery_source",
    });
  });
});

describe("createPhase3ToolHooks query identity", () => {
  it("scopes operation ids per query call so concurrent same-source queries do not collide", async () => {
    const { payloads, recordRunEvent } = collect();
    const hooks = createPhase3ToolHooks(recordRunEvent, () => "run_1");

    // Two concurrent pubmed queries: both start before either ends, and the
    // second finishes first (out-of-order completion). Before the fix both
    // chains shared ``tool:pubmed:query``, so the reducer merged them onto a
    // single UI card and start/progress/end events interleaved.
    hooks.onQueryStarted?.("TP53", "pubmed");
    hooks.onQueryStarted?.("BRCA", "pubmed");
    await flush();
    hooks.onQuery?.("BRCA", "pubmed", "success", 3);
    await flush();
    hooks.onQuery?.("TP53", "pubmed", "success", 5);
    await flush();

    const started = ofType(payloads, "operation_started");
    const progressed = ofType(payloads, "operation_progress");
    const completed = ofType(payloads, "operation_completed");
    expect(started).toHaveLength(2);
    expect(progressed).toHaveLength(2);
    expect(completed).toHaveLength(2);

    // Every query call owns a distinct, deterministic call-scoped id; the
    // out-of-order finish still closes the card opened by its own start.
    expect(queryOperationIds(payloads)).toEqual([
      "tool:pubmed:query:1", // started TP53
      "tool:pubmed:query:2", // started BRCA
      "tool:pubmed:query:2", // progress BRCA (finishes first)
      "tool:pubmed:query:2", // completed BRCA
      "tool:pubmed:query:1", // progress TP53 (ends last)
      "tool:pubmed:query:1", // completed TP53
    ]);

    // Stable start/progress/end correlation: each id opens exactly once and
    // closes exactly once.
    for (const id of new Set(queryOperationIds(payloads))) {
      expect(started.filter((p) => p.operation_id === id)).toHaveLength(1);
      expect(progressed.filter((p) => p.operation_id === id)).toHaveLength(1);
      expect(completed.filter((p) => p.operation_id === id)).toHaveLength(1);
    }
  });

  it("pairs identical same-source queries FIFO when a legacy caller omits call tokens", async () => {
    const { payloads, recordRunEvent } = collect();
    const hooks = createPhase3ToolHooks(recordRunEvent, () => "run_1");

    // Two concurrent queries with the same query string from one source: the
    // A legacy caller omitted call tokens, so correlation is a deterministic
    // FIFO approximation (first end closes the first start)
    // rather than traceable causality.
    hooks.onQueryStarted?.("TP53", "pubmed");
    hooks.onQueryStarted?.("TP53", "pubmed");
    await flush();
    hooks.onQuery?.("TP53", "pubmed", "success", 5);
    await flush();
    hooks.onQuery?.("TP53", "pubmed", "not_found", 0);
    await flush();

    expect(queryOperationIds(payloads)).toEqual([
      "tool:pubmed:query:1", // started (first)
      "tool:pubmed:query:2", // started (second)
      "tool:pubmed:query:1", // first end FIFO-pairs with the first start
      "tool:pubmed:query:1", // completed first chain
      "tool:pubmed:query:2", // second end FIFO-pairs with the second start
      "tool:pubmed:query:2", // completed second chain
    ]);

    // Each chain still opens exactly once and closes exactly once.
    for (const id of new Set(queryOperationIds(payloads))) {
      expect(
        ofType(payloads, "operation_started").filter((p) => p.operation_id === id),
      ).toHaveLength(1);
      expect(
        ofType(payloads, "operation_progress").filter((p) => p.operation_id === id),
      ).toHaveLength(1);
      expect(
        ofType(payloads, "operation_completed").filter((p) => p.operation_id === id),
      ).toHaveLength(1);
    }
  });

  it("uses opaque tokens to correlate identical queries that finish out of order", async () => {
    const { payloads, recordRunEvent } = collect();
    const hooks = createPhase3ToolHooks(recordRunEvent, () => "run_1");

    const first = hooks.onQueryStarted?.("TP53", "pubmed");
    const second = hooks.onQueryStarted?.("TP53", "pubmed");
    await flush();
    hooks.onQuery?.("TP53", "pubmed", "success", 7, second);
    await flush();
    hooks.onQuery?.("TP53", "pubmed", "success", 5, first);
    await flush();

    expect(queryOperationIds(payloads)).toEqual([
      "tool:pubmed:query:1",
      "tool:pubmed:query:2",
      "tool:pubmed:query:2",
      "tool:pubmed:query:2",
      "tool:pubmed:query:1",
      "tool:pubmed:query:1",
    ]);
  });

  it("does not let an unknown token consume a pending query identity", async () => {
    const { payloads, recordRunEvent } = collect();
    const hooks = createPhase3ToolHooks(recordRunEvent, () => "run_1");

    const token = hooks.onQueryStarted?.("TP53", "geo");
    await flush();
    hooks.onQuery?.("TP53", "geo", "failed", 0, Object.freeze({ forged: true }));
    await flush();
    hooks.onQuery?.("TP53", "geo", "success", 1, token);
    await flush();

    expect(queryOperationIds(payloads)).toEqual([
      "tool:geo:query:1",
      "tool:geo:query:2",
      "tool:geo:query:2",
      "tool:geo:query:1",
      "tool:geo:query:1",
    ]);
  });

  it("gives sequential same-source queries distinct cards instead of reusing one operation_id", async () => {
    const { payloads, recordRunEvent } = collect();
    const hooks = createPhase3ToolHooks(recordRunEvent, () => "run_1");

    hooks.onQueryStarted?.("TP53", "pubmed");
    await flush();
    hooks.onQuery?.("TP53", "pubmed", "success", 5);
    await flush();
    hooks.onQueryStarted?.("BRCA", "pubmed");
    await flush();
    hooks.onQuery?.("BRCA", "pubmed", "not_found", 0);
    await flush();

    expect(queryOperationIds(payloads)).toEqual([
      "tool:pubmed:query:1", // first query chain
      "tool:pubmed:query:1",
      "tool:pubmed:query:1",
      "tool:pubmed:query:2", // second query chain
      "tool:pubmed:query:2",
      "tool:pubmed:query:2",
    ]);
  });

  it("terminates terminal-only queries (no onQueryStarted) with their own call-scoped id", async () => {
    const { payloads, recordRunEvent } = collect();
    const hooks = createPhase3ToolHooks(recordRunEvent, () => "run_1");

    // Older call sites may emit onQuery without onQueryStarted; the terminal
    // chain must not collide with a later started query from the same source.
    hooks.onQuery?.("legacy", "geo", "success", 2);
    await flush();
    hooks.onQueryStarted?.("TP53", "geo");
    await flush();
    hooks.onQuery?.("TP53", "geo", "success", 5);
    await flush();

    expect(queryOperationIds(payloads)).toEqual([
      "tool:geo:query:1", // progress legacy
      "tool:geo:query:1", // completed legacy
      "tool:geo:query:2", // started TP53
      "tool:geo:query:2", // progress TP53
      "tool:geo:query:2", // completed TP53
    ]);
  });

  it("is deterministic: the same call sequence on a fresh hook instance reproduces identical ids", async () => {
    const run = async (): Promise<EventPayload[]> => {
      const { payloads, recordRunEvent } = collect();
      const hooks = createPhase3ToolHooks(recordRunEvent, () => "run_1");
      hooks.onQueryStarted?.("TP53", "pubmed");
      hooks.onQueryStarted?.("BRCA", "pubmed");
      hooks.onQuery?.("BRCA", "pubmed", "success", 3);
      hooks.onQuery?.("TP53", "pubmed", "success", 5);
      await flush();
      return payloads;
    };

    expect(await run()).toEqual(await run());
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
