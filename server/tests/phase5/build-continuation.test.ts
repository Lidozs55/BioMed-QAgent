import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, test } from "vitest";

import type {
  BioMedAgentAdapter,
  BioMedAgentEvent,
  BioMedAgentSession,
  BioMedToolResult,
} from "../../src/agent/contracts.js";
import { createDatasetBuildTools } from "../../src/agent/tools/dataset-build.js";
import { parseDatasetBuildSpec } from "../../src/dataset/contracts/index.js";
import {
  createDatasetCoreService,
  TsDatasetCoreAdapter,
} from "../../src/dataset/service/dataset-core.js";
import { coreEventToPayload } from "../../src/dataset/service/events.js";
import { TypeScriptDatasetCore } from "../../src/dataset/service/ts-core.js";
import { DurableApprovalGate } from "../../src/runtime/approval-gate.js";
import { readBuildContinuation } from "../../src/runtime/build-continuation.js";
import { createDurableAgentRuntime } from "../../src/runtime/durable-agent-runtime.js";
import { DurableHILStore } from "../../src/runtime/hil-store.js";
import { DurableTaskRepository } from "../../src/runtime/task-repository.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const BUILD_ID = "build_continuation";

/**
 * A GEO series-matrix build whose declared expression unit is not in the
 * normalization profile: canonicalize must raise a durable unit_conversion
 * HIL request before it can proceed.
 */
function unitHilSpec() {
  return parseDatasetBuildSpec({
    schema_version: "1.0",
    build_id: BUILD_ID,
    objective: "resume a suspended build",
    dataset_family: "gene_expression",
    row_granularity: "gene_sample_measurement",
    schema_ref: "gene_expression.long.v1",
    source_bindings: [{
      schema_version: "1.0",
      binding_id: "binding_geo",
      source: "geo",
      acquisition: { schema_version: "1.0", mode: "builtin", provider_id: "geo.files.v1" },
      adapter_id: "geo.expression.v1",
      parameters: {
        schema_version: "1.0",
        format: "series_matrix",
        value_semantics: "normalized_expression",
        value_scale: "log10",
        expression_unit: "log10_expression",
        is_normalized: true,
        platform_ids: ["GPL570"],
        delimiter: "auto",
      },
    }],
    validation_profile_ref: "gene_expression.release.v1",
  });
}

const SERIES_MATRIX = gzipSync(Buffer.from(
  "!Sample_platform_id\t\"GPL570\"\n" +
    "!series_matrix_table_begin\n" +
    "\"ID_REF\"\t\"GSM1\"\n" +
    "\"PROBE1\"\t1.5\n" +
    "!series_matrix_table_end\n",
  "utf8",
));

const ANNOTATION = gzipSync(Buffer.from(
  "!platform_table_begin\n" +
    "\"ID\"\t\"GENE_SYMBOL\"\n" +
    "\"PROBE1\"\t\"TP53\"\n" +
    "!platform_table_end\n",
  "utf8",
));

/** Write the source + mapping assets under the task root and return the
 * task-relative references the tool consumes (bridge semantics). */
async function writeAssets(taskRoot: string): Promise<{
  source_files: Record<string, string>;
  mapping_files: Record<string, string>;
}> {
  const sourceDir = path.join(taskRoot, "source_assets", "asset_source");
  const mappingDir = path.join(taskRoot, "source_assets", "asset_mapping");
  await mkdir(sourceDir, { recursive: true });
  await mkdir(mappingDir, { recursive: true });
  await writeFile(path.join(sourceDir, "series_matrix.txt.gz"), SERIES_MATRIX);
  await writeFile(path.join(mappingDir, "gpl570_annot.txt.gz"), ANNOTATION);
  return {
    source_files: { binding_geo: "source_assets/asset_source/series_matrix.txt.gz" },
    mapping_files: { binding_geo: "source_assets/asset_mapping/gpl570_annot.txt.gz" },
  };
}

