import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { HILRequest } from "@biomed/contracts";

import {
  JsonHilApprovalPolicyStore,
  scopeOfRequest,
} from "../src/runtime/hil-approval-store.js";
import {
  createHilGatePreReview,
  createHilModelReviewer,
  parseVerdict,
  type HILGatePreReview,
  type HilModelReviewVerdict,
} from "../src/runtime/hil-pre-review.js";
import { DurableHILGate } from "../src/runtime/hil-gate.js";
import { DurableHILStore } from "../src/runtime/hil-store.js";
import { DurableTaskRepository } from "../src/runtime/task-repository.js";
import { createHilApprovalSettingsApi } from "../src/settings/hil-approval-settings.js";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function policyFixture(): Promise<{ dir: string; store: JsonHilApprovalPolicyStore }> {
  const dir = await mkdtemp(path.join(tmpdir(), "biomed-hil-approval-"));
  roots.push(dir);
  return {
    dir,
    store: new JsonHilApprovalPolicyStore(path.join(dir, "hil-approval.json")),
  };
}

function fakeHttpResponse(status: number, body: unknown) {
  return {
    status,
    headers: {},
    body: (async function* () {
      if (status >= 200 && status < 300) {
        yield Buffer.from(JSON.stringify(body));
      }
    })(),
    url: "",
    discard: async () => undefined,
  };
}

describe("parseVerdict (model pre-review output)", () => {
  it("accepts plain and fenced verdict objects", () => {
    expect(parseVerdict('{"verdict":"pass","reason":"ok"}')).toEqual({
      verdict: "pass",
      reason: "ok",
    });
    expect(parseVerdict('```json\n{"verdict":"fail","reason":"uncertain"}\n```')).toEqual({
      verdict: "fail",
      reason: "uncertain",
    });
  });

  it("rejects payloads without a valid verdict", () => {
    expect(() => parseVerdict("no json at all")).toThrow(/JSON object/);
    expect(() => parseVerdict('{"verdict":"maybe"}')).toThrow(/verdict/);
  });

  it("clamps long reasons", () => {
    const verdict = parseVerdict(`{"verdict":"pass","reason":"${"x".repeat(900)}"}`);
    expect(verdict.reason).toHaveLength(500);
  });
});

describe("createHilModelReviewer", () => {
  it("posts the review batch to the chat endpoint and parses the verdict", async () => {
    let seenBody = "";
    let seenUrl = "";
    const reviewer = createHilModelReviewer(
      async () => ({
        provider: "openai-compatible",
        modelId: "test-model",
        apiKey: "test-key",
        baseUrl: "https://vlm.example.com/v1",
      }),
      {
        request: async (url: string | URL, options: unknown) => {
          seenUrl = String(url);
          seenBody = String((options as { body?: unknown } | undefined)?.body ?? "");
          return fakeHttpResponse(200, {
            choices: [{ message: { content: '{"verdict":"pass","reason":"clear mapping"}' } }],
          }) as never;
        },
      } as never,
    );
    const request = {
      request_id: "hil_x",
      kind: "semantic_review",
      review_type: "field_mapping",
      review_items: [{
        item_id: "i1",
        summary: "s",
        evidence: {},
        proposed_value: "v",
        confidence_level: "high",
      }],
      summary: "review",
    } as unknown as HILRequest;
    const verdict = await reviewer.review(request);
    expect(verdict).toEqual({ verdict: "pass", reason: "clear mapping" });
    expect(seenUrl).toBe("https://vlm.example.com/v1/chat/completions");
    expect(seenBody).toContain("test-model");
    expect(seenBody).toContain("field_mapping");
    expect(seenBody).toContain("i1");
  });

  it("throws on an HTTP error so the gate escalates to a human", async () => {
    const reviewer = createHilModelReviewer(
      async () => ({
        provider: "openai-compatible",
        modelId: "test-model",
        apiKey: "k",
        baseUrl: "https://vlm.example.com/v1",
      }),
      {
        request: async () => fakeHttpResponse(500, null) as never,
      } as never,
    );
    await expect(reviewer.review({ review_items: [] } as unknown as HILRequest))
      .rejects.toThrow(/HTTP 500/);
  });
});

