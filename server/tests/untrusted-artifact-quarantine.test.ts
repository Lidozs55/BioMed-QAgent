import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import type {
  BioMedAgentAdapter,
  BioMedAgentEvent,
  BioMedAgentSession,
} from "../src/agent/contracts.js";
import { createDurableAgentRuntime } from "../src/runtime/durable-agent-runtime.js";

const servers: Server[] = [];
const roots: string[] = [];

const PAYLOAD = "gene,value\nTP53,1\n";
const VALID_METADATA = {
  schema_version: "1.0",
  name: "paper_supplement.csv",
  media_type: "text/csv",
  source_note: null,
  coverage_status: "partial",
  covered_scope: ["gene_expression"],
  missing_scope: ["variant_level"],
};

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

function submissionForm(
  metadata: Record<string, unknown> = VALID_METADATA,
  payload = PAYLOAD,
): FormData {
  const form = new FormData();
  form.set("metadata", JSON.stringify(metadata));
  form.set("file", new File([payload], "upload.csv", { type: "text/csv" }));
  return form;
}

function submit(base: string, taskId: string, form = submissionForm()): Promise<Response> {
  return fetch(`${base}/api/v1/tasks/${taskId}/quarantine`, {
    method: "POST",
    body: form,
  });
}

describe("untrusted artifact quarantine routes", () => {
  test("stores, lists, and downloads a submission without entering the formal chain", async () => {
    const fx = await fixture();
    await fx.close();

    const taskRoot = path.join(fx.tasksRoot, fx.taskId);
    const eventsBefore = await readFile(path.join(taskRoot, "events.jsonl"), "utf8");
    const submitted = await submit(fx.base, fx.taskId);
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
    const payload = Buffer.from(PAYLOAD, "utf8");
    expect(receipt).toMatchObject({
      task_id: fx.taskId,
      authoritative: false,
      trust: "untrusted",
      name: "paper_supplement.csv",
      media_type: "text/csv",
      schema_version: "1.0",
      coverage_status: "partial",
      covered_scope: ["gene_expression"],
      missing_scope: ["variant_level"],
      source_note: null,
      size_bytes: payload.length,
      sha256: createHash("sha256").update(payload).digest("hex"),
    });
    expect(receipt.submission_id).toMatch(/^ua_[0-9a-f]{24}$/);
    expect(new Date(receipt.submitted_at).toString()).not.toBe("Invalid Date");

    const submissionDir = path.join(taskRoot, "quarantine", receipt.submission_id);
    expect((await readdir(submissionDir)).sort()).toEqual(["artifact.bin", "receipt.json"]);
    expect(await readFile(path.join(submissionDir, "artifact.bin"))).toEqual(payload);

    const listing = await fetch(`${fx.base}/api/v1/tasks/${fx.taskId}/quarantine`);
    expect(listing.status).toBe(200);
    const listingBody = await listing.json() as {
      items: Array<{ submission_id: string; authoritative: boolean; trust: string }>;
    };
    expect(listingBody.items).toEqual([expect.objectContaining({
      submission_id: receipt.submission_id,
      authoritative: false,
      trust: "untrusted",
    })]);

    const single = await fetch(
      `${fx.base}/api/v1/tasks/${fx.taskId}/quarantine/${receipt.submission_id}`,
    );
    expect(single.status).toBe(200);
    expect(await single.json()).toMatchObject({ submission_id: receipt.submission_id });

    const content = await fetch(
      `${fx.base}/api/v1/tasks/${fx.taskId}/quarantine/${receipt.submission_id}/content`,
    );
    expect(content.status).toBe(200);
    expect(content.headers.get("x-untrusted-artifact")).toBe("true");
    expect(content.headers.get("content-disposition")).toContain("paper_supplement.csv");
    expect(Buffer.from(await content.arrayBuffer())).toEqual(payload);

    expect(await readFile(path.join(taskRoot, "events.jsonl"), "utf8")).toBe(eventsBefore);
    await expect(stat(path.join(taskRoot, "publish"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.join(taskRoot, "dataset_runs"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.join(taskRoot, "source_assets"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects unknown tasks, malformed multipart input, empty files, and bad ids", async () => {
    const fx = await fixture();
    await fx.close();

    expect((await submit(fx.base, "task_ts_does_not_exist")).status).toBe(404);
    const jsonRequest = await fetch(`${fx.base}/api/v1/tasks/${fx.taskId}/quarantine`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(jsonRequest.status).toBe(422);

    const missingMetadata = new FormData();
    missingMetadata.set("file", new File([PAYLOAD], "upload.csv"));
    expect((await submit(fx.base, fx.taskId, missingMetadata)).status).toBe(422);

    const missingFile = new FormData();
    missingFile.set("metadata", JSON.stringify(VALID_METADATA));
    expect((await submit(fx.base, fx.taskId, missingFile)).status).toBe(422);

    expect((await submit(fx.base, fx.taskId, submissionForm(VALID_METADATA, ""))).status).toBe(422);
    expect((await submit(fx.base, fx.taskId, submissionForm({
      ...VALID_METADATA,
      coverage_status: "verified",
    }))).status).toBe(422);
    expect((await submit(fx.base, fx.taskId, submissionForm({
      ...VALID_METADATA,
      unexpected: true,
    }))).status).toBe(422);

    expect((await fetch(`${fx.base}/api/v1/tasks/task_ts_none/quarantine`)).status).toBe(404);
    expect((await fetch(
      `${fx.base}/api/v1/tasks/${fx.taskId}/quarantine/ua_deadbeef`,
    )).status).toBe(404);
    expect((await fetch(
      `${fx.base}/api/v1/tasks/${fx.taskId}/quarantine/ua_deadbeef/content`,
    )).status).toBe(404);
    expect((await fetch(
      `${fx.base}/api/v1/tasks/${fx.taskId}/quarantine/..%2F..%2Fstate/content`,
    )).status).toBe(404);
  });

  test("creates independent receipts and rejects tampered bytes on download", async () => {
    const fx = await fixture();
    await fx.close();

    const first = await submit(fx.base, fx.taskId);
    const second = await submit(fx.base, fx.taskId);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstReceipt = await first.json() as { submission_id: string };
    const secondReceipt = await second.json() as { submission_id: string };
    expect(secondReceipt.submission_id).not.toBe(firstReceipt.submission_id);

    const listing = await fetch(`${fx.base}/api/v1/tasks/${fx.taskId}/quarantine`);
    expect((await listing.json() as { items: unknown[] }).items).toHaveLength(2);

    await writeFile(path.join(
      fx.tasksRoot,
      fx.taskId,
      "quarantine",
      firstReceipt.submission_id,
      "artifact.bin",
    ), "tampered");
    const content = await fetch(
      `${fx.base}/api/v1/tasks/${fx.taskId}/quarantine/${firstReceipt.submission_id}/content`,
    );
    expect(content.status).toBe(409);
  });

  test("deleting the task removes the quarantine directory with the task root", async () => {
    const fx = await fixture();
    await fx.close();

    expect((await submit(fx.base, fx.taskId)).status).toBe(201);
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
