import { describe, expect, test, vi } from "vitest";

import type {
  BioMedAgentAdapter,
  BioMedAgentEvent,
  BioMedAgentSession,
  BioMedSessionConfig,
} from "../src/agent/contracts.js";
import { SessionRegistry } from "../src/agent/session-registry.js";

function fakeSession(config: BioMedSessionConfig): BioMedAgentSession {
  return {
    piSessionId: `pi-${config.runId}`,
    taskId: config.taskId,
    runId: config.runId,
    async *run(): AsyncIterable<BioMedAgentEvent> {
      yield { type: "turn_started" };
      yield { type: "assistant_delta", delta: "ok" };
      yield { type: "turn_completed" };
    },
    cancel: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  };
}

function fakeAdapter(): BioMedAgentAdapter {
  return { createSession: vi.fn(async (config) => fakeSession(config)) };
}

const config = { taskId: "task-1", runId: "run-1", cwd: process.cwd() } as const;

describe("SessionRegistry", () => {
  test("creates a fake adapter session and rejects duplicate active run IDs", async () => {
    const registry = new SessionRegistry(fakeAdapter());
    const session = await registry.create(config);

    expect(registry.get("run-1")).toBe(session);
    await expect(registry.create(config)).rejects.toMatchObject({ code: "DUPLICATE_RUN" });
  });

  test("cancel and dispose remove an entry exactly once", async () => {
    const registry = new SessionRegistry(fakeAdapter());
    const session = await registry.create(config);

    await registry.cancel("run-1", "stop");
    await registry.disposeOne("run-1");

    expect(session.cancel).toHaveBeenCalledWith("stop");
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(registry.get("run-1")).toBeUndefined();
  });

  test("disposeAll releases every session and is idempotent", async () => {
    const registry = new SessionRegistry(fakeAdapter());
    const first = await registry.create(config);
    const second = await registry.create({ ...config, runId: "run-2" });

    await registry.disposeAll();
    await registry.disposeAll();

    expect(first.dispose).toHaveBeenCalledOnce();
    expect(second.dispose).toHaveBeenCalledOnce();
    expect(registry.size).toBe(0);
  });
});
