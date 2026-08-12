import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import {
  startLegacyBackend,
  waitForLegacyReadiness,
  type SpawnChildInput,
} from "../src/legacy/backend-process.js";

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
        bridgeSecret: "attach-secret",
      },
      { spawnChild: vi.fn(), terminateChild, waitUntilReady },
    );

    await handle.close();
    expect(waitUntilReady).toHaveBeenCalledWith(
      "http://localhost:9000",
      "attach-secret",
    );
    expect(terminateChild).not.toHaveBeenCalled();
  });

  test("attach mode refuses to start without a non-empty bridge secret", async () => {
    await expect(
      startLegacyBackend(
        {
          legacyUrl: "http://localhost:9000",
          privatePort: 8000,
          repositoryRoot: "/repo",
          platform: "linux",
        },
        {
          spawnChild: vi.fn(),
          terminateChild: vi.fn(),
          waitUntilReady: vi.fn(),
        },
      ),
    ).rejects.toThrow(/bridge secret/i);
  });

  test("managed mode uses backend virtualenv Python and cleans the child exactly once", async () => {
    const child = { id: "child" };
    const spawnChild = vi.fn((input: SpawnChildInput) => {
      void input;
      return child;
    });
    const terminateChild = vi.fn(async () => undefined);
    const waitUntilReady = vi.fn(async () => undefined);
    const handle = await startLegacyBackend(
      {
        privatePort: 8123,
        repositoryRoot: "C:\\repo",
        platform: "win32",
        bridgeSecret: "bridge-secret",
      },
      {
        spawnChild,
        terminateChild,
        waitUntilReady,
        generateSecret: () => "per-launch-secret",
      },
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
      environment: { PI_DATASET_BRIDGE_SECRET: "per-launch-secret" },
    });
    expect(handle.bridgeSecret).toBe("per-launch-secret");
    expect(waitUntilReady).toHaveBeenCalledWith(
      "http://127.0.0.1:8123",
      "per-launch-secret",
      child,
    );

    await handle.close();
    await handle.close();
    expect(terminateChild).toHaveBeenCalledOnce();
  });

  test("managed mode allocates a private port when configured with zero", async () => {
    const child = { id: "child" };
    const spawnChild = vi.fn((input: SpawnChildInput) => {
      void input;
      return child;
    });
    const waitUntilReady = vi.fn(async () => undefined);
    const handle = await startLegacyBackend(
      {
        privatePort: 0,
        repositoryRoot: "/repo",
        platform: "linux",
      },
      {
        spawnChild,
        terminateChild: async () => undefined,
        waitUntilReady,
        allocatePrivatePort: async () => 43123,
      },
    );

    const spawned = spawnChild.mock.calls[0]?.[0];
    expect(spawned).toBeDefined();
    expect(spawned?.args).toContain("43123");
    expect(handle.target).toBe("http://127.0.0.1:43123");
    expect(waitUntilReady).toHaveBeenCalledWith(
      "http://127.0.0.1:43123",
      expect.any(String),
      child,
    );
    await handle.close();
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

  test("managed readiness is raced against early child exit", async () => {
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
          waitUntilReady: async (_target, _secret, spawned) => {
            expect(spawned).toBe(child);
            throw new Error("legacy child exited before readiness");
          },
        },
      ),
    ).rejects.toThrow(/exited before readiness/);
    expect(terminateChild).toHaveBeenCalledOnce();
  });

  test("does not accept a stale service already occupying the private port", async () => {
    const stale = createServer((request, response) => {
      if (request.url === "/api/v1/health") {
        response.writeHead(200).end("healthy but stale");
        return;
      }
      response.writeHead(403).end("wrong per-launch secret");
    });
    stale.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => stale.once("listening", resolve));
    const target = `http://127.0.0.1:${(stale.address() as AddressInfo).port}`;
    const child = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
    };
    child.exitCode = null;
    child.signalCode = null;
    try {
      const readiness = waitForLegacyReadiness(target, "new-launch-secret", 2_000, child as never);
      queueMicrotask(() => child.emit("exit", 1, null));

      await expect(readiness).rejects.toThrow(/exited before readiness/);
    } finally {
      await new Promise<void>((resolve, reject) =>
        stale.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  test("rejects a child that exited before readiness observation starts", async () => {
    const child = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
    };
    child.exitCode = 7;
    child.signalCode = null;

    await expect(
      waitForLegacyReadiness(
        "http://127.0.0.1:65535",
        "new-launch-secret",
        2_000,
        child as never,
      ),
    ).rejects.toThrow(/code=7/);
  });

  test("rejects an unrelated HTTP 200 response as a readiness identity", async () => {
    const stale = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "healthy" }));
    });
    stale.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => stale.once("listening", resolve));
    const target = `http://127.0.0.1:${(stale.address() as AddressInfo).port}`;
    try {
      await expect(
        waitForLegacyReadiness(target, "new-launch-secret", 50),
      ).rejects.toThrow(/did not become ready/);
    } finally {
      await new Promise<void>((resolve, reject) =>
        stale.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  test("managed close delegates descendant tree termination even after parent exit", async () => {
    const child = { id: "exited-parent" };
    const terminateChild = vi.fn(async () => undefined);
    const handle = await startLegacyBackend(
      {
        privatePort: 8123,
        repositoryRoot: "/repo",
        platform: "linux",
      },
      {
        spawnChild: () => child,
        terminateChild,
        waitUntilReady: async () => undefined,
      },
    );

    await handle.close();

    expect(terminateChild).toHaveBeenCalledWith(child);
  });
});
