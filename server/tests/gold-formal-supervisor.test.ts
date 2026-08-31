import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";

import { afterEach, describe, expect, test } from "vitest";

const supervisorUrl = new URL("../../scripts/gold-formal-supervisor.mjs", import.meta.url);
const supervisorModule = await import(supervisorUrl.href);
const {
  EXIT_CODES,
  classifyHIL,
  classifyPermission,
  classifyTerminal,
  createApiClient,
  currentPublicationIdFrom,
  digestManifestFile,
  digestPackage,
  redacted: redactEvidence,
  supervise,
  validateCleanUtf8Bytes,
  verifyArtifactBytes,
} = supervisorModule;
type JsonRecord = Record<string, unknown>;
const roots: string[] = [];
const TASK_ID = "task_ts_fixture";
const RUN_ID = "run_ts_fixture";
const REQUEST_ID = "request_fixture";
const PUBLICATION_ID = "publication_fixture";
const HIL_REQUEST_ID = "hil_fixture";
const HIL_DIGEST = "a".repeat(64);
const WORKSPACE_ROOT = path.join(tmpdir(), "gold-formal-workspace", TASK_ID);

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const ARTIFACT_BYTES = Buffer.from("artifact bytes\n", "utf8");
const MANIFEST_BYTES = Buffer.from("{\"manifest\":true}\n", "utf8");
const MANIFEST_SHA = sha256Hex(MANIFEST_BYTES);
const DATA_ARTIFACT = {
  schema_version: "1.0",
  artifact_id: "artifact_data",
  role: "primary_dataset",
  relative_path: "merged/data.csv",
  media_type: "text/csv",
  size_bytes: ARTIFACT_BYTES.length,
  sha256: sha256Hex(ARTIFACT_BYTES),
};
/** Same path+NUL+sha algorithm the Dataset Core publisher uses. */
const PACKAGE_DIGEST = digestPackage([{ relative_path: DATA_ARTIFACT.relative_path, sha256: DATA_ARTIFACT.sha256 }]);
const PUBLICATION_DETAIL = {
  publication_id: PUBLICATION_ID,
  requirement_id: "req_fixture",
  run_id: RUN_ID,
  task_id: TASK_ID,
  manifest_ref: "dataset_runs/run_ts_fixture/req_fixture/publish/publication_fixture/dataset_manifest.json",
  manifest: {
    manifest_id: `manifest_${PACKAGE_DIGEST.slice(0, 16)}`,
    task_id: TASK_ID,
    dataset_family: "fixture_family",
    row_granularity: "record",
    schema_ref: "fixture.record.v1",
    row_count: 1,
    sha256: PACKAGE_DIGEST,
    artifacts: [DATA_ARTIFACT],
  },
  publication: {
    schema_version: "1.1",
    publication_id: PUBLICATION_ID,
    manifest_ref: "dataset_runs/run_ts_fixture/req_fixture/publish/publication_fixture/dataset_manifest.json",
    manifest_sha256: MANIFEST_SHA,
    validation_result_ref: "validation_fixture",
    published_at: "2026-08-26T00:00:03.000Z",
    supersedes_publication_id: null,
  },
  artifacts: [DATA_ARTIFACT],
};

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function event(sequence: number, payload: JsonRecord, type = String(payload.type ?? "")): JsonRecord {
  return {
    schema_version: "2.0",
    event_id: `event_${sequence}`,
    type,
    task_id: TASK_ID,
    run_id: RUN_ID,
    stage_attempt_id: null,
    sequence,
    timestamp: `2026-08-26T00:00:0${sequence}.000Z`,
    payload,
  };
}

