import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import { createBootstrapOptions, resolveProductCommit } from "../src/bootstrap.js";
import { parseHostConfig } from "../src/config.js";
import { NodeBrowserPool } from "../src/external/browser/pool.js";
import { DatabaseClient } from "../src/persistence/db-client.js";
import type { Phase3RuntimeOptions } from "../src/runtime/phase3-composition.js";
import { DurableTaskRepository } from "../src/runtime/task-repository.js";

function services() {
  const database = new DatabaseClient({
    pythonBin: "unused",
    bridgePath: "unused",
  });
  const browserPool = new NodeBrowserPool({
    launcher: async () => {
      throw new Error("browser must launch lazily");
    },
  });
  const modelSettings = {
    handle: vi.fn(() => false),
    resolveActiveModel: vi.fn(),
    resolveVlmConfig: vi.fn(async () => ({
      apiKey: "vlm-key",
      baseUrl: "https://vlm.example/v1",
      model: "vlm-model",
    })),
  };
  const productApi = { handle: vi.fn(() => false) };
  return { database, browserPool, modelSettings, productApi };
}

describe("Phase 8 bootstrap (fixed TS/Pi/TS topology)", () => {
  test("uses an explicit validated product commit when the checkout is unavailable", () => {
    const commit = "a".repeat(40);
    expect(resolveProductCommit(path.resolve("missing-repository"), {
      BIOMED_PRODUCT_COMMIT: commit,
    })).toBe(commit);
    expect(() => resolveProductCommit(path.resolve("missing-repository"), {
      BIOMED_PRODUCT_COMMIT: "not-a-commit",
    })).toThrow(/BIOMED_PRODUCT_COMMIT/);
  });

  test("provisions the native services and always wires the formal TS runtime", async () => {
    const shared = services();
    const createFormalRuntime = vi.fn(async (runtimeOptions: Phase3RuntimeOptions) => {
      void runtimeOptions;
      return {
        handle: () => false,
        handleUpgrade: () => false,
        close: async () => undefined,
      };
    });
    const options = await createBootstrapOptions({
      config: parseHostConfig({ PORT: "0" }),
      repositoryRoot: path.resolve("test-repository"),
      tasksRoot: path.resolve("test-tasks"),
      workspacesRoot: path.resolve("test-workspaces"),
      ...shared,
      createFormalRuntime,
    });

    expect(options.hostApi).toBeDefined();
    expect(options.formalRuntime).toBeDefined();
    await options.initializeLifecycle?.(options.lifecycle!);
    await options.formalRuntime?.();

    expect(shared.browserPool.isStarted).toBe(true);
    expect(createFormalRuntime).toHaveBeenCalledWith(expect.objectContaining({
      agentExecPolicy: null,
      database: shared.database,
      browserPool: shared.browserPool,
      resolveVlmConfig: expect.any(Function),
    }));
    await options.lifecycle?.close();
  });

  test("threads deployment-owned browser and event-cache budgets", async () => {
    const shared = services();
    const createFormalRuntime = vi.fn(async (runtimeOptions: Phase3RuntimeOptions) => {
      void runtimeOptions;
      return {
        handle: () => false,
        handleUpgrade: () => false,
        close: async () => undefined,
      };
    });
    const taskRepository = new DurableTaskRepository(path.resolve("test-tasks"), {
      eventCacheMaxBytes: 128 * 1024 * 1024,
    });
    const options = await createBootstrapOptions({
      config: parseHostConfig({
        PORT: "0",
        BROWSER_MAX_CONTEXTS: "7",
        EVENT_CACHE_MAX_BYTES: "134217728",
      }),
      repositoryRoot: path.resolve("test-repository"),
      tasksRoot: path.resolve("test-tasks"),
      workspacesRoot: path.resolve("test-workspaces"),
      database: shared.database,
      modelSettings: shared.modelSettings,
      productApi: shared.productApi,
      taskRepository,
      createFormalRuntime,
    });

    await options.formalRuntime?.();
    const runtimeOptions = vi.mocked(createFormalRuntime).mock.calls[0]?.[0];
    expect(runtimeOptions?.browserPool?.maxContexts).toBe(7);
    expect(runtimeOptions?.repository).toBe(taskRepository);
    expect(runtimeOptions?.repository?.eventCacheMaxBytes).toBe(128 * 1024 * 1024);

    await options.initializeLifecycle?.(options.lifecycle!);
    await options.lifecycle?.close();
  });

  test("injects a lazy VLM config resolver so role changes apply without restart", async () => {
    const shared = services();
    const createFormalRuntime = vi.fn(async (runtimeOptions: Phase3RuntimeOptions) => {
      void runtimeOptions;
      return {
        handle: () => false,
        handleUpgrade: () => false,
        close: async () => undefined,
      };
    });
    const options = await createBootstrapOptions({
      config: parseHostConfig({ PORT: "0" }),
      repositoryRoot: path.resolve("test-repository"),
      tasksRoot: path.resolve("test-tasks"),
      workspacesRoot: path.resolve("test-workspaces"),
      ...shared,
      createFormalRuntime,
    });

    // Bootstrap must not snapshot the VLM config: nothing is resolved eagerly.
    expect(shared.modelSettings.resolveVlmConfig).not.toHaveBeenCalled();

    // The formal runtime factory receives the live resolver only when the
    // host builds a runtime.
    await options.formalRuntime?.();
    const runtimeOptions = vi.mocked(createFormalRuntime).mock.calls[0]?.[0];
    expect(typeof runtimeOptions?.resolveVlmConfig).toBe("function");
    expect(runtimeOptions).not.toHaveProperty("vlmConfig");

    // Each resolution consults the live settings service, so a visual-model
    // role change after Host bootstrap is visible on the next extraction call.
    await expect(runtimeOptions?.resolveVlmConfig?.()).resolves.toEqual({
      apiKey: "vlm-key",
      baseUrl: "https://vlm.example/v1",
      model: "vlm-model",
    });
    shared.modelSettings.resolveVlmConfig.mockResolvedValueOnce({
      apiKey: "vlm-key-2",
      baseUrl: "https://vlm2.example/v1",
      model: "vlm-model-2",
    });
    await expect(runtimeOptions?.resolveVlmConfig?.()).resolves.toEqual({
      apiKey: "vlm-key-2",
      baseUrl: "https://vlm2.example/v1",
      model: "vlm-model-2",
    });
    expect(shared.modelSettings.resolveVlmConfig).toHaveBeenCalledTimes(2);
    await options.initializeLifecycle?.(options.lifecycle!);
    await options.lifecycle?.close();
  });

  test("never provisions a legacy backend or experimental Pi runtime", async () => {
    const shared = services();
    const options = await createBootstrapOptions({
      config: parseHostConfig({ PORT: "0" }),
      repositoryRoot: path.resolve("test-repository"),
      tasksRoot: path.resolve("test-tasks"),
      workspacesRoot: path.resolve("test-workspaces"),
      ...shared,
    });

    expect(options).not.toHaveProperty("legacy");
    expect(options).not.toHaveProperty("experimentalPi");
    await options.initializeLifecycle?.(options.lifecycle!);
    await options.lifecycle?.close();
  });
});
