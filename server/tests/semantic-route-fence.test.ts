import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import type { DatasetBridgeResponse } from "@biomed/contracts";
import { createDatasetExecutionTools } from "../src/agent/tools/dataset-execution.js";
import { createDefaultDatasetFamilyRegistry } from "../src/dataset/families/index.js";
import {
  createSemanticRouteFence,
  initializeSemanticRouteState,
  SemanticRouteFenceError,
  SemanticRouteFenceStateError,
} from "../src/runtime/semantic-route-fence.js";
import { datasetExecutionSpec as spec } from "./dataset-bridge-fixture.js";

const roots: string[] = [];

async function toolTaskRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biomed-route-fence-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("semantic route fence", () => {
  test("commits the dynamic route and replays it across restart", async () => {
    const taskRoot = await toolTaskRoot();
    const stateFile = path.join(taskRoot, "state", "semantic-route.json");
    await mkdir(path.dirname(stateFile), { recursive: true });
    await initializeSemanticRouteState({ taskRoot, stateFile });
    const fence = createSemanticRouteFence({ taskRoot, stateFile });
    expect(fence.isDynamicRouteCommitted()).toBe(false);

    await fence.commitDynamicRoute();
    expect(fence.isDynamicRouteCommitted()).toBe(true);
    await expect(fence.commitDynamicRoute()).resolves.toBeUndefined();

    const persisted = JSON.parse(await readFile(stateFile, "utf8")) as { route?: string };
    expect(persisted.route).toBe("dynamic_family");

    const restarted = createSemanticRouteFence({ taskRoot, stateFile });
    expect(restarted.isDynamicRouteCommitted()).toBe(true);
    expect(() => restarted.assertStaticRouteAllowed()).toThrow(SemanticRouteFenceError);
  });

  test("keeps the static route open for a fresh task and stays non-committing", async () => {
    const taskRoot = await toolTaskRoot();
    const stateFile = path.join(taskRoot, "state", "semantic-route.json");
    await mkdir(path.dirname(stateFile), { recursive: true });
    await initializeSemanticRouteState({ taskRoot, stateFile });
    const fence = createSemanticRouteFence({ taskRoot, stateFile });

    expect(() => fence.assertStaticRouteAllowed()).not.toThrow();
    expect(fence.isDynamicRouteCommitted()).toBe(false);
    // Initialization owns the only fresh-task write; inspection/assertion does
    // not change the explicit static route marker.
    await expect(readFile(stateFile, "utf8")).resolves.toContain('"route": "static"');

    // A corrupt marker must fail closed instead of reopening static execution.
    await writeFile(stateFile, "not json", "utf8");
    expect(() => createSemanticRouteFence({ taskRoot, stateFile })).toThrow(SemanticRouteFenceStateError);

    // A missing marker for an existing task is also not a fresh-task signal.
    await rm(stateFile, { force: true });
    expect(() => createSemanticRouteFence({ taskRoot, stateFile })).toThrow(SemanticRouteFenceStateError);
  });

  test("changed requirement_id cannot take the static route after dynamic commit", async () => {
    const taskRoot = await toolTaskRoot();
    const stateFile = path.join(taskRoot, "state", "semantic-route.json");
    await mkdir(path.dirname(stateFile), { recursive: true });
    await initializeSemanticRouteState({ taskRoot, stateFile });
    const fence = createSemanticRouteFence({ taskRoot, stateFile });
    await fence.commitDynamicRoute();

    const validate = vi.fn(async (): Promise<DatasetBridgeResponse> => ({
      version: 1,
      request_id: "request_validate",
      ok: true,
      data: { valid: true, reason_codes: [], reasons: [] },
      error: null,
    }));
    const execute = vi.fn(async (): Promise<DatasetBridgeResponse> => ({
      version: 1,
      request_id: "request_execute",
      ok: true,
      data: { valid: true, reason_codes: [], reasons: [] },
      error: null,
    }));
    const [validateTool, executeTool] = createDatasetExecutionTools({
      familyRegistry: createDefaultDatasetFamilyRegistry(),
      client: { validate, execute },
      taskId: "task_fenced",
      taskRoot,
      runId: () => "run_fenced",
      piSessionId: () => "pi_fenced",
      semanticRouteFence: fence,
    });

    // The R3/R4 escape: a *different* requirement_id than the one that went
    // dynamic, replayed against the static tools in the same run/task.
    const changedSpec = { ...spec, requirement_id: "build_2_changed" };

    const validateResult = await validateTool!.execute(
      { spec: changedSpec },
      new AbortController().signal,
      { toolCallId: "call_validate" },
    );
    expect(validateResult.isError).toBe(true);
    expect(validateResult.details).toMatchObject({ code: "route_fenced_dynamic", retryable: false });
    expect(validate).not.toHaveBeenCalled();

    const executeResult = await executeTool!.execute(
      { spec: changedSpec, source_files: {}, mapping_files: {}, metadata_files: {} },
      new AbortController().signal,
      { toolCallId: "call_execute" },
    );
    expect(executeResult.isError).toBe(true);
    expect(executeResult.details).toMatchObject({ code: "route_fenced_dynamic", retryable: false });
    expect(execute).not.toHaveBeenCalled();
  });

  test("rejects symlinked route state paths", async () => {
    const taskRoot = await toolTaskRoot();
    const outsideRoot = await toolTaskRoot();
    const stateDirectory = path.join(taskRoot, "state");
    await mkdir(stateDirectory, { recursive: true });
    const stateFile = path.join(stateDirectory, "semantic-route.json");
    const outsideFile = path.join(outsideRoot, "route.json");
    await writeFile(outsideFile, JSON.stringify({ schema_version: "1.0", route: "static" }), "utf8");
    await symlink(outsideFile, stateFile);

    expect(() => createSemanticRouteFence({ taskRoot, stateFile })).toThrow(SemanticRouteFenceStateError);
    await expect(initializeSemanticRouteState({ taskRoot, stateFile }))
      .rejects.toBeInstanceOf(SemanticRouteFenceStateError);
  });

  test("concurrent commits do not complete before the shared durable write", async () => {
    const taskRoot = await toolTaskRoot();
    const stateFile = path.join(taskRoot, "state", "semantic-route.json");
    await mkdir(path.dirname(stateFile), { recursive: true });
    await initializeSemanticRouteState({ taskRoot, stateFile });
    const fence = createSemanticRouteFence({ taskRoot, stateFile });

    await Promise.all([
      fence.commitDynamicRoute(),
      fence.commitDynamicRoute(),
      fence.commitDynamicRoute(),
    ]);
    await expect(readFile(stateFile, "utf8")).resolves.toContain('"route": "dynamic_family"');
    expect(() => fence.assertStaticRouteAllowed()).toThrow(SemanticRouteFenceError);
  });

  test("dynamic rejection does not unlock the fence", async () => {
    const taskRoot = await toolTaskRoot();
    const stateFile = path.join(taskRoot, "state", "semantic-route.json");
    await mkdir(path.dirname(stateFile), { recursive: true });
    await initializeSemanticRouteState({ taskRoot, stateFile });
    const fence = createSemanticRouteFence({ taskRoot, stateFile });
    await fence.commitDynamicRoute();

    // There is deliberately no unlock/clear API: a rejected dynamic
    // submission cannot reopen the static route for the task.
    expect(Object.keys(fence).sort()).toEqual([
      "assertStaticRouteAllowed",
      "commitDynamicRoute",
      "isDynamicRouteCommitted",
    ]);
    expect(() => fence.assertStaticRouteAllowed()).toThrow(SemanticRouteFenceError);
  });

  test("a genuinely fresh run stays independent of another task's fence", async () => {
    const validate = vi.fn(async (): Promise<DatasetBridgeResponse> => ({
      version: 1,
      request_id: "request_validate",
      ok: true,
      data: { valid: true, reason_codes: [], reasons: [] },
      error: null,
    }));
    const execute = vi.fn(async (): Promise<DatasetBridgeResponse> => ({
      version: 1,
      request_id: "request_execute",
      ok: true,
      data: { valid: true, reason_codes: [], reasons: [] },
      error: null,
    }));
    // Task A commits the dynamic route.
    const taskARoot = await toolTaskRoot();
    const taskAState = path.join(taskARoot, "state", "semantic-route.json");
    await mkdir(path.dirname(taskAState), { recursive: true });
    await initializeSemanticRouteState({ taskRoot: taskARoot, stateFile: taskAState });
    const fenceA = createSemanticRouteFence({ taskRoot: taskARoot, stateFile: taskAState });
    await fenceA.commitDynamicRoute();

    // Task B is a genuinely fresh run with its own task-scoped state file.
    const taskBRoot = await toolTaskRoot();
    const taskBState = path.join(taskBRoot, "state", "semantic-route.json");
    await mkdir(path.dirname(taskBState), { recursive: true });
    await initializeSemanticRouteState({ taskRoot: taskBRoot, stateFile: taskBState });
    const fenceB = createSemanticRouteFence({ taskRoot: taskBRoot, stateFile: taskBState });
    const [validateTool] = createDatasetExecutionTools({
      familyRegistry: createDefaultDatasetFamilyRegistry(),
      client: { validate, execute },
      taskId: "task_fresh",
      taskRoot: taskBRoot,
      runId: () => "run_fresh",
      piSessionId: () => "pi_fresh",
      semanticRouteFence: fenceB,
    });

    // Task A's committed route does not fence task B's static validate.
    const result = await validateTool!.execute({ spec }, new AbortController().signal, {
      toolCallId: "call_validate",
    });
    expect(result.isError).toBe(false);
    expect(validate).toHaveBeenCalledTimes(1);
  });
});
