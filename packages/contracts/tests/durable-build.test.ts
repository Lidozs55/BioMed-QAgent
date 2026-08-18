import { describe, expect, it } from "vitest";

import type { BuildResult, DatasetBuildSpec, DurableBuildRecord } from "../src/index.js";
import {
  DURABLE_BUILD_TRANSITIONS,
  canTransitionDurableBuildStatus,
  matchesDurableBuildStart,
  parseCancelDatasetBuildRequest,
  parseCancelDatasetBuildResponse,
  parseDatasetBuildSpec,
  parseDurableBuildEventEnvelope,
  parseDurableBuildEventPayload,
  parseDurableBuildRecord,
  parseStartDatasetBuildRequest,
  parseStartDatasetBuildResponse,
} from "../src/index.js";

const DIGEST = "a".repeat(64);
const BASE_TIME = "2026-08-18T01:02:03.000Z";
const LATER_TIME = "2026-08-18T01:03:03.000Z";

const spec: DatasetBuildSpec = {
  schema_version: "1.0",
  build_id: "build_c3c_001",
  objective: "Build an expression dataset",
  dataset_family: "gene_expression",
  row_granularity: "gene_sample_measurement",
  entities: {},
  cohort_filters: {},
  required_fields: ["gene_id", "sample_id", "value"],
  schema_ref: "gene_expression.long.v1",
  source_bindings: [{
    schema_version: "1.0",
    binding_id: "binding_001",
    source: "fixture",
    acquisition: {
      schema_version: "1.0",
      mode: "builtin",
      provider_id: "fixture.v1",
      recipe_id: null,
      recipe_version: null,
    },
    adapter_id: "fixture.expression.v1",
    accession: null,
    parameters: {},
  }],
  normalization_profile_ref: null,
  merge_strategy: "append_by_canonical_row",
  validation_profile_ref: "gene_expression.release.v1",
  output_format: "csv",
  target_entity_level: null,
};

const result: BuildResult = {
  schema_version: "1.0",
  status: "succeeded",
  valid_row_count: 2,
  successful_sources: ["binding_001"],
  rejected_sources: [],
  available_artifact_roles: ["primary_dataset"],
  publication_id: "publication_001",
  reason_codes: [],
  user_summary: "Build succeeded",
  recommended_next_action: "Download the publication",
  build_id: "build_c3c_001",
  binding_failures: [],
};

function eventRef(type: "build_queued" | "build_completed" | "build_cancel_requested", sequence: number) {
  return {
    schema_version: "1.0" as const,
    event_id: `event_${sequence}`,
    type,
    task_id: "task_c3c_001",
    run_id: "run_c3c_001",
    build_id: "build_c3c_001",
    sequence,
    timestamp: BASE_TIME,
  };
}

function queuedBuild(overrides: Partial<DurableBuildRecord> = {}): DurableBuildRecord {
  return {
    schema_version: "1.0",
    task_id: "task_c3c_001",
    run_id: "run_c3c_001",
    build_id: "build_c3c_001",
    idempotency_key: "idem_c3c_001",
    request_digest: DIGEST,
    spec,
    status: "queued",
    attempt: 0,
    lease: null,
    cancellation: null,
    terminal_result: null,
    failure: null,
    created_at: BASE_TIME,
    updated_at: BASE_TIME,
    started_at: null,
    finished_at: null,
    event_refs: {
      schema_version: "1.0",
      queued: eventRef("build_queued", 1),
      latest: eventRef("build_queued", 1),
      terminal: null,
    },
    ...overrides,
  };
}

