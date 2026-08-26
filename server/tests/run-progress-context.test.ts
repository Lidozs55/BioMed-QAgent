import type { BuildResult } from "@biomed/contracts";
import { describe, expect, test } from "vitest";

import {
  RUN_PROGRESS_CONTEXT_MAX_CHARS,
  RunProgressContextTracker,
  runProgressContextMessage,
} from "../src/agent/run-progress-context.js";

function buildResult(
  status: BuildResult["status"],
  publicationId: string | null = null,
): BuildResult {
  return {
    schema_version: "1.0",
    build_id: "build_1",
    status,
    valid_row_count: status === "succeeded" ? 42 : 0,
    successful_sources: status === "succeeded" ? ["source_1"] : [],
    rejected_sources: [],
    available_artifact_roles: publicationId === null ? [] : ["primary_dataset"],
    publication_id: publicationId,
    reason_codes: [],
    user_summary: "bounded summary",
    recommended_next_action: "bounded next action",
  };
}

describe("short run-progress context", () => {
  test("renders a bounded four-line planning hint before any tool use", () => {
    const tracker = new RunProgressContextTracker(() => null);

    const context = tracker.render();

    expect(context.split("\n")).toHaveLength(4);
    expect(context.length).toBeLessThanOrEqual(RUN_PROGRESS_CONTEXT_MAX_CHARS);
    expect(context).toContain("phase=planning");
    expect(context).toContain("tools=0 ok/0 failed/0 active");
    expect(context).toContain("formal build=none; publication=none");
    expect(context).toContain("only if publishable data is required");
  });

  test("summarizes tool progress and gives a failure-aware next action", () => {
    const tracker = new RunProgressContextTracker(() => null);
    tracker.toolStarted("call_1", "search_pubmed");
    tracker.toolStarted("call_2", "lookup_openfda_dili_counts");
    tracker.toolCompleted("call_1", "search_pubmed", false);
    tracker.toolCompleted("call_2", "lookup_openfda_dili_counts", true);

    const context = tracker.render();

    expect(context).toContain("phase=working");
    expect(context).toContain("tools=1 ok/1 failed/0 active");
    expect(context).toContain("latest=lookup_openfda_dili_counts failed");
    expect(context).toContain("retry only if retryable or use an independent source");
  });

  test("projects the current BuildResult and Publication without consuming them", () => {
    const result = buildResult("succeeded", "publication_1");
    let reads = 0;
    const tracker = new RunProgressContextTracker(() => {
      reads += 1;
      return result;
    });
    tracker.toolStarted("call_1", "execute_dataset_build");
    tracker.toolCompleted("call_1", "execute_dataset_build", false);

    const first = tracker.render();
    const second = tracker.render();

    expect(first).toContain("phase=finalizing");
    expect(first).toContain("formal build=succeeded; publication=publication_1");
    expect(first).toContain("42 valid rows");
    expect(first).toContain("verify artifact and provenance coverage");
    expect(second).toBe(first);
    expect(reads).toBe(2);
  });

  test("resets all tool counters when a new Run starts", () => {
    const tracker = new RunProgressContextTracker(() => buildResult("no_data"));
    tracker.toolStarted("call_1", "execute_dataset_build");
    tracker.toolCompleted("call_1", "execute_dataset_build", true);

    tracker.reset();

    const context = tracker.render();
    expect(context).toContain("tools=0 ok/0 failed/0 active");
    expect(context).toContain("formal build=no_data; publication=none");
    expect(context).toContain("seek an independent real source");
    expect(context).not.toContain("execute_dataset_build failed");
  });

  test("creates an invisible context-only custom message", () => {
    const tracker = new RunProgressContextTracker(() => null);

    expect(runProgressContextMessage(tracker, 123)).toEqual({
      role: "custom",
      customType: "biomed_run_progress",
      content: tracker.render(),
      display: false,
      timestamp: 123,
    });
  });

  test("keeps hostile tool labels inside the hard context budget", () => {
    const tracker = new RunProgressContextTracker(() => null);
    tracker.toolStarted("call_1", `tool_${"x".repeat(2_000)}`);

    const context = tracker.render();

    expect(context.split("\n")).toHaveLength(4);
    expect(context.length).toBeLessThanOrEqual(RUN_PROGRESS_CONTEXT_MAX_CHARS);
  });
});
