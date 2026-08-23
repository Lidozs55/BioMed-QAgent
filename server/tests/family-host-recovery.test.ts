import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { parseDatasetBuildSpec } from "../src/dataset/contracts/index.js";
import {
  buildOperationPlan,
  DatasetBuildExecutor,
  loadBuildState,
  makeOperationOutput,
  stageOutputFile,
  type OperationOutput,
  type OperationSpec,
} from "../src/dataset/runtime/index.js";
import { userInputRequiredPayload, DurableHILStore } from "../src/runtime/hil-store.js";
import { createDurableAgentRuntime } from "../src/runtime/durable-agent-runtime.js";
import { DurableTaskRepository } from "../src/runtime/task-repository.js";

const RELEASE = "sha256:" + "1".repeat(64);
const IMPLEMENTATION = "fixed-operation-v1";

function spec() {
  return parseDatasetBuildSpec({
    schema_version: "1.0",
    build_id: "build_recovery",
    objective: "checkpoint recovery",
    dataset_family: "gene_expression",
    row_granularity: "gene_sample_measurement",
    schema_ref: "gene_expression.long.v1",
    source_bindings: [{
      schema_version: "1.0",
      binding_id: "binding_gdc",
      source: "gdc",
      acquisition: {
        schema_version: "1.0",
        mode: "builtin",
        provider_id: "gdc.files.v1",
      },
      adapter_id: "gdc.expression.v1",
      accession: "ACC-1",
    }],
    validation_profile_ref: "gene_expression.release.v1",
  });
}

class Runner {
  readonly calls: string[] = [];
  readonly outputRoot: string;
  readonly content: string;

  constructor(outputRoot: string, content = "id,value\nrow-1,1\n") {
    this.outputRoot = outputRoot;
    this.content = content;
  }

  run = (op: OperationSpec, upstream: Record<string, Record<string, unknown>>): OperationOutput => {
    this.calls.push(op.operation_id);
    if (op.kind !== "parse") {
      return makeOperationOutput({ operation_id: op.operation_id, kind: op.kind, upstream: Object.keys(upstream) });
    }
    const relativePath = "checkpoint-output/parsed.csv";
    const outputPath = join(this.outputRoot, relativePath);
    const outputDirectory = join(this.outputRoot, "checkpoint-output");
    mkdirSync(outputDirectory, { recursive: true });
    writeFileSync(outputPath, this.content, "utf8");
    return makeOperationOutput(
      { operation_id: op.operation_id, kind: op.kind, binding_id: op.category },
      [stageOutputFile(relativePath, Buffer.byteLength(this.content), createHash("sha256").update(this.content).digest("hex"))],
    );
  };
}

function executor(root: string, runner: Runner, overrides: Partial<ConstructorParameters<typeof DatasetBuildExecutor>[0]> = {}) {
  return new DatasetBuildExecutor({
    taskId: "task_recovery",
    buildId: spec().build_id,
    stateDir: join(root, "state"),
    taskRoot: root,
    plan: buildOperationPlan(spec()),
    runOperation: runner.run,
    coreReleaseIdentity: RELEASE,
    implementationVersions: { "parse:binding_gdc": IMPLEMENTATION },
    ...overrides,
  });
}

