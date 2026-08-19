import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DurableBuildStore } from "../src/runtime/durable-build-store.js";
import { DurableTaskRepository } from "../src/runtime/task-repository.js";

const spec = {
  schema_version: "1.0" as const, build_id: "build_c3i_1", objective: "test",
  dataset_family: "gene_expression", row_granularity: "gene_sample_measurement",
  entities: {}, cohort_filters: {}, required_fields: [], schema_ref: "gene_expression.long.v1",
  source_bindings: [{ schema_version: "1.0" as const, binding_id: "binding_1", source: "fixture",
    acquisition: { schema_version: "1.0" as const, mode: "builtin" as const, provider_id: "fixture.v1", recipe_id: null, recipe_version: null },
    adapter_id: "fixture.expression.v1", accession: null, parameters: {} }],
  normalization_profile_ref: null, merge_strategy: "append_by_canonical_row",
  validation_profile_ref: "gene_expression.release.v1", output_format: "csv", target_entity_level: null,
};
const start = (buildId = spec.build_id, key = "idem_c3i_1") => ({ schema_version: "1.0" as const,
  idempotency_key: key, task_id: "task_c3i_1", run_id: "run_c3i_1", spec: { ...spec, build_id: buildId } });
const result = { status: "succeeded" as const, valid_row_count: 1, successful_sources: ["fixture"],
  rejected_sources: [], available_artifact_roles: [], publication_id: null, reason_codes: [],
  user_summary: "ok", recommended_next_action: "none", build_id: spec.build_id };

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "c3i-build-"));
  const repository = new DurableTaskRepository(root, { id: () => "event-id" });
  await repository.createTask({ requestId: "task-request", input: "build", databases: [], mode: "agent" });
  return { root, repository, store: new DurableBuildStore(root, { repository, id: () => "id", leaseMs: 1 }) };
}

describe("DurableBuildStore", () => {
  it("starts, replays exact idempotency, and rejects digest mismatch", async () => {
    const value = await fixture();
    try {
      const first = await value.store.start(start());
      expect(first.idempotent_replay).toBe(false);
      expect((await value.store.start(start())).idempotent_replay).toBe(true);
      await expect(value.store.start({ ...start(), spec: { ...spec, objective: "different" } })).rejects.toMatchObject({ api: { code: "idempotency_key_reused" } });
      await expect(value.store.start(start(spec.build_id, "idem_c3i_other"))).rejects.toMatchObject({ api: { code: "build_identity_mismatch" } });
      expect((await value.store.get(spec.build_id))?.status).toBe("queued");
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  it("keeps build terminal state independent and returns structured cancel acknowledgement", async () => {
    const value = await fixture();
    try {
      await value.store.start(start());
      const accepted = await value.store.cancel({ schema_version: "1.0", request_id: "cancel_1", task_id: "task_c3i_1", run_id: "run_c3i_1", reason: "user" }, spec.build_id);
      expect(accepted).toMatchObject({ disposition: "accepted", status: "cancel_requested", terminal: false });
      expect((await value.store.cancel({ schema_version: "1.0", request_id: "cancel_2", task_id: "task_c3i_1", run_id: "run_c3i_1", reason: null }, spec.build_id)).disposition).toBe("already_requested");
      const terminal = await value.store.cancelTerminal(spec.build_id);
      expect(terminal.status).toBe("cancelled");
      expect((await value.store.cancel({ schema_version: "1.0", request_id: "cancel_3", task_id: "task_c3i_1", run_id: "run_c3i_1", reason: null }, spec.build_id)).disposition).toBe("already_terminal");
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  it("recovers an expired lease without changing build identity or terminalizing it", async () => {
    const value = await fixture();
    try {
      await value.store.start(start());
      const running = await value.store.claim(spec.build_id);
      expect(running.status).toBe("running");
      await new Promise((resolve) => setTimeout(resolve, 5));
      const restarted = new DurableBuildStore(value.root, {
        repository: new DurableTaskRepository(value.root),
        id: () => "restart-id",
        leaseMs: 1,
      });
      const recovered = (await restarted.recoverExpiredLeases())[0]!;
      expect(recovered).toMatchObject({ build_id: spec.build_id, task_id: "task_c3i_1", run_id: "run_c3i_1", status: "running", attempt: 2 });
      expect(recovered.event_refs.latest.type).toBe("build_recovered");
      await restarted.complete(spec.build_id, result);
      expect((await restarted.get(spec.build_id))?.status).toBe("succeeded");
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });
});