function unitCorrectionDecision() {
  return {
    action: "correct" as const,
    correction: {
      unit_conversion: {
        from_unit: "log10_expression",
        to_unit: "log2_expression",
        factor: 3.321928094887362,
        offset: 0,
        evidence: "log10(x) = log2(x) / log2(10) (test)",
      },
    },
  };
}

async function waitForPendingRequest(
  store: DurableHILStore,
  taskId: string,
  runId: string,
): Promise<NonNullable<Awaited<ReturnType<DurableHILStore["findPendingForRun"]>>>> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const request = await store.findPendingForRun(taskId, runId);
    if (request !== null) return request;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("pending HIL request never appeared");
}

async function waitForLivePendingGate(
  gate: DurableApprovalGate,
  runId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (gate.hasPending(runId)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("live HIL waiter never appeared");
}

describe("deterministic build continuation (cross-restart resume)", () => {
  test("a fresh core instance resumes a checkpointed build mid-canonicalize", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biomed-cont-core-"));
    roots.push(root);
    const repository = new DurableTaskRepository(root);
    const accepted = await repository.createTask({ requestId: "r1", input: "t", databases: [], mode: "agent" });
    const taskId = accepted.task_id;
    const runId = accepted.run_id;
    const taskRoot = path.join(root, taskId);
    await repository.appendRunEvent(taskId, runId, { type: "run_started" });
    const store = new DurableHILStore(repository);
    const assets = await writeAssets(taskRoot);

    // Instance A: suspends inside canonicalize on the unit_conversion request.
    const gateA = new DurableApprovalGate(taskId, repository, runId, store);
    const coreA = new TypeScriptDatasetCore({
      taskId,
      taskRoot,
      hilGate: gateA,
    });
    const suspended = coreA.executeDatasetBuild(unitHilSpec(), {
      runId: runId,
      sourceAssets: await resolveAssetMap(taskRoot, assets.source_files),
      mappingAssets: await resolveAssetMap(taskRoot, assets.mapping_files),
    });
    const request = await waitForPendingRequest(store, taskId, runId);
    expect(request.review_type).toBe("unit_conversion");
    expect(request.build_id).toBe(BUILD_ID);

    // Crash window: the original process dies while awaiting the review.
    // The lock dies with it (in-process: drop the lock dir so the successor
    // can acquire; the abandoned lease stops heartbeating once its owner
    // record is gone). The request itself stays PENDING in the store.
    await rm(path.join(taskRoot, "state", "build-locks", taskId, `${BUILD_ID}.lock`), {
      recursive: true,
      force: true,
    });

    // The user answers after the restart: the review is persisted, then the
    // new core instance replays the build. Parse is reused from the
    // checkpoint (rehydrated silently); canonicalize re-runs, sees the
    // resolved request through the store and completes without re-asking.
    await store.resolveRequest(taskId, runId, {
      request_id: request.request_id,
      evidence_digest: request.evidence_digest,
      decision: unitCorrectionDecision(),
      reason: "user answered after restart",
    });
    const events: Array<{ type: string; status?: string }> = [];
    const gateB = new DurableApprovalGate(taskId, repository, runId, store);
    const coreB = new TypeScriptDatasetCore({
      taskId: taskId,
      taskRoot,
      hilGate: gateB,
      eventSink: async (event) => {
        events.push({ type: event.type, ...("status" in event ? { status: event.status } : {}) });
      },
    });
    console.log("TEST1: starting coreB.execute");
    const record = await coreB.executeDatasetBuild(unitHilSpec(), {
      runId: runId,
      sourceAssets: await resolveAssetMap(taskRoot, assets.source_files),
      mappingAssets: await resolveAssetMap(taskRoot, assets.mapping_files),
    });
    expect(record).toBeDefined();
    expect(record.status).toBe("completed");
    expect(record.error).toBeNull();
    expect(record.publication_id).not.toBeNull();
    // Parse was reused from the checkpoint (skipped), canonicalize re-ran.
    expect(events).toContainEqual({ type: "operation_completed", status: "skipped" });
    expect(events).toContainEqual({ type: "operation_completed", status: "succeeded" });
    // No second blocking request was raised (same idempotency → resolved).
    expect(await store.findPendingForRun(taskId, runId)).toBeNull();
    // Instance A's executor is still parked on the original waiter (never
    // settles); keep the reference so it cannot be garbage collected.
    void suspended;
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  test("re-executing a completed build refuses stale publish reuse", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biomed-cont-reuse-"));
    roots.push(root);
    const repository = new DurableTaskRepository(root);
    const accepted = await repository.createTask({ requestId: "r1", input: "t", databases: [], mode: "agent" });
    const taskId = accepted.task_id;
    const runId = accepted.run_id;
    const taskRoot = path.join(root, taskId);
    await repository.appendRunEvent(taskId, runId, { type: "run_started" });
    const store = new DurableHILStore(repository);
    const assets = await writeAssets(taskRoot);
    const gate = new DurableApprovalGate(taskId, repository, runId, store);
    const first = new TypeScriptDatasetCore({ taskId, taskRoot, hilGate: gate });
    const execution = first.executeDatasetBuild(unitHilSpec(), {
      runId: runId,
      sourceAssets: await resolveAssetMap(taskRoot, assets.source_files),
      mappingAssets: await resolveAssetMap(taskRoot, assets.mapping_files),
    });
    const request = await waitForPendingRequest(store, taskId, runId);
    await waitForLivePendingGate(gate, runId);
    // The human answers while the first process is alive: the review is
    // persisted and delivered to the in-flight waiter.
    const review = await store.resolveRequest(taskId, runId, {
      request_id: request.request_id,
      evidence_digest: request.evidence_digest,
      decision: unitCorrectionDecision(),
      reason: "first build",
    });
    expect(gate.resolvePending(runId, review)).toBe(true);
    const recordA = await execution;
    expect(recordA.status).toBe("completed");

    const skipped: string[] = [];
    const second = new TypeScriptDatasetCore({
      taskId,
      taskRoot,
      hilGate: new DurableApprovalGate(taskId, repository, runId, store),
      eventSink: async (event) => {
        if (event.type === "operation_completed" && event.status === "skipped") {
          skipped.push(event.operationId);
        }
      },
    });
    const recordB = await second.executeDatasetBuild(unitHilSpec(), {
      runId: runId,
      sourceAssets: await resolveAssetMap(taskRoot, assets.source_files),
      mappingAssets: await resolveAssetMap(taskRoot, assets.mapping_files),
    });
    expect(recordB.status).toBe("failed");
    expect(recordB.publication_id).toBeNull();
    expect(recordB.error).toMatch(/version directory already exists|publication|atomic promotion/i);
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped).toContain("parse:binding_geo");
    expect(recordB.error).not.toContain(recordA.publication_id ?? "__missing_publication__");
  });
});