describe("Family Host checkpoint recovery lane", () => {
  test("reuses a completed fixed operation across fresh executor instances with matching identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "family-restart-match-"));
    try {
      const first = new Runner(root);
      expect((await executor(root, first).run()).status).toBe("completed");
      const second = new Runner(root);
      expect((await executor(root, second).run()).status).toBe("completed");
      expect(second.calls).toEqual(["publish"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([
    ["release", { coreReleaseIdentity: "sha256:" + "2".repeat(64) }],
    ["implementation", { implementationVersions: { "parse:binding_gdc": "fixed-operation-v2" } }],
  ])("re-executes instead of reusing when the %s identity changes", async (_label, changed) => {
    const root = mkdtempSync(join(tmpdir(), "family-restart-identity-"));
    try {
      const first = new Runner(root);
      expect((await executor(root, first).run()).status).toBe("completed");
      const second = new Runner(root);
      expect((await executor(root, second, changed).run()).status).toBe("completed");
      expect(second.calls).toContain("parse:binding_gdc");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("legacy or missing identity evidence forces operation re-execution", async () => {
    const root = mkdtempSync(join(tmpdir(), "family-legacy-identity-"));
    try {
      const first = new Runner(root);
      expect((await executor(root, first).run()).status).toBe("completed");
      const statePath = join(root, "state", "build_state.json");
      const persisted = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
      delete persisted.fixed_operation_checkpoint_identities;
      writeFileSync(statePath, `${JSON.stringify(persisted)}\n`, "utf8");
      const second = new Runner(root);
      expect((await executor(root, second).run()).status).toBe("completed");
      expect(second.calls).toContain("parse:binding_gdc");
      expect(loadBuildState(join(root, "state"), "task_recovery", "build_recovery")
        .fixed_operation_checkpoint_identities.migration_state).toBe("native");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("result-manifest and output-file closure drift fail closed before reuse", async () => {
    const root = mkdtempSync(join(tmpdir(), "family-closure-drift-"));
    try {
      const first = new Runner(root);
      expect((await executor(root, first).run()).status).toBe("completed");
      const manifestPath = join(root, "state", "parse_binding_gdc_result.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      manifest.output_files = [];
      writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
      const second = new Runner(root);
      expect((await executor(root, second).run()).status).toBe("completed");
      expect(second.calls).toContain("parse:binding_gdc");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("output-file TOCTOU drift during hashing fails closed before reuse", async () => {
    const root = mkdtempSync(join(tmpdir(), "family-toctou-"));
    const largeContent = "id,value\n" + "row-1,1\n".repeat(200_000);
    let mutation: NodeJS.Timeout | undefined;
    try {
      const first = new Runner(root, largeContent);
      expect((await executor(root, first).run()).status).toBe("completed");
      const outputPath = join(root, "checkpoint-output", "parsed.csv");
      const before = statSync(outputPath);
      mutation = setInterval(() => {
        writeFileSync(outputPath, largeContent.replace("row-1,1", "row-1,2"), "utf8");
      }, 1);
      const second = new Runner(root, largeContent);
      expect((await executor(root, second).run()).status).toBe("completed");
      expect(second.calls).toContain("parse:binding_gdc");
      expect(statSync(outputPath).mtimeMs).not.toBe(before.mtimeMs);
    } finally {
      if (mutation !== undefined) clearInterval(mutation);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a stale generation/cancel fence cannot commit a reusable output", async () => {
    const root = mkdtempSync(join(tmpdir(), "family-stale-commit-"));
    try {
      let current = true;
      const staleRunner = new Runner(root);
      const original = staleRunner.run;
      staleRunner.run = (op, upstream) => {
        const result = original(op, upstream);
        if (op.operation_id === "parse:binding_gdc") current = false;
        return result;
      };
      const outcome = await executor(root, staleRunner, {
        cancellationRequested: () => !current,
      }).run();
      expect(outcome.status).toBe("cancelled");
      const state = loadBuildState(join(root, "state"), "task_recovery", "build_recovery");
      expect(state.completed_operations["parse:binding_gdc"]).toBeUndefined();
      expect(state.operation_attempts.some((attempt) => attempt.operation_id === "parse:binding_gdc" && attempt.status === "succeeded")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([
    ["pending", false],
    ["resolved", true],
  ] as const)("%s dynamic publication HIL fails closed after a Host restart", async (_label, resolveBeforeRestart) => {
    const root = mkdtempSync(join(tmpdir(), "family-dynamic-hil-restart-"));
    try {
      const repository = new DurableTaskRepository(root);
      const accepted = await repository.createTask({
        requestId: "dynamic_hil_restart",
        input: "publish dynamic family",
        databases: [],
        mode: "agent",
      });
      await repository.appendRunEvent(accepted.task_id, accepted.run_id, { type: "run_started" });
      const store = new DurableHILStore(repository);
      const request = await store.createRequest({
        task_id: accepted.task_id,
        run_id: accepted.run_id,
        build_id: "build_dynamic",
        kind: "data_review",
        review_type: "publication_acceptance",
        blocking: true,
        subject: { candidate_ids: ["candidate_dynamic"], table_ids: ["records"] },
        review_items: [],
        summary: "Accept dynamic publication",
        evidence: { candidate: "candidate_dynamic" },
        policy_ref: "dynamic_family_hil_acceptance.v1",
        idempotency_key: "dynamic-publication-restart",
      });
      await repository.appendRunEvent(
        accepted.task_id,
        accepted.run_id,
        userInputRequiredPayload(request),
      );
      if (resolveBeforeRestart) {
        const review = await store.resolveRequest(accepted.task_id, accepted.run_id, {
          request_id: request.request_id,
          evidence_digest: request.evidence_digest,
          decision: { action: "accept" },
          reason: "accepted before restart",
        });
        await repository.appendRunEvent(accepted.task_id, accepted.run_id, {
          type: "user_input_resumed",
          request_id: request.request_id,
          decision: review.decision,
          detail: {
            evidence_digest: review.evidence_digest,
            review_id: review.review_id,
            reason: review.reason,
          },
        });
      }

      const runtime = await createDurableAgentRuntime({
        tasksRoot: root,
        adapter: {
          createSession: async () => {
            throw new Error("dynamic publication recovery must not create an Agent session");
          },
        },
        workspaceFactory: async () => {
          throw new Error("dynamic publication recovery must not create a workspace");
        },
        repository,
      });
      const snapshot = await repository.getSnapshot(accepted.task_id);
      expect(snapshot?.runs.find((run) => run.run_id === accepted.run_id)?.status).toBe("failed");
      const terminal = (await repository.listEvents(accepted.task_id, 0)).at(-1);
      expect(terminal?.payload).toMatchObject({
        type: "run_failed",
        error_code: "configuration_error",
      });
      await runtime.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