function taskSnapshot(status: string, activeRunId: string | null, currentPublicationId: string | null = null): JsonRecord {
  return {
    task: {
      task_id: TASK_ID,
      mode: "agent",
      databases: [],
      title: "fixture",
      status,
      active_run_id: activeRunId,
      created_at: "2026-08-26T00:00:00.000Z",
      updated_at: "2026-08-26T00:00:00.000Z",
      latest_sequence: 3,
    },
    runs: [{
      run_id: RUN_ID,
      task_id: TASK_ID,
      request_id: REQUEST_ID,
      status,
      input: "fixture prompt",
      created_at: "2026-08-26T00:00:00.000Z",
      updated_at: "2026-08-26T00:00:00.000Z",
      started_at: "2026-08-26T00:00:00.000Z",
      finished_at: status === "completed" ? "2026-08-26T00:00:03.000Z" : null,
      error: null,
      summary: null,
    }],
    messages: [],
    older_messages_cursor: null,
    current_publication_id: currentPublicationId,
    publications: currentPublicationId === null ? [] : [{
      publication_id: currentPublicationId,
      manifest_sha256: MANIFEST_SHA,
      supersedes_publication_id: null,
      published_at: "2026-08-26T00:00:03.000Z",
    }],
  };
}

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture server did not bind");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function setup(): Promise<{ root: string; promptFile: string; evidenceDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "gold-formal-supervisor-"));
  roots.push(root);
  const promptFile = path.join(root, "prompt.txt");
  const evidenceDir = path.join(root, "evidence");
  await writeFile(promptFile, "研究 TP53 的表达\n", "utf8");
  await mkdir(WORKSPACE_ROOT, { recursive: true });
  return { root, promptFile, evidenceDir };
}

function options(values: { baseUrl: string; promptFile: string; evidenceDir: string; resume?: boolean; adopt?: boolean }): JsonRecord {
  return {
    baseUrl: values.baseUrl,
    taskId: TASK_ID,
    requestId: REQUEST_ID,
    promptFile: values.promptFile,
    evidenceDir: values.evidenceDir,
    timeoutMs: 2_000,
    caseLabel: "fixture",
    expectedCommit: "f".repeat(40),
    pageSize: 2,
    resume: values.resume ?? false,
    adopt: values.adopt ?? false,
  };
}

function hilRequiredEvent(sequence = 1): JsonRecord {
  return event(sequence, {
    type: "user_input_required",
    request_id: HIL_REQUEST_ID,
    prompt_kind: "data_correction",
    summary: "Review the publication candidate",
    expires_at: null,
    fixture_exempt: false,
    detail: {},
    hil_request: {
      request_id: HIL_REQUEST_ID,
      task_id: TASK_ID,
      run_id: RUN_ID,
      kind: "data_review",
      review_type: "publication_acceptance",
      evidence_digest: HIL_DIGEST,
    },
  }, "user_input_required");
}

function hilResumedEvent(sequence = 2, evidenceDigest = HIL_DIGEST): JsonRecord {
  return event(sequence, {
    type: "user_input_resumed",
    request_id: HIL_REQUEST_ID,
    decision: { action: "accept" },
    detail: { evidence_digest: evidenceDigest, review_id: "review_fixture" },
  }, "user_input_resumed");
}

