import { once } from "node:events";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import type {
  BioMedAgentAdapter,
  BioMedAgentEvent,
  BioMedAgentSession,
} from "../src/agent/contracts.js";
import {
  createDurableAgentRuntime,
} from "../src/runtime/durable-agent-runtime.js";

const servers: Server[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

class SilentAdapter implements BioMedAgentAdapter {
  readonly gates: Deferred[] = [];

  async createSession(config: { taskId: string; runId: string }): Promise<BioMedAgentSession> {
    const gate = deferred();
    this.gates.push(gate);
    const session: BioMedAgentSession = {
      piSessionId: `pi_${config.taskId}`,
      taskId: config.taskId,
      runId: config.runId,
      async *run(): AsyncIterable<BioMedAgentEvent> {
        yield { type: "turn_started" };
        await gate.promise;
        yield { type: "turn_completed" };
      },
      cancel: async () => {
        gate.resolve();
      },
      dispose: async () => undefined,
    };
    return session;
  }
}

interface RuntimeFixture {
  base: string;
  taskId: string;
  tasksRoot: string;
  adapter: SilentAdapter;
  close(): Promise<void>;
}

async function fixture(): Promise<RuntimeFixture> {
  const tasksRoot = await mkdtemp(path.join(os.tmpdir(), "biomed-quarantine-"));
  roots.push(tasksRoot);
  const adapter = new SilentAdapter();
  const runtime = await createDurableAgentRuntime({
    tasksRoot,
    adapter,
    workspaceFactory: async () => ({
      root: tasksRoot,
      tools: [],
      dispose: async () => undefined,
    }),
  });
  const server = createServer((request, response) => {
    if (!runtime.handle(request, response)) response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const admitted = await fetch(`${base}/api/v1/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      request_id: "request-quarantine",
      input: "quarantine review task",
      databases: [],
      mode: "agent",
    }),
  });
  expect(admitted.status).toBe(202);
  const accepted = await admitted.json() as { task_id: string; run_id: string };
  await new Promise((resolve) => setTimeout(resolve, 0));
  return {
    base,
    taskId: accepted.task_id,
    tasksRoot,
    adapter,
    close: () => runtime.close(),
  };
}

function submissionBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: "paper_supplement.csv",
    media_type: "text/csv",
    source_note: null,
    coverage_status: "partial",
    covered_scope: ["gene_expression"],
    missing_scope: ["variant_level"],
    bytes_base64: Buffer.from("gene,value\nTP53,1\n", "utf8").toString("base64"),
    idempotency_key: null,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete body[key];
    else body[key] = value;
  }
  return body;
}

async function submit(base: string, taskId: string, body: unknown): Promise<Response> {
  return fetch(`${base}/api/v1/tasks/${taskId}/quarantine`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("untrusted artifact quarantine routes", () => {
  test("stores a submission, serves receipt and bytes, and never enters the formal chain", async () => {
    const fx = await fixture();
    await fx.close();

    const submitted = await submit(fx.base, fx.taskId, submissionBody());
    expect(submitted.status).toBe(201);
    const receipt = await submitted.json() as {
      submission_id: string;
      task_id: string;
      authoritative: boolean;
      trust: string;
      size_bytes: number;
      sha256: string;
      submitted_at: string;
      name: string;
      media_type: string;
      coverage_status: string;
      covered_scope: string[];
      missing_scope: string[];
      schema_version: string;
      source_note: string | null;
    };
    const payload = Buffer.from("gene,value\nTP53,1\n", "utf8");
    const expectedSha256 = createHash("sha256").update(payload).digest("hex");
    expect(receipt.authoritative).toBe(false);
    expect(receipt.trust).toBe("untrusted");
    expect(receipt.task_id).toBe(fx.taskId);
    expect(receipt.size_bytes).toBe(payload.length);
    expect(receipt.sha256).toBe(expectedSha256);
    expect(receipt.schema_version).toBe("1.0");
    expect(receipt.coverage_status).toBe("partial");
    expect(receipt.covered_scope).toEqual(["gene_expression"]);
    expect(receipt.missing_scope).toEqual(["variant_level"]);
    expect(receipt.source_note).toBeNull();
    expect(receipt.submission_id).toMatch(/^ua_[0-9a-f]{24}$/);
    expect(receipt.submitted_at).toBeTruthy();

    // Storage lives under <taskRoot>/quarantine/<submission_id>/ with
    // receipt.json + artifact.bin (+ key.json only when a key was given).
    const submissionDir = path.join(fx.tasksRoot, fx.taskId, "quarantine", receipt.submission_id);
    const files = (await readdir(submissionDir)).sort();
    expect(files).toEqual(["artifact.bin", "receipt.json"]);
    expect(await readFile(path.join(submissionDir, "artifact.bin"))).toEqual(payload);
    expect(new Date(receipt.submitted_at).toString()).not.toBe("Invalid Date");

    // Listing returns the receipt; single receipt endpoint returns it too.
    const listing = await fetch(`${fx.base}/api/v1/tasks/${fx.taskId}/quarantine`);
    expect(listing.status).toBe(200);
    const listingBody = await listing.json() as { quarantine: Array<{ submission_id: string; authoritative: boolean; trust: string }> };
    expect(listingBody.quarantine).toHaveLength(1);
    expect(listingBody.quarantine[0]).toMatchObject({
      submission_id: receipt.submission_id,
      authoritative: false,
      trust: "untrusted",
    });

    const single = await fetch(
      `${fx.base}/api/v1/tasks/${fx.taskId}/quarantine/${receipt.submission_id}`,
    );
    expect(single.status).toBe(200);
    expect(await single.json()).toMatchObject({ submission_id: receipt.submission_id });

    // Content endpoint re-verifies digest + size before serving bytes.
    const content = await fetch(
      `${fx.base}/api/v1/tasks/${fx.taskId}/quarantine/${receipt.submission_id}/content`,
    );
    expect(content.status).toBe(200);
    expect(content.headers.get("x-untrusted-artifact")).toBe("true");
    expect(content.headers.get("content-disposition")).toContain("paper_supplement.csv");
    expect(Buffer.from(await content.arrayBuffer())).toEqual(payload);

    // No formal-chain writes: no publish/, no source_assets, no extra events.
    const taskRoot = path.join(fx.tasksRoot, fx.taskId);
    await expect(stat(path.join(taskRoot, "publish"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.join(taskRoot, "source_assets"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects unknown task, malformed input, empty bytes, and bad ids", async () => {
    const fx = await fixture();
    await fx.close();

    expect((await submit(fx.base, "task_ts_does_not_exist", submissionBody())).status).toBe(404);
    expect((await submit(fx.base, fx.taskId, { name: "only-name" })).status).toBe(422);
    expect((await submit(fx.base, fx.taskId, submissionBody({ bytes_base64: "" }))).status).toBe(422);
    expect(
      (await submit(fx.base, fx.taskId, submissionBody({ bytes_base64: "!!!!" }))).status,
    ).toBe(422);
    expect(
      (await submit(fx.base, fx.taskId, submissionBody({ coverage_status: "verified" }))).status,
    ).toBe(422);
    // Note: any parser-valid base64 decodes to ≥1 byte, so the store-level
    // zero-byte guard is defense in depth; the wire-level empty rejection is
    // the "" case asserted above.

    const listingUnknown = await fetch(`${fx.base}/api/v1/tasks/task_ts_none/quarantine`);
    expect(listingUnknown.status).toBe(404);
    const getUnknown = await fetch(`${fx.base}/api/v1/tasks/${fx.taskId}/quarantine/ua_deadbeef`);
    expect(getUnknown.status).toBe(404);
    const contentUnknown = await fetch(
      `${fx.base}/api/v1/tasks/${fx.taskId}/quarantine/ua_deadbeef/content`,
    );
    expect(contentUnknown.status).toBe(404);
    // Path-like submission ids never resolve.
    const traversal = await fetch(
      `${fx.base}/api/v1/tasks/${fx.taskId}/quarantine/..%2F..%2Fstate/content`,
    );
    expect(traversal.status).toBe(404);
  });

  test("idempotency key replays the same receipt and conflicts on digest mismatch", async () => {
    const fx = await fixture();
    await fx.close();

    const first = await submit(
      fx.base,
      fx.taskId,
      submissionBody({ idempotency_key: "review-round-1" }),
    );
    expect(first.status).toBe(201);
    const firstReceipt = await first.json() as { submission_id: string; sha256: string };

    // Same key + same digest → same receipt returned, no new submission.
    const replay = await submit(
      fx.base,
      fx.taskId,
      submissionBody({ idempotency_key: "review-round-1" }),
    );
    expect(replay.status).toBe(201);
    const replayReceipt = await replay.json() as { submission_id: string };
    expect(replayReceipt.submission_id).toBe(firstReceipt.submission_id);

    const listing = await fetch(`${fx.base}/api/v1/tasks/${fx.taskId}/quarantine`);
    expect((await listing.json() as { quarantine: unknown[] }).quarantine).toHaveLength(1);

    // Same key + different digest → 409 conflict.
    const conflict = await submit(
      fx.base,
      fx.taskId,
      submissionBody({
        idempotency_key: "review-round-1",
        bytes_base64: Buffer.from("different bytes", "utf8").toString("base64"),
      }),
    );
    expect(conflict.status).toBe(409);

    // A different key stores a new submission even for the same digest.
    const secondKey = await submit(
      fx.base,
      fx.taskId,
      submissionBody({ idempotency_key: "review-round-2" }),
    );
    expect(secondKey.status).toBe(201);
    const secondReceipt = await secondKey.json() as { submission_id: string };
    expect(secondReceipt.submission_id).not.toBe(firstReceipt.submission_id);
  });

  test("deleting the task removes the quarantine directory with the task root", async () => {
    const fx = await fixture();
    await fx.close();

    const submitted = await submit(fx.base, fx.taskId, submissionBody());
    expect(submitted.status).toBe(201);
    await submitted.json() as unknown;

    // The run must be terminal before deletion is allowed.
    fx.adapter.gates[0]?.resolve();
    await expect.poll(async () => {
      const snapshot = await fetch(`${fx.base}/api/v1/tasks/${fx.taskId}`);
      const body = await snapshot.json() as { task: { active_run_id: string | null } };
      return body.task.active_run_id;
    }, { timeout: 5_000 }).toBeNull();

    const deleted = await fetch(`${fx.base}/api/v1/tasks/${fx.taskId}`, { method: "DELETE" });
    expect(deleted.status).toBe(204);
    await expect(stat(path.join(fx.tasksRoot, fx.taskId))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
