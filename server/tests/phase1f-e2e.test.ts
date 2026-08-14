import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { EventEnvelope } from "@biomed/contracts";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";

import { createPhase1ExperimentalRuntime } from "../src/agent/phase1-composition.js";
import type { ExperimentalPiRuntime } from "../src/agent/experimental-pi.js";
import { createApplicationHost, type ApplicationHost } from "../src/app/create-app.js";
import { createLegacyBackend } from "../src/legacy/backend-process.js";

const SCHEMA_DIGEST = "bdc9a7c40d781976037cc91eb9bbd658b4b7fdbc7f8352ba19683a92a7a99c90";
let host: ApplicationHost | undefined;
let socket: WebSocket | undefined;
let outputRoot: string | undefined;
let previousOutputDir: string | undefined;

async function removeEventually(target: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError;
}

afterEach(async () => {
  socket?.close();
  socket = undefined;
  await host?.close();
  host = undefined;
  if (previousOutputDir === undefined) delete process.env.OUTPUT_DIR;
  else process.env.OUTPUT_DIR = previousOutputDir;
  previousOutputDir = undefined;
  if (outputRoot !== undefined) await removeEventually(outputRoot);
  outputRoot = undefined;
});

async function availablePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

class FrameCollector {
  private readonly frames: unknown[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(webSocket: WebSocket) {
    webSocket.on("message", (raw) => {
      this.frames.push(JSON.parse(raw.toString()) as unknown);
      for (const listener of this.listeners) listener();
    });
  }

  contains(predicate: (frame: unknown) => boolean): boolean {
    return this.frames.some(predicate);
  }

  async take<T>(predicate: (frame: unknown) => frame is T, timeoutMs = 30_000): Promise<T> {
    const found = (): T | undefined => {
      const index = this.frames.findIndex(predicate);
      if (index < 0) return undefined;
      return this.frames.splice(index, 1)[0] as T;
    };
    const immediate = found();
    if (immediate !== undefined) return immediate;
    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.listeners.delete(check);
        reject(new Error("Timed out waiting for experimental event"));
      }, timeoutMs);
      const check = (): void => {
        const frame = found();
        if (frame === undefined) return;
        clearTimeout(timeout);
        this.listeners.delete(check);
        resolve(frame);
      };
      this.listeners.add(check);
    });
  }
}

function eventFor(taskId: string, type: string) {
  return (frame: unknown): frame is EventEnvelope => {
    if (frame === null || typeof frame !== "object") return false;
    const value = frame as Partial<EventEnvelope>;
    return value.task_id === taskId && value.type === type;
  };
}

function toolEventFor(taskId: string, toolName: string, toolCallId?: string) {
  return (frame: unknown): frame is EventEnvelope => {
    if (!eventFor(taskId, "tool_completed")(frame)) return false;
    return frame.payload.type === "tool_completed" &&
      frame.payload.tool_name === toolName &&
      (toolCallId === undefined || frame.payload.tool_call_id === toolCallId);
  };
}

function toolStartedFor(taskId: string, toolName: string) {
  return (frame: unknown): frame is EventEnvelope => {
    if (!eventFor(taskId, "tool_started")(frame)) return false;
    return frame.payload.type === "tool_started" && frame.payload.tool_name === toolName;
  };
}