describe("JsonHilApprovalPolicyStore", () => {
  it("defaults every scope to human_review", async () => {
    const { store } = await policyFixture();
    expect(await store.modeFor("permission", null)).toBe("human_review");
    expect(await store.modeFor("semantic_review", "field_mapping")).toBe("human_review");
    expect(await store.getSettings()).toEqual({
      schema_version: "1.0",
      default_mode: "human_review",
      review_modes: {},
    });
  });

  it("maps request scope for kind/review_type combinations", () => {
    expect(scopeOfRequest("permission", null)).toBe("permission");
    expect(scopeOfRequest("semantic_review", "unit_conversion")).toBe("unit_conversion");
    expect(() => scopeOfRequest("semantic_review", null)).toThrow(/review_type/);
  });

  it("merges patches, persists, and reloads from disk", async () => {
    const { dir, store } = await policyFixture();
    await store.setSettings({
      default_mode: "llm_pre_review",
      review_modes: { permission: "human_review", field_mapping: "auto_approve" },
    });
    expect(await store.modeFor("semantic_review", "entity_mapping")).toBe("llm_pre_review");
    expect(await store.modeFor("permission", null)).toBe("human_review");
    expect(await store.modeFor("semantic_review", "field_mapping")).toBe("auto_approve");
    const reloaded = new JsonHilApprovalPolicyStore(path.join(dir, "hil-approval.json"));
    expect((await reloaded.getSettings()).review_modes.permission).toBe("human_review");
    const raw = JSON.parse(await readFile(path.join(dir, "hil-approval.json"), "utf8"));
    expect(raw.default_mode).toBe("llm_pre_review");
  });

  it("rejects non-human modes for human-mandatory scopes and invalid values", async () => {
    const { store } = await policyFixture();
    await expect(
      store.setSettings({ review_modes: { publication_acceptance: "llm_pre_review" } }),
    ).rejects.toThrow(/human review/);
    await expect(
      store.setSettings({ review_modes: { vlm_extraction: "auto_approve" } }),
    ).rejects.toThrow(/human review/);
    await expect(
      store.setSettings({ review_modes: { browser_evidence_acceptance: "auto_approve" } }),
    ).rejects.toThrow(/human review/);
    await expect(
      store.setSettings({ review_modes: { field_mapping: "yolo" as never } }),
    ).rejects.toThrow(/human_review, llm_pre_review, or auto_approve/);
    await expect(
      store.setSettings({ review_modes: { nope: "auto_approve" } as never }),
    ).rejects.toThrow(/scope/);
    await expect(store.setSettings({ default_mode: "ask" as never })).rejects.toThrow(/default_mode/);
  });

  it("clears a scope override back to the default via null", async () => {
    const { store } = await policyFixture();
    await store.setSettings({ review_modes: { field_mapping: "auto_approve" } });
    await store.setSettings({ review_modes: { field_mapping: null } });
    expect(await store.modeFor("semantic_review", "field_mapping")).toBe("human_review");
  });
});

describe("HIL approval settings API", () => {
  async function apiFixture() {
    const { store } = await policyFixture();
    const api = createHilApprovalSettingsApi(store);
    const server: Server = createServer((request, response) => {
      if (!api.handle(request, response)) response.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    servers.push(server);
    return { store, base: `http://127.0.0.1:${port}` };
  }

  it("GET returns defaults and PUT applies the three-tier assignment", async () => {
    const { base } = await apiFixture();
    const initial = await fetch(`${base}/api/v1/settings/hil-approval`);
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({
      schema_version: "1.0",
      default_mode: "human_review",
      review_modes: {},
    });

    const put = await fetch(`${base}/api/v1/settings/hil-approval`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        default_mode: "llm_pre_review",
        review_modes: { permission: "human_review", unit_conversion: "auto_approve" },
      }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({
      default_mode: "llm_pre_review",
      review_modes: { permission: "human_review", unit_conversion: "auto_approve" },
    });

    const invalid = await fetch(`${base}/api/v1/settings/hil-approval`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ review_modes: { publication_acceptance: "auto_approve" } }),
    });
    expect(invalid.status).toBe(422);
    expect((await invalid.json() as { detail: string }).detail).toMatch(/human review/);

    const badScope = await fetch(`${base}/api/v1/settings/hil-approval`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ review_modes: { nonsense: "auto_approve" } }),
    });
    expect(badScope.status).toBe(422);
  });

  it("answers 405 for unsupported methods and ignores foreign paths", async () => {
    const { base } = await apiFixture();
    const deleted = await fetch(`${base}/api/v1/settings/hil-approval`, { method: "DELETE" });
    expect(deleted.status).toBe(405);
  });
});