describe("durable Build contracts", () => {
  it("freezes exact lifecycle transitions and terminal isolation", () => {
    expect(DURABLE_BUILD_TRANSITIONS.queued).toEqual([
      "running",
      "cancel_requested",
      "spec_rejected",
      "failed",
    ]);
    expect(canTransitionDurableBuildStatus("queued", "running")).toBe(true);
    expect(canTransitionDurableBuildStatus("running", "succeeded")).toBe(true);
    expect(canTransitionDurableBuildStatus("succeeded", "running")).toBe(false);
    expect(canTransitionDurableBuildStatus("cancel_requested", "succeeded")).toBe(false);
    expect(canTransitionDurableBuildStatus("cancel_requested", "cancelled")).toBe(true);
  });

  it("parses a queued Build while retaining Task, Run, and Build identities", () => {
    const parsed = parseDurableBuildRecord(queuedBuild());
    expect(parsed).toMatchObject({
      task_id: "task_c3c_001",
      run_id: "run_c3c_001",
      build_id: "build_c3c_001",
      status: "queued",
      terminal_result: null,
    });
    expect(parsed.event_refs.queued.build_id).toBe(parsed.build_id);
  });

  it("requires a Build terminal result independent of Run terminal status", () => {
    const runningRunButBuildQueued = queuedBuild();
    expect(runningRunButBuildQueued.status).toBe("queued");
    expect(parseDurableBuildRecord(runningRunButBuildQueued).terminal_result).toBeNull();

    const terminal = queuedBuild({
      status: "succeeded",
      attempt: 1,
      lease: null,
      terminal_result: result,
      finished_at: LATER_TIME,
      started_at: BASE_TIME,
      updated_at: LATER_TIME,
      event_refs: {
        schema_version: "1.0",
        queued: eventRef("build_queued", 1),
        latest: eventRef("build_completed", 3),
        terminal: eventRef("build_completed", 3),
      },
    });
    expect(parseDurableBuildRecord(terminal).terminal_result?.status).toBe("succeeded");
    expect(() => parseDurableBuildRecord({
      ...terminal,
      status: "queued",
    })).toThrow(/terminal timestamps\/event refs/);
    expect(() => parseDurableBuildRecord({
      ...terminal,
      event_refs: {
        ...terminal.event_refs,
        latest: { ...eventRef("build_cancel_requested", 3), event_id: "event_wrong" },
        terminal: { ...eventRef("build_cancel_requested", 3), event_id: "event_wrong" },
      },
    })).toThrow(/does not match succeeded status/);
  });

  it("accepts cancellation acknowledgement without inventing a Build result", () => {
    const request = {
      schema_version: "1.0" as const,
      request_id: "cancel_c3c_001",
      task_id: "task_c3c_001",
      run_id: "run_c3c_001",
      reason: "user requested cancellation",
    };
    expect(parseCancelDatasetBuildRequest(request)).toEqual(request);
    const ack = {
      schema_version: "1.0" as const,
      request_id: request.request_id,
      task_id: request.task_id,
      run_id: request.run_id,
      build_id: "build_c3c_001",
      disposition: "accepted" as const,
      status: "cancel_requested" as const,
      terminal: false,
      cancel_requested_event: eventRef("build_cancel_requested", 2),
      terminal_event: null,
    };
    expect(parseCancelDatasetBuildResponse(ack)).toEqual(ack);
    expect(() => parseCancelDatasetBuildResponse({ ...ack, terminal: true })).toThrow(/terminal/);
    expect(() => parseCancelDatasetBuildResponse({
      ...ack,
      disposition: "already_terminal",
    })).toThrow(/requires terminal status/);
  });

  it("makes repeated starts exact-idempotent and rejects changed request identity", () => {
    const request = {
      schema_version: "1.0" as const,
      idempotency_key: "idem_c3c_001",
      task_id: "task_c3c_001",
      run_id: "run_c3c_001",
      spec,
    };
    const parsedRequest = parseStartDatasetBuildRequest(request);
    expect(matchesDurableBuildStart(queuedBuild(), parsedRequest, DIGEST)).toBe(true);
    expect(matchesDurableBuildStart(queuedBuild(), parsedRequest, "b".repeat(64))).toBe(false);
    expect(matchesDurableBuildStart(queuedBuild(), {
      ...parsedRequest,
      spec: { ...spec, objective: "different" },
    }, "b".repeat(64))).toBe(false);

    const response = parseStartDatasetBuildResponse({
      schema_version: "1.0",
      idempotent_replay: true,
      build: queuedBuild(),
    });
    expect(response.idempotent_replay).toBe(true);
  });

  it("parses durable event payloads and rejects free-form status inference", () => {
    expect(parseDurableBuildEventPayload({
      type: "build_queued",
      idempotency_key: "idem_c3c_001",
      request_digest: DIGEST,
    })).toEqual({
      type: "build_queued",
      idempotency_key: "idem_c3c_001",
      request_digest: DIGEST,
    });
    expect(parseDurableBuildEventPayload({
      type: "build_completed",
      result,
    })).toMatchObject({ type: "build_completed", result: { status: "succeeded" } });
    expect(parseDurableBuildEventEnvelope({
      schema_version: "2.0",
      event_id: "event_3",
      type: "build_completed",
      task_id: "task_c3c_001",
      run_id: "run_c3c_001",
      build_id: "build_c3c_001",
      stage_attempt_id: null,
      sequence: 3,
      timestamp: LATER_TIME,
      payload: { type: "build_completed", result },
    })).toMatchObject({
      type: "build_completed",
      build_id: "build_c3c_001",
      payload: { type: "build_completed" },
    });
    expect(() => parseDurableBuildEventEnvelope({
      schema_version: "2.0",
      event_id: "event_3",
      type: "build_failed",
      task_id: "task_c3c_001",
      run_id: "run_c3c_001",
      build_id: "build_c3c_001",
      stage_attempt_id: null,
      sequence: 3,
      timestamp: LATER_TIME,
      payload: { type: "build_completed", result },
    })).toThrow(/must match payload/);
    expect(() => parseDurableBuildEventPayload({
      type: "build_completed",
      result: { ...result, status: "status inferred from error" },
    })).toThrow();
  });

  it("keeps the compatible DatasetBuildSpec parser available at the runtime boundary", () => {
    expect(parseDatasetBuildSpec(spec)).toEqual(spec);
    expect(() => parseDatasetBuildSpec({ ...spec, source_bindings: [] })).toThrow(/non-empty/);
  });
});