async function resolveAssetMap(
  taskRoot: string,
  references: Record<string, string>,
): Promise<Record<string, import("../../src/dataset/contracts/index.js").SourceAsset>> {
  const result: Record<string, unknown> = {};
  for (const [bindingId, reference] of Object.entries(references)) {
    const bytes = await readFile(path.join(taskRoot, reference));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    result[bindingId] = {
      schema_version: "1.0",
      asset_id: `asset_${sha256}`,
      kind: "source",
      relative_path: reference,
      sha256,
      size_bytes: bytes.length,
      media_type: reference.endsWith(".gz") ? "application/gzip" : "text/tab-separated-values",
      generated_by_step_id: null,
      source_id: `src_${bindingId}`,
      successful_attempt_id: "attempt_1",
      derived_from_asset_id: null,
      data_level: "repository_processed",
    };
  }
  return result as Record<string, import("../../src/dataset/contracts/index.js").SourceAsset>;
}

/** Adapter whose session runs the execute_dataset_build tool once; records
 * every prompt it receives so tests can prove no LLM turn happened. */
class ToolCallingAdapter implements BioMedAgentAdapter {
  readonly prompts: string[] = [];
  private readonly args: Record<string, unknown>;
  private readonly toolCallId: string;
  private readonly waitForAssets?: (taskId: string) => Promise<void>;