async function createFixtureTask(
  publicUrl: string,
  profile: string,
): Promise<{ task_id: string; run_id: string; session_id: string }> {
  const response = await fetch(`${publicUrl}/experimental/pi/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: `run ${profile}`, fixture_profile: profile }),
  });
  expect(response.status).toBe(201);
  return await response.json() as { task_id: string; run_id: string; session_id: string };
}

describe("Phase 1F offline vertical slice", () => {
  test("streams real Core SUCCESS and SPEC_REJECTED through one public Host", async () => {
    const repositoryRoot = path.resolve(process.cwd(), "..");
    outputRoot = await mkdtemp(path.join(os.tmpdir(), "biomed-phase1f-"));
    previousOutputDir = process.env.OUTPUT_DIR;
    process.env.OUTPUT_DIR = outputRoot;
    const legacyPort = await availablePort();
    let experimentalRuntime: ExperimentalPiRuntime | undefined;
    host = await createApplicationHost({
      publicHost: "127.0.0.1",
      publicPort: 0,
      legacy: () => createLegacyBackend({
        repositoryRoot,
        privatePort: legacyPort,
        bridgeSecret: "phase1f-offline-secret",
        readinessTimeoutMs: 30_000,
        shutdownTimeoutMs: 10_000,
      }),
      experimentalPi: async ({ target, bridgeSecret }) => {
        if (target === undefined) throw new Error("legacy target missing");
        experimentalRuntime = await createPhase1ExperimentalRuntime({
          repositoryRoot,
          tasksRoot: path.join(outputRoot!, "tasks"),
          legacyTarget: target,
          bridgeSecret,
          workspaceDevExec: true,
        });
        return experimentalRuntime;
      },
      frontend: async () => ({
        middleware: (_request, response) => response.end("phase1f frontend"),
        close: async () => undefined,
      }),
    });
    const publicPort = (host.server.address() as AddressInfo).port;
    const publicUrl = `http://127.0.0.1:${publicPort}`;
    expect((await fetch(`${publicUrl}/api/v1/health`)).status).toBe(200);
    expect((await fetch(`${publicUrl}/internal/migration/pi/dataset/operations`)).status).toBe(404);

    socket = new WebSocket(`ws://127.0.0.1:${publicPort}/experimental/pi/ws`);
    await once(socket, "open");
    const frames = new FrameCollector(socket);

    const workspace = await createFixtureTask(publicUrl, "workspace");
    socket.send(JSON.stringify({ type: "subscribe", task_id: workspace.task_id }));
    await frames.take((frame): frame is { type: "subscribed"; task_id: string } =>
      typeof frame === "object" && frame !== null &&
      (frame as { type?: string }).type === "subscribed" &&
      (frame as { task_id?: string }).task_id === workspace.task_id,
    );
    const command = await frames.take(toolEventFor(workspace.task_id, "workspace_exec"));
    expect(JSON.stringify(command.payload)).toContain("fixture-command-ok");
    const protectedArtifact = await frames.take(toolEventFor(
      workspace.task_id,
      "workspace_edit",
      "fixture-protected-artifact",
    ));
    const protectedState = await frames.take(toolEventFor(
      workspace.task_id,
      "workspace_edit",
      "fixture-protected-state",
    ));
    expect([protectedArtifact, protectedState].every((event) =>
      event.payload.type === "tool_completed" && event.payload.is_error,
    )).toBe(true);
    await frames.take(eventFor(workspace.task_id, "run_completed"));
    expect(await readFile(
      path.join(outputRoot, "tasks", workspace.task_id, "staging", "agent", "note.txt"),
      "utf8",
    )).toBe("fixture note: observed");
    const audit = await readFile(
      path.join(outputRoot, "tasks", workspace.task_id, "logs", "workspace-audit.jsonl"),
      "utf8",
    );
    expect(audit).toMatch(/"operation":"read".*"operation":"write".*"operation":"edit".*"operation":"exec"/s);
    expect(audit).not.toContain("phase1f-offline-secret");
    expect(audit).not.toContain(process.execPath);

    const cancelled = await createFixtureTask(publicUrl, "workspace_cancel");
    socket.send(JSON.stringify({ type: "subscribe", task_id: cancelled.task_id }));
    await frames.take((frame): frame is { type: "subscribed"; task_id: string } =>
      typeof frame === "object" && frame !== null &&
      (frame as { type?: string }).type === "subscribed" &&
      (frame as { task_id?: string }).task_id === cancelled.task_id,
    );
    await frames.take(toolStartedFor(cancelled.task_id, "workspace_exec"));
    const cancelResponse = await fetch(
      `${publicUrl}/experimental/pi/tasks/${cancelled.task_id}/runs/${cancelled.run_id}/cancel`,
      { method: "POST" },
    );
    expect(cancelResponse.status).toBe(202);
    await frames.take(eventFor(cancelled.task_id, "run_cancel_requested"));
    await frames.take(eventFor(cancelled.task_id, "run_cancelled"));
    expect(frames.contains(eventFor(cancelled.task_id, "run_completed"))).toBe(false);
    expect(experimentalRuntime?.diagnostics()).toMatchObject({
      activeRuns: 0,
      activeCommands: 0,
    });

    const success = await createFixtureTask(publicUrl, "dataset_success");
    socket.send(JSON.stringify({ type: "subscribe", task_id: success.task_id }));
    await frames.take((frame): frame is { type: "subscribed"; task_id: string } =>
      typeof frame === "object" && frame !== null &&
      (frame as { type?: string }).type === "subscribed" &&
      (frame as { task_id?: string }).task_id === success.task_id,
    );
    const execute = await frames.take(toolEventFor(success.task_id, "execute_dataset_build"));
    expect(execute.payload).toMatchObject({
      type: "tool_completed",
      tool_name: "execute_dataset_build",
      is_error: false,
    });
    const assistant = await frames.take(eventFor(success.task_id, "assistant_delta"));
    expect(JSON.stringify(assistant.payload)).toMatch(/golden_succeeded.*pub_/s);
    await frames.take(eventFor(success.task_id, "run_completed"));

    const build = await fetch(`${publicUrl}/api/v1/builds/golden_succeeded?task_id=${success.task_id}`);
    expect(build.status).toBe(200);
    const buildText = await build.text();
    expect(buildText).toContain(SCHEMA_DIGEST);
    expect(buildText).toContain("primary_dataset");
    expect(buildText).toContain("publication_id");

    const followUp = await fetch(`${publicUrl}/experimental/pi/tasks/${success.task_id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "summarize the actual publication" }),
    });
    expect(followUp.status).toBe(202);
    expect((await followUp.json()) as object).toMatchObject({ session_id: success.session_id });
    await frames.take(eventFor(success.task_id, "run_completed"));

    const rejected = await createFixtureTask(publicUrl, "spec_rejected");
    socket.send(JSON.stringify({ type: "subscribe", task_id: rejected.task_id }));
    await frames.take((frame): frame is { type: "subscribed"; task_id: string } =>
      typeof frame === "object" && frame !== null &&
      (frame as { type?: string }).type === "subscribed" &&
      (frame as { task_id?: string }).task_id === rejected.task_id,
    );
    const rejectedTool = await frames.take(toolEventFor(rejected.task_id, "validate_dataset_build"));
    expect(rejectedTool.payload).toMatchObject({
      type: "tool_completed",
      tool_name: "validate_dataset_build",
      is_error: true,
    });
    expect(JSON.stringify(rejectedTool.payload)).toContain("unknown_schema");
    const rejectedAssistant = await frames.take(eventFor(rejected.task_id, "assistant_delta"));
    expect(JSON.stringify(rejectedAssistant.payload)).toMatch(/SPEC_REJECTED.*unknown_schema/s);
    await frames.take(eventFor(rejected.task_id, "run_completed"));
    expect(await readFile(
      path.join(outputRoot, "tasks", rejected.task_id, "source_assets", "phase1f-source.tsv"),
      "utf8",
    )).toContain("gene_id");
    await expect(readFile(
      path.join(outputRoot, "tasks", rejected.task_id, "artifacts", "publication.json"),
      "utf8",
    )).rejects.toMatchObject({ code: "ENOENT" });

    socket.close();
    await once(socket, "close");
    socket = undefined;
    await host.close();
    host = undefined;
    expect(experimentalRuntime?.diagnostics()).toEqual({
      tasks: 0,
      activeRuns: 0,
      listeners: 0,
      webSockets: 0,
      activeCommands: 0,
    });
    await expect(fetch(`http://127.0.0.1:${legacyPort}/api/v1/health`, {
      signal: AbortSignal.timeout(1_000),
    })).rejects.toThrow();
  }, 120_000);
});
