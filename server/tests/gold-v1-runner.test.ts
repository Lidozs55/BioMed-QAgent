import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

const WORKTREE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RUNNER = path.join(WORKTREE_ROOT, "docs", "evaluation", "gold-v1", "run-case.mjs");
const GOLD6_PROMPT = path.join(
  WORKTREE_ROOT,
  "docs",
  "evaluation",
  "gold-v1",
  "prompts",
  "gold6.txt",
);
const GOLD6_PROMPT_SHA256 = "2267815c0bab859bc0b7488837bd4682ca4248d6fcf84b15e4af8414ab34c92e";

const servers: Server[] = [];
const temporaries: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(temporaries.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface CapturedExecutionContext {
  case_id?: unknown;
  prompt_sha256?: unknown;
  source_selection?: { papers?: unknown };
  [key: string]: unknown;
}

interface CapturedTaskRequest {
  requestId: unknown;
  input: unknown;
  databases: unknown;
  mode: unknown;
  executionContext: CapturedExecutionContext | null;
}

function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/** Local capture server standing in for POST /api/v1/tasks. */
async function startCaptureServer(): Promise<{ port: number; request: Promise<CapturedTaskRequest> }> {
  let resolveRequest!: (value: CapturedTaskRequest) => void;
  const request = new Promise<CapturedTaskRequest>((resolve) => {
    resolveRequest = resolve;
  });
  const server = createServer((incoming: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      resolveRequest({
        requestId: parsed.request_id,
        input: parsed.input,
        databases: parsed.databases,
        mode: parsed.mode,
        executionContext:
          (parsed.execution_context ?? null) as CapturedExecutionContext | null,
      });
      response.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({
        schema_version: "1.0",
        request_id: parsed.request_id,
        task_id: "task_capture",
        run_id: "run_capture",
        status: "queued",
      }));
    });
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("capture server not bound");
  return { port: address.port, request };
}

describe("gold-v1 runner (run-case.mjs)", () => {
  test("submits the frozen gold6 prompt bytes together with the frozen execution context", async () => {
    const capture = await startCaptureServer();
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "gold-v1-runner-"));
    temporaries.push(outputDir);
    const output = path.join(outputDir, "gold6-run.json");

    const child = spawn(
      process.execPath,
      [RUNNER, "gold6", "--base-url", `http://127.0.0.1:${capture.port}`, "--output", output],
      { cwd: WORKTREE_ROOT },
    );
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const exitCode = await new Promise<number | null>((resolve) =>
      child.on("exit", (code) => resolve(code)),
    );
    expect(exitCode, Buffer.concat(stderr).toString("utf8")).toBe(0);

    const request = await capture.request;
    expect(request.mode).toBe("agent");
    expect(request.databases).toEqual([]);
    expect(request.input).toBe(await readFile(GOLD6_PROMPT, "utf8"));
    expect(sha256(request.input as string)).toBe(GOLD6_PROMPT_SHA256);
    expect(request.executionContext?.case_id).toBe("gold6");
    expect(request.executionContext?.prompt_sha256).toBe(GOLD6_PROMPT_SHA256);
    expect(request.executionContext?.source_selection?.papers).toEqual([
      "PMC10408569",
      "PMC5355725",
      "PMC5094958",
    ]);

    // The run receipt mirrors the exact context that was submitted.
    const receipt = JSON.parse(await readFile(output, "utf8")) as {
      execution_context: CapturedExecutionContext;
    };
    expect(receipt.execution_context).toEqual(request.executionContext);
  });
});