  constructor(
    args: Record<string, unknown>,
    toolCallId: string,
    waitForAssets?: (taskId: string) => Promise<void>,
  ) {
    this.args = args;
    this.toolCallId = toolCallId;
    this.waitForAssets = waitForAssets;
  }

  createSession(config: {
    taskId: string;
    runId: string;
    tools?: readonly import("../../src/agent/contracts.js").BioMedAgentTool[];
  }): Promise<BioMedAgentSession> {
    const args = this.args;
    const toolCallId = this.toolCallId;
    const prompts = this.prompts;
    const waitForAssets = this.waitForAssets;
    return Promise.resolve({
      piSessionId: `pi_${config.taskId}`,
      taskId: config.taskId,
      runId: config.runId,
      run: async function* (input: string): AsyncIterable<BioMedAgentEvent> {
        prompts.push(input);
        // The task id is assigned by the host at creation time, so the test
        // writes the source assets after createTask returns; wait for them
        // before the tool call starts.
        await waitForAssets?.(config.taskId);
        const tool = config.tools?.find((candidate) => candidate.name === "execute_dataset_build");
        if (tool === undefined) throw new Error("execute_dataset_build tool missing");
        yield { type: "turn_started" };
        yield {
          type: "tool_started",
          toolCallId,
          toolName: tool.name,
          arguments: args as Record<string, import("@biomed/contracts").JsonValue>,
        };
        const result: BioMedToolResult = await tool.execute(
          args,
          new AbortController().signal,
          { toolCallId },
        );
        yield { type: "tool_completed", toolCallId, toolName: tool.name, result, isError: result.isError === true };
        yield { type: "turn_completed" };
      },
      cancel: async () => undefined,
      steer: async () => undefined,
      dispose: async () => undefined,
    });
  }
}

