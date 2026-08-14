import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import { createBootstrapOptions } from "../src/bootstrap.js";
import { parseHostConfig } from "../src/config.js";
import { NodeBrowserPool } from "../src/external/browser/pool.js";
import { DatabaseClient } from "../src/persistence/db-client.js";
import type { Phase3RuntimeOptions } from "../src/runtime/phase3-composition.js";

function services() {
  const database = new DatabaseClient({
    pythonBin: "unused",
    bridgePath: "unused",
    backendRoot: "unused",
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

describe("Phase 7 bootstrap", () => {
  test("default TS profile does not provision FastAPI and injects shared native services", async () => {
    const shared = services();
    const createLegacy = vi.fn();
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
      ...shared,
      createLegacy,
      createFormalRuntime,
    });

    expect(options.legacy).toBeUndefined();
    expect(options.formalRuntime).toBeDefined();
    await options.initializeLifecycle?.(options.lifecycle!);
    await options.formalRuntime?.({});

    expect(createLegacy).not.toHaveBeenCalled();
    expect(shared.browserPool.isStarted).toBe(true);
    expect(createFormalRuntime).toHaveBeenCalledWith(expect.objectContaining({
      datasetCore: "ts",
      database: shared.database,
      browserPool: shared.browserPool,
      vlmConfig: {
        apiKey: "vlm-key",
        baseUrl: "https://vlm.example/v1",
        model: "vlm-model",
      },
    }));
    expect(createFormalRuntime.mock.calls[0]?.[0]).not.toHaveProperty("legacyTarget");
    await options.lifecycle?.close();
  });

  test("explicit rollback profile provisions FastAPI and leaves formal Pi runtime disabled", async () => {
    const shared = services();
    const createLegacy = vi.fn(async () => ({
      target: "http://127.0.0.1:8123",
      bridgeSecret: "secret",
      close: async () => undefined,
    }));
    const options = await createBootstrapOptions({
      config: parseHostConfig({
        APP_HOST: "ts",
        AGENT_RUNTIME: "legacy",
        DATASET_CORE: "python",
        PI_EXPERIMENTAL: "0",
        PORT: "0",
      }),
      repositoryRoot: path.resolve("test-repository"),
      tasksRoot: path.resolve("test-tasks"),
      ...shared,
      createLegacy,
    });

    expect(options.legacy).toBeDefined();
    expect(options.formalRuntime).toBeUndefined();
    await options.initializeLifecycle?.(options.lifecycle!);
    expect(shared.browserPool.isStarted).toBe(false);
    await options.legacy?.();
    expect(createLegacy).toHaveBeenCalledOnce();
    await options.lifecycle?.close();
  });
});