describe("DurableHILGate pre-review", () => {
  interface GateFixture {
    taskId: string;
    runId: string;
    repository: DurableTaskRepository;
    store: DurableHILStore;
    gate: (preReview?: HILGatePreReview | null) => DurableHILGate;
    events: () => ReturnType<DurableTaskRepository["listEvents"]>;
  }

  async function gateFixture(): Promise<GateFixture> {
    const dir = await mkdtemp(path.join(tmpdir(), "biomed-hil-prereview-"));
    roots.push(dir);
    let sequence = 0;
    const repository = new DurableTaskRepository(dir, {
      id: () => `fixed_${++sequence}`,
      now: () => new Date("2026-08-29T01:00:00.000Z"),
    });
    const accepted = await repository.createTask({
      requestId: "request_1",
      input: "Build a dataset",
      databases: [],
      mode: "agent",
    });
    await repository.appendRunEvent(accepted.task_id, accepted.run_id, {
      type: "run_started",
    });
    const store = new DurableHILStore(repository);
    return {
      taskId: accepted.task_id,
      runId: accepted.run_id,
      repository,
      store,
      gate: (preReview?: HILGatePreReview | null) =>
        new DurableHILGate(accepted.task_id, repository, accepted.run_id, store, preReview ?? null),
      events: () => repository.listEvents(accepted.task_id, 0),
    };
  }

  function reviewInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      requirement_id: null,
      kind: "semantic_review",
      review_type: "field_mapping",
      blocking: true,
      subject: { mapping_ids: ["map_gene"] },
      review_items: [{
        item_id: "map_gene",
        summary: "Gene Symbol → gene_symbol",
        subject: { mapping_ids: ["map_gene"] },
        evidence: { source_field: "Gene Symbol", proposed_target: "gene_symbol" },
        proposed_value: "gene_symbol",
        confidence_level: "high",
      }],
      summary: "1 proposed field mapping(s) require review",
      evidence: { batch_id: "batch_1" },
      policy_ref: "dataset.field_mapping.v1",
      idempotency_key: "op_1",
      ...overrides,
    };
  }

  /** Resolves a parked human request through the store and hands it to the gate. */
  async function parkAndResolve(fixture: GateFixture, gate: DurableHILGate): Promise<void> {
    const parked = await waitForPending(fixture);
    const review = await fixture.store.resolveRequest(fixture.taskId, fixture.runId, {
      request_id: parked.request_id,
      evidence_digest: parked.evidence_digest,
      decision: { action: "accept" },
      reason: null,
    });
    expect(gate.resolvePending(fixture.runId, review)).toBe(true);
  }

  /** requestHIL creates the durable request asynchronously; poll for it. */
  async function waitForPending(fixture: GateFixture, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const parked = await fixture.store.findPendingForRun(fixture.taskId, fixture.runId);
      if (parked !== null) return parked;
      if (Date.now() > deadline) {
        throw new Error("no pending HIL request appeared before the timeout");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  function stubModelReview(
    seam: HILGatePreReview,
    outcome: HilModelReviewVerdict | Error,
  ): void {
    (seam as unknown as {
      modelReview: () => Promise<HilModelReviewVerdict>;
    }).modelReview = async () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    };
  }

  it("keeps the human flow when no pre-review seam is wired", async () => {
    const fixture = await gateFixture();
    const gate = fixture.gate();
    const pendingReview = gate.requestHIL(reviewInput() as never);
    const parked = await waitForPending(fixture);
    expect(parked).not.toBeNull();
    expect((await fixture.events()).some((e) => e.type === "user_input_required")).toBe(true);
    await parkAndResolve(fixture, gate);
    await expect(pendingReview).resolves.toMatchObject({ reviewer: "user" });
  });

  it("auto_approve resolves immediately without a user_input_required event", async () => {
    const fixture = await gateFixture();
    const policy = await policyFixture();
    await policy.store.setSettings({ review_modes: { field_mapping: "auto_approve" } });
    const gate = fixture.gate(createHilGatePreReview(policy.store, null));
    const review = await gate.requestHIL(reviewInput() as never);
    expect(review.decision).toEqual({ action: "accept" });
    expect(review.reviewer).toBe("auto");
    const types = (await fixture.events()).map((event) => event.type);
    expect(types).not.toContain("user_input_required");
    expect(types).toContain("warning");
    expect(await fixture.store.findPendingForRun(fixture.taskId, fixture.runId)).toBeNull();
  });

  it("auto_approve on a permission request resolves with approve", async () => {
    const fixture = await gateFixture();
    const policy = await policyFixture();
    await policy.store.setSettings({ review_modes: { permission: "auto_approve" } });
    const gate = fixture.gate(createHilGatePreReview(policy.store, null));
    const review = await gate.requestHIL(reviewInput({
      kind: "permission",
      review_type: null,
      subject: {},
      review_items: [],
      summary: "Approve credential use for gdc.search",
      evidence: { operation: "gdc.search" },
      policy_ref: "runtime.credential.v1",
    }) as never);
    expect(review.decision).toEqual({ action: "approve" });
    expect(review.reviewer).toBe("auto");
  });

  it("llm_pre_review pass resolves with reviewer model and records a warning", async () => {
    const fixture = await gateFixture();
    const policy = await policyFixture();
    await policy.store.setSettings({ review_modes: { field_mapping: "llm_pre_review" } });
    const seam = createHilGatePreReview(policy.store, null)!;
    stubModelReview(seam, { verdict: "pass", reason: "clear mapping" });
    const review = await fixture.gate(seam).requestHIL(reviewInput() as never);
    expect(review.decision).toEqual({ action: "accept" });
    expect(review.reviewer).toBe("model");
    expect(review.reason).toContain("clear mapping");
    const warnings = (await fixture.events()).filter((event) => event.type === "warning");
    expect(warnings.some((event) =>
      event.payload.type === "warning" &&
      typeof event.payload.code === "string" &&
      event.payload.code.startsWith("HIL_PRE_APPROVED:"),
    )).toBe(true);
    expect((await fixture.events()).some((e) => e.type === "user_input_required")).toBe(false);
  });

  it("llm_pre_review fails escalate to the classic human flow", async () => {
    const fixture = await gateFixture();
    const policy = await policyFixture();
    await policy.store.setSettings({ review_modes: { field_mapping: "llm_pre_review" } });
    const seam = createHilGatePreReview(policy.store, null)!;
    stubModelReview(seam, { verdict: "fail", reason: "low confidence" });
    const gate = fixture.gate(seam);
    const pendingReview = gate.requestHIL(reviewInput() as never);
    await vi.waitFor(async () => {
      expect((await fixture.events()).some((e) => e.type === "user_input_required")).toBe(true);
    });
    await parkAndResolve(fixture, gate);
    await expect(pendingReview).resolves.toMatchObject({ reviewer: "user" });
  });

  it("a throwing model review escalates to the human flow", async () => {
    const fixture = await gateFixture();
    const policy = await policyFixture();
    await policy.store.setSettings({ review_modes: { field_mapping: "llm_pre_review" } });
    const seam = createHilGatePreReview(policy.store, null)!;
    stubModelReview(seam, new Error("endpoint down"));
    const gate = fixture.gate(seam);
    const pendingReview = gate.requestHIL(reviewInput() as never);
    await parkAndResolve(fixture, gate);
    await expect(pendingReview).resolves.toMatchObject({ reviewer: "user" });
  });

  it("human_review mode never consults the model", async () => {
    const fixture = await gateFixture();
    const policy = await policyFixture();
    const seam = createHilGatePreReview(policy.store, null)!;
    let consulted = false;
    (seam as unknown as {
      modelReview: () => Promise<HilModelReviewVerdict>;
    }).modelReview = async () => {
      consulted = true;
      return { verdict: "pass", reason: "should not happen" };
    };
    const gate = fixture.gate(seam);
    const pendingReview = gate.requestHIL(reviewInput() as never);
    await parkAndResolve(fixture, gate);
    await expect(pendingReview).resolves.toMatchObject({ reviewer: "user" });
    expect(consulted).toBe(false);
  });

  it("createHilGatePreReview returns null without a policy store", () => {
    expect(createHilGatePreReview(null, null)).toBeNull();
  });
});