async function seedPendingHil(evidenceDir: string, records: JsonRecord[] = [hilRequiredEvent()]): Promise<void> {
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(path.join(evidenceDir, "events.jsonl"), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  await writeFile(path.join(evidenceDir, "supervisor-state.json"), `${JSON.stringify({
    version: 1,
    after_sequence: records.length,
    task_id: TASK_ID,
    case_label: "fixture",
    request_id: REQUEST_ID,
    run_id: RUN_ID,
    stopped: true,
    pending_hil: {
      request_id: HIL_REQUEST_ID,
      evidence_digest: HIL_DIGEST,
      kind: "data_review",
      review_type: "publication_acceptance",
      request: {
        request_id: HIL_REQUEST_ID,
        task_id: TASK_ID,
        run_id: RUN_ID,
        kind: "data_review",
        review_type: "publication_acceptance",
        evidence_digest: HIL_DIGEST,
      },
    },
  })}\n`, "utf8");
}

function healthy(): JsonRecord {
  return { status: "ok", app_host: "ts", agent_runtime: "pi", dataset_core: "ts" };
}

function apiServer(config: { events: JsonRecord[] | (() => JsonRecord[]); snapshot: JsonRecord | (() => JsonRecord); completeOnRun?: boolean; onRun?: (body: JsonRecord) => void; onPermission?: (body: JsonRecord) => void; onResume?: (body: JsonRecord) => void }): Promise<{ server: Server; baseUrl: string }> {
  let snapshotOverride: JsonRecord | null = null;
  const currentEvents = (): JsonRecord[] => typeof config.events === "function" ? config.events() : config.events;
  const currentSnapshot = (): JsonRecord => snapshotOverride ?? (typeof config.snapshot === "function" ? config.snapshot() : config.snapshot);
  return listen((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://fixture");
      if (url.pathname === "/api/v1/health") { json(response, 200, healthy()); return; }
      if (url.pathname === `/api/v1/tasks/${TASK_ID}` && request.method === "GET") { json(response, 200, currentSnapshot()); return; }
      if (url.pathname === `/api/v1/tasks/${TASK_ID}/events` && request.method === "GET") {
        const after = Number(url.searchParams.get("after_sequence") ?? "0");
        const limit = Number(url.searchParams.get("limit") ?? "100");
        json(response, 200, { events: currentEvents().filter((item) => Number(item.sequence) > after).slice(0, limit) });
        return;
      }
      if (url.pathname === `/api/v1/tasks/${TASK_ID}/runs` && request.method === "POST") {
        config.onRun?.(JSON.parse(await readBody(request)) as JsonRecord);
        const currentPublicationId = config.completeOnRun === true ? PUBLICATION_ID : null;
        snapshotOverride = taskSnapshot(config.completeOnRun ? "completed" : "running", config.completeOnRun ? null : RUN_ID, currentPublicationId);
        json(response, 202, { schema_version: "1.0", request_id: REQUEST_ID, task_id: TASK_ID, run_id: RUN_ID, status: "queued" });
        return;
      }
      if (url.pathname.startsWith(`/api/v1/tasks/${TASK_ID}/runs/${RUN_ID}/permissions/`) && request.method === "POST") {
        config.onPermission?.(JSON.parse(await readBody(request)) as JsonRecord);
        json(response, 200, { status: "resolved" });
        return;
      }
      if (url.pathname === `/api/v1/tasks/${TASK_ID}/runs/${RUN_ID}/resume` && request.method === "POST") {
        config.onResume?.(JSON.parse(await readBody(request)) as JsonRecord);
        snapshotOverride = taskSnapshot("completed", null, PUBLICATION_ID);
        json(response, 200, currentSnapshot());
        return;
      }
      if (url.pathname === `/api/v1/publications/${PUBLICATION_ID}` && request.method === "GET") { json(response, 200, PUBLICATION_DETAIL); return; }
      const pubArtifact = new RegExp(`^/api/v1/publications/${PUBLICATION_ID}/artifacts/([^/]+)$`).exec(url.pathname);
      if (pubArtifact !== null && request.method === "GET") {
        const artifactId = decodeURIComponent(pubArtifact[1] ?? "");
        const bytes = artifactId === "dataset_manifest"
          ? MANIFEST_BYTES
          : artifactId === DATA_ARTIFACT.artifact_id ? ARTIFACT_BYTES : undefined;
        if (bytes === undefined) { json(response, 404, { detail: "missing" }); return; }
        response.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(bytes.length) });
        response.end(bytes);
        return;
      }
      json(response, 404, { detail: "not found" });
    })().catch((error: unknown) => response.destroy(error instanceof Error ? error : new Error(String(error))));
  });
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  await rm(path.dirname(WORKSPACE_ROOT), { recursive: true, force: true });
});

