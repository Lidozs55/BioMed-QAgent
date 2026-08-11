import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import { startLegacyBackend } from "../src/legacy/backend-process.js";

describe("legacy backend ownership", () => {
  test("attach mode rejects non-loopback targets", async () => {
    await expect(
      startLegacyBackend(
        {
          legacyUrl: "http://192.168.1.10:8000",
          privatePort: 8000,
          repositoryRoot: "C:\\repo",
          platform: "win32",
        },
        {
          spawnChild: vi.fn(),
          terminateChild: vi.fn(),
          waitUntilReady: vi.fn(),
        },
      ),
    ).rejects.toThrow(/loopback/);
  });

  test("attach mode waits for readiness but never terminates the external backend", async () => {
    const terminateChild = vi.fn();
    const waitUntilReady = vi.fn(async () => undefined);
    const handle = await startLegacyBackend(
      {
        legacyUrl: "http://localhost:9000",
        privatePort: 8000,
        repositoryRoot: "/repo",
        platform: "linux",
      },
      { spawnChild: vi.fn(), terminateChild, waitUntilReady },
    );

    await handle.close();
    expect(waitUntilReady).toHaveBeenCalledWith("http://localhost:9000/api/v1/health");
    expect(terminateChild).not.toHaveBeenCalled();
  });

  test("managed mode uses backend virtualenv Python and cleans the child exactly once", async () => {
    const child = { id: "child" };
    const spawnChild = vi.fn(() => child);
    const terminateChild = vi.fn(async () => undefined);
    const waitUntilReady = vi.fn(async () => undefined);
    const handle = await startLegacyBackend(
      {
        privatePort: 8123,
        repositoryRoot: "C:\\repo",
        platform: "win32",
        bridgeSecret: "bridge-secret",
      },
      { spawnChild, terminateChild, waitUntilReady },
    );

    expect(spawnChild).toHaveBeenCalledWith({
      command: path.join("C:\\repo", "backend", ".venv", "Scripts", "python.exe"),
      args: [
        "-m",
        "uvicorn",
        "app.main:app",
        "--host",
        "127.0.0.1",
        "--port",
        "8123",
      ],
      cwd: path.join("C:\\repo", "backend"),
      environment: { PI_DATASET_BRIDGE_SECRET: "bridge-secret" },
    });
    expect(handle.bridgeSecret).toBe("bridge-secret");
    expect(waitUntilReady).toHaveBeenCalledWith("http://127.0.0.1:8123/api/v1/health");

    await handle.close();
    await handle.close();
    expect(terminateChild).toHaveBeenCalledOnce();
  });

  test("managed readiness failure terminates the owned child", async () => {
    const child = { id: "child" };
    const terminateChild = vi.fn(async () => undefined);
    await expect(
      startLegacyBackend(
        {
          privatePort: 8123,
          repositoryRoot: "/repo",
          platform: "linux",
        },
        {
          spawnChild: () => child,
          terminateChild,
          waitUntilReady: async () => {
            throw new Error("not ready");
          },
        },
      ),
    ).rejects.toThrow("not ready");
    expect(terminateChild).toHaveBeenCalledOnce();
  });
});