describe("runtime restart simulation", () => {
  test("resolves a suspended build deterministically without any LLM turn", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biomed-cont-runtime-"));
    roots.push(root);
    const spec = unitHilSpec();
    const args = {
      spec,
      source_files: { binding_geo: "source_assets/asset_source/series_matrix.txt.gz" },
      mapping_files: { binding_geo: "source_assets/asset_mapping/gpl570_annot.txt.gz" },
    };
    // The task id is assigned by the host at creation time, so the test
    // writes the source assets after createTask returns; the session waits
    // for them before the tool call starts.
    const waitForAssets = async (taskId: string): Promise<void> => {
      const target = path.join(root, taskId, "source_assets", "asset_source", "series_matrix.txt.gz");
      for (let attempt = 0; attempt < 600; attempt += 1) {
        const { stat } = await import("node:fs/promises");
        if ((await stat(target).catch(() => null)) !== null) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("source assets never appeared");
    };

    const workspaceFactory = async (identity: {
      taskId: string;
      runId: string;
      approvalGate: import("../../src/runtime/approval-gate.js").ApprovalGateHandle;
      recordRunEvent: (payload: import("@biomed/contracts").EventPayload) => Promise<void>;
    }): Promise<import("../../src/runtime/durable-agent-runtime.js").DurableAgentWorkspace> => {
      const currentRoot = path.join(root, identity.taskId);
      let buildResult: import("@biomed/contracts").BuildResult | null = null;
      const core = new TypeScriptDatasetCore({
        taskId: identity.taskId,
        taskRoot: currentRoot,
        hilGate: identity.approvalGate,
        eventSink: async (event, buildId) => {
          await identity.recordRunEvent(coreEventToPayload(event, buildId));
        },
      });
      const service = createDatasetCoreService({ tsCore: core });
      const tools = createDatasetBuildTools({
        client: {
          validate: service.validate.bind(service),
          // The unit HIL trigger requires a declared unit the spec layer
          // would reject, so drive the REAL core directly here (spec
          // pre-validation is an orthogonal concern covered by other tests).
          execute: async (input) => {
            const sourceAssets: Record<string, import("../../src/dataset/contracts/index.js").SourceAsset> = {};
            const mappingAssets: Record<string, import("../../src/dataset/contracts/index.js").SourceAsset> = {};
            for (const [bindingId, reference] of Object.entries(input.sourceFiles ?? {})) {
              const bytes = await readFile(path.join(currentRoot, reference));
              const sha256 = createHash("sha256").update(bytes).digest("hex");
              sourceAssets[bindingId] = {
                schema_version: "1.0",
                asset_id: `asset_${sha256}`,
                kind: "source",
                relative_path: reference,
                sha256,
                size_bytes: bytes.length,
                media_type: "application/gzip",
                generated_by_step_id: null,
                source_id: `src_${bindingId}`,
                successful_attempt_id: "attempt_1",
                derived_from_asset_id: null,
                data_level: "repository_processed",
              };
            }
            for (const [bindingId, reference] of Object.entries(input.mappingFiles ?? {})) {
              const bytes = await readFile(path.join(currentRoot, reference));
              const sha256 = createHash("sha256").update(bytes).digest("hex");
              mappingAssets[bindingId] = {
                schema_version: "1.0",
                asset_id: `asset_${sha256}`,
                kind: "source",
                relative_path: reference,
                sha256,
                size_bytes: bytes.length,
                media_type: "application/gzip",
                generated_by_step_id: null,
                source_id: `src_${bindingId}`,
                successful_attempt_id: "attempt_1",
                derived_from_asset_id: null,
                data_level: "repository_processed",
              };
            }
            const record = await core.executeDatasetBuild(input.spec, {
              runId: input.runId,
              sourceAssets,
              mappingAssets,
              signal: input.signal,
            });
            if (record.status !== "completed") {
              return {
                version: 1 as const,
                request_id: `core_req_${record.build_id}`,
                ok: false as const,
                data: null,
                error: {
                  code: record.status === "cancelled" ? "cancelled" : "core_execution_error",
                  message: record.error ?? "Dataset Core execution failed",
                  retryable: record.status !== "cancelled",
                  details: {},
                },
              };
            }
            return {
              version: 1 as const,
              request_id: `core_req_${record.build_id}`,
              ok: true as const,
              data: {
                build_id: record.build_id,
                build_result: {
                  status: "succeeded" as const,
                  valid_row_count: record.manifest?.row_count ?? 0,
                  successful_sources: [],
                  rejected_sources: record.rejected_sources,
                  available_artifact_roles: [],
                  publication_id: record.publication_id,
                  reason_codes: [],
                  user_summary: "",
                  recommended_next_action: "",
                  build_id: record.build_id,
                },
                publication_id: record.publication_id,
                manifest: record.manifest === null ? null : {
                  build_id: record.manifest.build_id,
                  manifest_id: record.manifest.manifest_id,
                  sha256: record.manifest.sha256,
                },
                artifacts: [],
                validation_summary: null,
                registeredSourceAssetIds: [],
              },
              error: null,
            };
          },
        },
        taskId: identity.taskId,
        taskRoot: currentRoot,
        runId: () => identity.runId,
        piSessionId: () => "pi_session_test",
        onBuildResult: (result) => {
          buildResult = result;
        },
      });
      return {
        root: currentRoot,
        tools,
        consumeBuildResult: () => {
          const result = buildResult;
          buildResult = null;
          return result;
        },
        dispose: async () => undefined,
      };
    };

    const adapterA = new ToolCallingAdapter(args, "tc_1", waitForAssets);
    const runtimeA = await createDurableAgentRuntime({
      tasksRoot: root,
      adapter: adapterA,
      workspaceFactory,
    });
    const serverA = createServer((request, response) => {
      if (!runtimeA.handle(request, response)) response.writeHead(404).end();
    });
    serverA.listen(0, "127.0.0.1");
    await once(serverA, "listening");
    const portA = (serverA.address() as AddressInfo).port;

    const admitted = await fetch(`http://127.0.0.1:${portA}/api/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request_id: "request-cont", input: "build task", databases: [], mode: "agent" }),
    });
    const accepted = (await admitted.json()) as { task_id: string; run_id: string };
    const taskId = accepted.task_id;
    const runId = accepted.run_id;
    await writeAssets(path.join(root, taskId));

    // The build suspends on a durable unit_conversion request.
    const repository = new DurableTaskRepository(root);
    const store = new DurableHILStore(repository);
    const request = await waitForPendingRequest(store, taskId, runId);
    expect(request.build_id).toBe(BUILD_ID);
    // The tool persisted the invocation for deterministic replay.
    const record = await readBuildContinuation(path.join(root, taskId), BUILD_ID);
    if (record === null) {
      const { readdir } = await import("node:fs/promises");
      const dir = path.join(root, taskId, "state", "hil", "continuations");
      console.log("CONT_DIR", dir);
      console.log("CONT_LIST", JSON.stringify(await readdir(dir).catch((e) => `ERR ${e}`)));
      const hilDir = path.join(root, taskId, "state", "hil");
      console.log("HIL_LIST", JSON.stringify(await readdir(hilDir).catch((e) => `ERR ${e}`)));
    }
    expect(record).not.toBeNull();
    expect(record?.tool_call_id).toBe("tc_1");

    // "Restart": the first host is gone (its executor finalizes the build
    // as cancelled and releases the build lock, while the HIL request stays
    // pending in the store); a fresh runtime takes over the same tasksRoot
    // with a different adapter that records every prompt it receives.
    await runtimeA.close();
    serverA.close();
    const adapterB = new ToolCallingAdapter(args, "tc_1", waitForAssets);
    const runtimeB = await createDurableAgentRuntime({
      tasksRoot: root,
      adapter: adapterB,
      workspaceFactory,
    });
    const serverB = createServer((request, response) => {
      if (!runtimeB.handle(request, response)) response.writeHead(404).end();
    });
    serverB.listen(0, "127.0.0.1");
    await once(serverB, "listening");
    const portB = (serverB.address() as AddressInfo).port;

    const resolved = await fetch(
      `http://127.0.0.1:${portB}/api/v1/tasks/${taskId}/runs/${runId}/resume`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          request_id: request.request_id,
          evidence_digest: request.evidence_digest,
          decision: unitCorrectionDecision(),
          reason: "user answered after restart",
        }),
      },
    );
    expect(resolved.status).toBe(200);

    // The continuation drives the executor to completion — deterministically.
    let completed: { payload: { build_result?: { status?: string; publication_id?: string | null } | null } } | null = null;
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const events = await repository.listEvents(taskId, 0);
      const terminal = events.find(
        (event) => event.type === "run_completed" || event.type === "run_failed",
      ) as { payload: { build_result?: { status?: string; publication_id?: string | null } | null } } | undefined;
      if (terminal !== undefined) {
        completed = terminal;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(completed).not.toBeNull();
    expect(completed?.payload.build_result?.status).toBe("succeeded");
    expect(completed?.payload.build_result?.publication_id).not.toBeNull();

    const snapshot = await repository.getSnapshot(taskId);
    expect(snapshot?.task.status).toBe("completed");
    expect(snapshot?.runs.find((run) => run.run_id === runId)?.status).toBe("completed");

    // THE POINT: the model was never asked to continue anything — the
    // original session saw exactly one prompt (its initial input) and the
    // post-restart adapter was never invoked at all.
    expect(adapterA.prompts).toHaveLength(1);
    expect(adapterB.prompts).toHaveLength(0);

    // The original tool-call bubble was replayed and closed on the run.
    const events = await repository.listEvents(taskId, 0);
    const toolStarts = events.filter(
      (event) => event.type === "tool_started"
        && event.payload.type === "tool_started"
        && event.payload.tool_call_id === "tc_1",
    );
    const toolCompletions = events.filter(
      (event) => event.type === "tool_completed"
        && event.payload.type === "tool_completed"
        && event.payload.tool_call_id === "tc_1",
    );
    expect(toolStarts.length).toBe(2);
    expect(toolCompletions).toHaveLength(1);
    expect(toolCompletions[0]?.payload.type === "tool_completed" ? toolCompletions[0].payload.is_error : true).toBe(false);

    await runtimeB.close();
    serverB.close();
  });
});

