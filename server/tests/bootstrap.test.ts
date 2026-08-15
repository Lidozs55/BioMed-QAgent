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
      workspaceDevExec: false,
      database: shared.database,
      browserPool: shared.browserPool,
      vlmConfig: {
        apiKey: "vlm-key",
        baseUrl: "https://vlm.example/v1",
        model: "vlm-model",
      },
    }));
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
