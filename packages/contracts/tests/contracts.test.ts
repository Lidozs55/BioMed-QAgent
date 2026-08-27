import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type {
  DatasetManifest,
  DatasetPublication,
  EventEnvelope,
  RunRecord,
  RunStatus,
  TaskMode,
  TaskSummary,
} from "../src/index";

interface ContractParityFixture {
  event_envelopes: EventEnvelope[];
  dataset_manifest: DatasetManifest;
  dataset_publication: DatasetPublication;
  task_modes: TaskMode[];
  run_statuses: RunStatus[];
  task_summary: TaskSummary;
  run_records: RunRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertParityFixture(value: unknown): asserts value is ContractParityFixture {
  if (
    !isRecord(value) ||
    !Array.isArray(value.event_envelopes) ||
    !isRecord(value.dataset_manifest) ||
    !isRecord(value.dataset_publication) ||
    !Array.isArray(value.task_modes) ||
    !Array.isArray(value.run_statuses) ||
    !isRecord(value.task_summary) ||
    !Array.isArray(value.run_records)
  ) {
    throw new TypeError("invalid contract parity fixture root");
  }
}

const fixturePath = new URL(
  "../../../tests/migration/contracts/wire-contracts.json",
  import.meta.url,
);
const fixtureJson: unknown = JSON.parse(readFileSync(fixturePath, "utf8"));
assertParityFixture(fixtureJson);
const fixture = fixtureJson;

describe("shared wire contract fixture", () => {
  it("freezes event schema, task sequence, and run linkage", () => {
    expect(fixture.event_envelopes.map((event) => event.schema_version)).toEqual([
      "1.0",
      "2.0",
    ]);
    expect(fixture.event_envelopes.map((event) => event.sequence)).toEqual([41, 42]);
    expect(fixture.event_envelopes[0]?.run_id).toBeNull();
    expect(fixture.event_envelopes[1]?.run_id).toBe("run_fixture_001");
  });

  it("freezes manifest artifact roles", () => {
    expect(fixture.dataset_manifest.artifacts.map((artifact) => artifact.role)).toEqual([
      "primary_dataset",
      "supporting_dataset",
      "schema",
      "provenance",
      "audit_report",
    ]);
  });

  it("freezes publication supersession and task/run status values", () => {
    expect(fixture.dataset_publication.supersedes_publication_id).toBe(
      "publication_fixture_000",
    );
    expect(fixture.task_modes).toEqual(["agent", "fixture", "import"]);
    expect(fixture.run_statuses).toEqual([
      "queued",
      "running",
      "finalizing",
      "cancel_requested",
      "awaiting_user_input",
      "completed",
      "failed",
      "cancelled",
      "interrupted",
    ]);
    expect(fixture.task_summary.mode).toBe("agent");
    expect(fixture.run_records.map((run) => run.status)).toEqual(fixture.run_statuses);
  });
});