describe("metadata_files asset wiring", () => {
  test("streams GEO SOFT metadata into the supporting sample-metadata table", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biomed-cont-meta-"));
    roots.push(root);
    const repository = new DurableTaskRepository(root);
    const accepted = await repository.createTask({
      requestId: "r1",
      input: "t",
      databases: [],
      mode: "agent",
    });
    const taskId = accepted.task_id;
    const runId = accepted.run_id;
    const taskRoot = path.join(root, taskId);
    await repository.appendRunEvent(taskId, runId, { type: "run_started" });
    const store = new DurableHILStore(repository);
    const assets = await writeAssets(taskRoot);

    const metadataDir = path.join(taskRoot, "source_assets", "asset_metadata");
    await mkdir(metadataDir, { recursive: true });
    const softReference = "source_assets/asset_metadata/family.soft";
    await writeFile(
      path.join(taskRoot, softReference),
      '^SAMPLE = GSM1\n!Sample_title = "E2E Metadata Title"\n',
    );

    const resolved: Array<{ bindingId: string; role: string }> = [];
    const gate = new DurableApprovalGate(taskId, repository, runId, store);
    const core = new TypeScriptDatasetCore({ taskId, taskRoot, hilGate: gate });
    const adapter = new TsDatasetCoreAdapter(core, {
      onAssetResolved: (record) => resolved.push(record),
    });

    const spec = parseDatasetBuildSpec({
      schema_version: "1.0",
      build_id: BUILD_ID,
      objective: "stream GEO SOFT metadata",
      dataset_family: "gene_expression",
      row_granularity: "gene_sample_measurement",
      schema_ref: "gene_expression.long.v1",
      source_bindings: [{
        schema_version: "1.0",
        binding_id: "binding_geo",
        source: "geo",
        acquisition: { schema_version: "1.0", mode: "builtin", provider_id: "geo.files.v1" },
        adapter_id: "geo.expression.v1",
        parameters: {
          schema_version: "1.0",
          format: "series_matrix",
          value_semantics: "normalized_expression",
          value_scale: "log2",
          expression_unit: "log2_expression",
          is_normalized: true,
          platform_ids: ["GPL570"],
          delimiter: "auto",
        },
      }],
      validation_profile_ref: "gene_expression.release.v1",
    });

    const response = await adapter.execute({
      taskId,
      runId,
      piSessionId: "pi_session",
      toolCallId: "tool_call_1",
      spec,
      sourceFiles: assets.source_files,
      mappingFiles: assets.mapping_files,
      metadataFiles: { binding_geo: softReference },
    });

    expect(response.ok).toBe(true);
    expect(
      resolved
        .filter((record) => record.role === "metadata")
        .map((record) => record.bindingId),
    ).toEqual(["binding_geo"]);

    const csvPath = path.join(
      taskRoot,
      "datasets_build",
      BUILD_ID,
      "supporting",
      "binding_geo_sample_metadata.csv",
    );
    const csv = await readFile(csvPath, "utf8");
    expect(csv).toContain("GSM1");
    expect(csv).toContain("E2E Metadata Title");
  });
});