describe("Gold formal rerun supervisor", () => {
  test("preserves numeric token telemetry while redacting credentials", () => {
    expect(redactEvidence({
      tokens: 115_487,
      tokens_before: 100_000,
      estimated_tokens_after: 97_000,
      target_tokens: 60_000,
      summary_tokens: 32_000,
      model_calls: 18,
      input_tokens: 401_776,
      output_tokens: 12_345,
      cache_read_tokens: 380_000,
      cache_write_tokens: 6_000,
      total_tokens: 414_121,
      reasoning_tokens: 2_400,
      access_token: "secret-value",
    })).toEqual({
      tokens: 115_487,
      tokens_before: 100_000,
      estimated_tokens_after: 97_000,
      target_tokens: 60_000,
      summary_tokens: 32_000,
      model_calls: 18,
      input_tokens: 401_776,
      output_tokens: 12_345,
      cache_read_tokens: 380_000,
      cache_write_tokens: 6_000,
      total_tokens: 414_121,
      reasoning_tokens: 2_400,
      access_token: "[REDACTED]",
    });
  });

  test("exports stable exit codes and terminal classifications", () => {
    expect(EXIT_CODES.SUCCESS).toBe(0);
    expect(classifyTerminal({
      run: { status: "completed" },
      publication: { publication_id: PUBLICATION_ID },
    }).classification).toBe("succeeded_publication");
    expect(classifyTerminal({ run: { status: "completed" }, publication: null }).classification).toBe("blocked_no_publication");
  });

  test("reads current_publication_id from the snapshot top level, not from the task object", () => {
    // The durable reducer emits current_publication_id as a top-level
    // snapshot field (task-reducer.ts); snapshot.task carries no such key.
    // Reading it from snapshot.task silently downgraded every supervised
    // publication closure to blocked_no_publication.
    expect(currentPublicationIdFrom({
      task: { task_id: "task_ts_x" },
      current_publication_id: PUBLICATION_ID,
    })).toBe(PUBLICATION_ID);
    expect(currentPublicationIdFrom({ task: { task_id: "task_ts_x" }, current_publication_id: null })).toBe(null);
    expect(currentPublicationIdFrom({ task: { current_publication_id: PUBLICATION_ID } })).toBe(null);
  });

  test("rejects replacement-character and malformed UTF-8 prompts", () => {
    expect(() => validateCleanUtf8Bytes(Buffer.from("bad\uFFFD", "utf8"), "prompt")).toThrow(/U\+FFFD/);
    expect(() => validateCleanUtf8Bytes(Uint8Array.from([0xc3, 0x28]), "prompt")).toThrow(/UTF-8/);
  });

  test("allows only strict workspace reads and fixed parser commands while denying known exec bypasses", () => {
    expect(classifyPermission({ capability: "fs.read", scope: "workspace", canonical_resource: path.join(WORKSPACE_ROOT, "input.csv") }, { workspaceRoot: WORKSPACE_ROOT }).action).toBe("allow");
    expect(classifyPermission({ capability: "fs.read", scope: "workspace", canonical_resource: path.join(WORKSPACE_ROOT, ".env") }, { workspaceRoot: WORKSPACE_ROOT }).action).toBe("stop");
    expect(classifyPermission({ capability: "process.exec", scope: "workspace", command: "node parse-fixture.mjs", cwd: WORKSPACE_ROOT }, { workspaceRoot: WORKSPACE_ROOT }).action).toBe("allow");
    expect(classifyPermission({
      capability: "process.exec",
      scope: "workspace",
      command: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -Command New-Item -ItemType Directory -Force -Path raw\\gwas_catalog; Copy-Item source_assets\\asset.json raw\\gwas_catalog\\asset.json",
      cwd: WORKSPACE_ROOT,
    }, { workspaceRoot: WORKSPACE_ROOT }).action).toBe("deny");
    expect(classifyPermission({
      capability: "process.exec",
      scope: "workspace",
      command: "C:\\Program Files\\Git\\mingw64\\bin\\curl.exe -sSL --max-time 60 -o staging/dilirank.md https://raw.githubusercontent.com/example/repo/main/README.md",
      cwd: WORKSPACE_ROOT,
    }, { workspaceRoot: WORKSPACE_ROOT }).action).toBe("deny");
    expect(classifyPermission({ capability: "process.exec", scope: "workspace", command: "python analysis.py", cwd: WORKSPACE_ROOT }, { workspaceRoot: WORKSPACE_ROOT }).action).toBe("deny");
    expect(classifyPermission({ capability: "process.exec", scope: "workspace", command: "node -e fetch('https://evil')", cwd: WORKSPACE_ROOT }, { workspaceRoot: WORKSPACE_ROOT }).action).toBe("deny");
  });

  test("posts deny for a known exec bypass and continues the same run", async () => {
    const fixture = await setup();
    const permissionBodies: JsonRecord[] = [];
    const host = await apiServer({
      events: [
        event(1, {
          type: "permission_requested",
          request_id: "permission_network",
          capability: "process.exec",
          scope: "workspace",
          command: "curl.exe -sSL https://example.test/data.csv",
          cwd: WORKSPACE_ROOT,
        }, "permission_requested"),
        event(2, { type: "run_completed" }, "run_completed"),
      ],
      snapshot: taskSnapshot("queued", null),
      completeOnRun: true,
      onPermission: (body) => permissionBodies.push(body),
    });
    try {
      const result = await supervise(options({ ...fixture, baseUrl: host.baseUrl }));
      expect(result.terminal.classification).toBe("succeeded_publication");
      expect(permissionBodies).toEqual([{ decision: "deny", grant_scope: null }]);
      const records = (await readFile(path.join(fixture.evidenceDir, "permissions.jsonl"), "utf8")).trim().split("\n");
      expect(records).toHaveLength(1);
      expect(JSON.parse(records[0] ?? "{}")).toMatchObject({
        request_id: "permission_network",
        decision: { action: "deny" },
      });
    } finally { await close(host.server); }
  });

  test("posts deny for an unknown workspace exec and continues the same run", async () => {
    const fixture = await setup();
    const permissionBodies: JsonRecord[] = [];
    const host = await apiServer({
      events: [
        event(1, {
          type: "permission_requested",
          request_id: "permission_unknown_exec",
          capability: "process.exec",
          scope: "workspace",
          command: "python analysis.py",
          cwd: WORKSPACE_ROOT,
        }, "permission_requested"),
        event(2, { type: "run_completed" }, "run_completed"),
      ],
      snapshot: taskSnapshot("queued", null),
      completeOnRun: true,
      onPermission: (body) => permissionBodies.push(body),
    });
    try {
      const result = await supervise(options({ ...fixture, baseUrl: host.baseUrl }));
      expect(result.terminal.classification).toBe("succeeded_publication");
      expect(permissionBodies).toEqual([{ decision: "deny", grant_scope: null }]);
      const records = (await readFile(path.join(fixture.evidenceDir, "permissions.jsonl"), "utf8")).trim().split("\\n");
      expect(records).toHaveLength(1);
      expect(JSON.parse(records[0] ?? "{}")).toMatchObject({
        request_id: "permission_unknown_exec",
        decision: { action: "deny" },
      });
    } finally { await close(host.server); }
  });

  test("deduplicates repeated permission requests from local evidence", async () => {
    const fixture = await setup();
    const permissionBodies: JsonRecord[] = [];
    const host = await apiServer({
      events: [
        event(1, {
          type: "permission_requested",
          request_id: "permission_duplicate",
          capability: "process.exec",
          scope: "workspace",
          command: "python analysis.py",
          cwd: WORKSPACE_ROOT,
        }, "permission_requested"),
        event(2, {
          type: "permission_requested",
          request_id: "permission_duplicate",
          capability: "process.exec",
          scope: "workspace",
          command: "python analysis.py",
          cwd: WORKSPACE_ROOT,
        }, "permission_requested"),
        event(3, { type: "run_completed" }, "run_completed"),
      ],
      snapshot: taskSnapshot("queued", null),
      completeOnRun: true,
      onPermission: (body) => permissionBodies.push(body),
    });
    try {
      const result = await supervise(options({ ...fixture, baseUrl: host.baseUrl }));
      expect(result.terminal.classification).toBe("succeeded_publication");
      expect(permissionBodies).toEqual([{ decision: "deny", grant_scope: null }]);
    } finally { await close(host.server); }
  });

  test("stops with a protocol error for a permission request without an identity", async () => {
    const fixture = await setup();
    const permissionBodies: JsonRecord[] = [];
    const host = await apiServer({
      events: [
        event(1, {
          type: "permission_requested",
          capability: "process.exec",
          scope: "workspace",
          command: "python analysis.py",
          cwd: WORKSPACE_ROOT,
        }, "permission_requested"),
      ],
      snapshot: taskSnapshot("queued", null),
      completeOnRun: true,
      onPermission: (body) => permissionBodies.push(body),
    });
    try {
      await expect(supervise(options({ ...fixture, baseUrl: host.baseUrl }))).rejects.toMatchObject({ code: "protocol" });
      expect(permissionBodies).toHaveLength(0);
    } finally { await close(host.server); }
  });

  test("fails closed when task has an active run", async () => {
    const fixture = await setup();
    const host = await apiServer({ events: [], snapshot: taskSnapshot("running", "run_other") });
    try {
      await expect(supervise(options({ ...fixture, baseUrl: host.baseUrl }))).rejects.toMatchObject({ code: "active_run" });
    } finally { await close(host.server); }
  });

  test("stops and writes a HIL report for data_review and acceptance reviews", () => {
    const data = classifyHIL({ payload: { type: "user_input_required", hil_request: { request_id: "hil_1", kind: "data_review", review_type: "browser_evidence_acceptance", evidence_digest: "a".repeat(64) } } });
    expect(data).toMatchObject({ action: "stop", reason: "data_review_requires_human", review_type: "browser_evidence_acceptance" });
    const publication = classifyHIL({ payload: { type: "user_input_required", hil_request: { request_id: "hil_2", kind: "conflict_resolution", review_type: "publication_acceptance", evidence_digest: "b".repeat(64) } } });
    expect(publication).toMatchObject({ action: "stop", reason: "data_review_requires_human", review_type: "publication_acceptance" });
  });

  test("detects artifact hash mismatch and distinguishes file/package digests", () => {
    const bytes = Buffer.from("hello\n", "utf8");
    expect(() => verifyArtifactBytes(bytes, { artifact_id: "a", size: bytes.length, sha256: "0".repeat(64) })).toThrow(/digest mismatch/);
    const fileDigest = digestManifestFile(bytes);
    const packageDigest = digestPackage([{ relative_path: "merged/data.csv", sha256: fileDigest }]);
    expect(fileDigest).not.toBe(packageDigest);
  });

  test("persists the adopted run and request identity without creating a second run", async () => {
    const fixture = await setup();
    const runBodies: JsonRecord[] = [];
    const host = await apiServer({
      events: [event(1, { type: "run_completed" }, "run_completed")],
      snapshot: taskSnapshot("completed", null, PUBLICATION_ID),
      onRun: (body) => runBodies.push(body),
    });
    try {
      const result = await supervise(options({ ...fixture, baseUrl: host.baseUrl, adopt: true }));
      const state = JSON.parse(await readFile(path.join(fixture.evidenceDir, "supervisor-state.json"), "utf8")) as JsonRecord;
      expect(result.run_id).toBe(RUN_ID);
      expect(state).toMatchObject({ run_id: RUN_ID, request_id: REQUEST_ID });
      expect(runBodies).toEqual([]);
    } finally { await close(host.server); }
  });

  test("replays an exact external HIL resolution during the bounded resume grace interval", async () => {
    const fixture = await setup();
    await seedPendingHil(fixture.evidenceDir);
    const runBodies: JsonRecord[] = [];
    const resumeBodies: JsonRecord[] = [];
    const waits: number[] = [];
    let now = 1_000;
    let externallyResolved = false;
    const host = await apiServer({
      events: () => externallyResolved
        ? [hilRequiredEvent(), hilResumedEvent(), event(3, { type: "run_completed" }, "run_completed")]
        : [hilRequiredEvent()],
      snapshot: () => externallyResolved
        ? taskSnapshot("completed", null, PUBLICATION_ID)
        : taskSnapshot("awaiting_user_input", RUN_ID),
      onRun: (body) => runBodies.push(body),
      onResume: (body) => resumeBodies.push(body),
    });
    try {
      const result = await supervise(
        options({ ...fixture, baseUrl: host.baseUrl, resume: true }),
        {
          hilGraceMs: 50,
          now: () => now,
          sleep: async (milliseconds: number) => {
            waits.push(milliseconds);
            now += milliseconds;
            externallyResolved = true;
          },
        },
      );
      expect(result.run_id).toBe(RUN_ID);
      expect(waits).toEqual([50]);
      expect(runBodies).toEqual([]);
      expect(resumeBodies).toEqual([]);
    } finally { await close(host.server); }
  });

  test("clears stale pending HIL state when the durable journal already contains its exact resume", async () => {
    const fixture = await setup();
    await seedPendingHil(fixture.evidenceDir, [hilRequiredEvent(), hilResumedEvent()]);
    const host = await apiServer({
      events: [hilRequiredEvent(), hilResumedEvent(), event(3, { type: "run_completed" }, "run_completed")],
      snapshot: taskSnapshot("completed", null, PUBLICATION_ID),
    });
    try {
      const result = await supervise(
        options({ ...fixture, baseUrl: host.baseUrl, resume: true }),
        { sleep: async () => { throw new Error("stale durable resume must not wait"); } },
      );
      const state = JSON.parse(await readFile(path.join(fixture.evidenceDir, "supervisor-state.json"), "utf8")) as JsonRecord;
      expect(result.run_id).toBe(RUN_ID);
      expect(state).toMatchObject({ stopped: false, pending_hil: null });
    } finally { await close(host.server); }
  });

  test("rejects and does not consume a human review with mismatched evidence", async () => {
    const fixture = await setup();
    await seedPendingHil(fixture.evidenceDir, [hilRequiredEvent(), hilResumedEvent(2, "b".repeat(64))]);
    await writeFile(path.join(fixture.evidenceDir, "human-review.jsonl"), `${JSON.stringify({
      request_id: HIL_REQUEST_ID,
      evidence_digest: "b".repeat(64),
      decision: { action: "accept" },
      reason: "Stale review",
    })}\n`, "utf8");
    const runBodies: JsonRecord[] = [];
    const resumeBodies: JsonRecord[] = [];
    const host = await apiServer({
      events: [hilRequiredEvent(), hilResumedEvent(2, "b".repeat(64))],
      snapshot: taskSnapshot("awaiting_user_input", RUN_ID),
      onRun: (body) => runBodies.push(body),
      onResume: (body) => resumeBodies.push(body),
    });
    try {
      await expect(supervise(
        options({ ...fixture, baseUrl: host.baseUrl, resume: true }),
        { hilGraceMs: 50, now: () => 1_000, sleep: async () => { throw new Error("mismatched review must fail closed"); } },
      )).rejects.toMatchObject({ code: "data_review" });
      expect(runBodies).toEqual([]);
      expect(resumeBodies).toEqual([]);
    } finally { await close(host.server); }
  });

  test("runs the success closure through paged events and artifact downloads", async () => {
    const fixture = await setup();
    const host = await apiServer({
      events: [event(1, { type: "run_started" }, "run_started"), event(2, { type: "stage_completed", stage: "validation" }, "stage_completed"), event(3, { type: "run_completed" }, "run_completed")],
      snapshot: taskSnapshot("queued", null),
      completeOnRun: true,
    });
    try {
      const result = await supervise(options({ ...fixture, baseUrl: host.baseUrl }));
      expect(result.terminal.classification).toBe("succeeded_publication");
      expect(result.artifacts).toHaveLength(1);
      expect(result.manifest_file_digest).toBe(MANIFEST_SHA);
      const closure = JSON.parse(await readFile(path.join(fixture.evidenceDir, "closure.json"), "utf8")) as JsonRecord;
      expect(closure.package_digest).toBe(PACKAGE_DIGEST);
      const closurePublication = closure.publication as JsonRecord;
      expect(closurePublication.publication_id).toBe(PUBLICATION_ID);
      expect(JSON.parse(await readFile(path.join(fixture.evidenceDir, "supervisor-state.json"), "utf8")).after_sequence).toBe(2);
      await readFile(path.join(fixture.evidenceDir, "artifacts", DATA_ARTIFACT.artifact_id));
      await readFile(path.join(fixture.evidenceDir, "artifacts", "dataset_manifest"));
    } finally { await close(host.server); }
  });
});

describe("supervisor API client resilience", () => {
  test("retries transient GET 500 errors before surfacing", async () => {
    const calls: string[] = [];
    const fetchImpl = async (_url: unknown, init?: { method?: string }) => {
      const method = init?.method ?? "GET";
      calls.push(method);
      if (method === "GET" && calls.filter((m) => m === "GET").length <= 2) {
        return new Response("boom", { status: 500 });
      }
      return new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const api = createApiClient("http://127.0.0.1:1", 1000, fetchImpl);
    const body = await api.request("GET", "/api/v1/health");
    expect((body as JsonRecord).status).toBe("ok");
    // Two failed GETs + one success.
    expect(calls.filter((m) => m === "GET")).toHaveLength(3);
  });

  test("never retries POST requests", async () => {
    const calls: string[] = [];
    const fetchImpl = async (_url: unknown, init?: { method?: string }) => {
      calls.push(init?.method ?? "GET");
      return new Response("boom", { status: 500 });
    };
    const api = createApiClient("http://127.0.0.1:1", 1000, fetchImpl);
    await expect(api.request("POST", "/api/v1/tasks/x/runs", { a: 1 })).rejects.toThrow(/HTTP 500/);
    expect(calls).toHaveLength(1);
  });
});
