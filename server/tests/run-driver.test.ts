import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const repoRoot = path.resolve(import.meta.dirname, "../..");
const driver = path.join(repoRoot, "scripts", "run-driver.mjs");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server did not bind TCP");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

describe("run-driver agent HTTP wrapper", () => {
  test("retries startup 503 responses until health is ready", async () => {
    let attempts = 0;
    const server = await listen((request, response) => {
      expect(request.url).toBe("/api/v1/health");
      attempts += 1;
      json(response, attempts < 3 ? 503 : 200, { status: attempts < 3 ? "starting" : "ok" });
    });
    try {
      const result = await execFileAsync(process.execPath, [
        driver, "health", "--base-url", server.baseUrl, "--retries", "3", "--delay-ms", "1",
      ]);
      expect(attempts).toBe(3);
      expect(result.stdout).toContain("ready after 3 attempt(s)");
    } finally {
      await server.close();
    }
  });

  test("creates tasks from validated UTF-8 and pages durable events", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "run-driver-test-"));
    roots.push(root);
    const inputPath = path.join(root, "input.txt");
    await writeFile(inputPath, "研究 TP53 表达", "utf8");
    const requests: Array<{ method: string; url: string; body?: unknown }> = [];
    const server = await listen((request, response) => {
      void (async () => {
        if (request.method === "POST") {
          requests.push({ method: request.method, url: request.url ?? "", body: await body(request) });
          json(response, 202, { task_id: "task_1", run_id: "run_1" });
          return;
        }
        requests.push({ method: request.method ?? "", url: request.url ?? "" });
        json(response, 200, { events: [{ sequence: 8, type: "run_completed" }] });
      })().catch((error) => {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    });
    try {
      const created = await execFileAsync(process.execPath, [
        driver, "create", "--input", inputPath, "--request-id", "request_1", "--base-url", server.baseUrl,
      ]);
      const events = await execFileAsync(process.execPath, [
        driver, "events", "task 1", "--after", "7", "--limit", "25", "--base-url", server.baseUrl,
      ]);
      expect(created.stdout).toContain('"task_id":"task_1"');
      expect(events.stdout).toContain('"sequence":8');
      expect(requests).toEqual([
        {
          method: "POST",
          url: "/api/v1/tasks",
          body: { request_id: "request_1", input: "研究 TP53 表达", databases: [], mode: "agent" },
        },
        { method: "GET", url: "/api/v1/tasks/task%201/events?after_sequence=7&limit=25" },
      ]);
    } finally {
      await server.close();
    }
  });
});
