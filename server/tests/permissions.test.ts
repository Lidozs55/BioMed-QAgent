import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  InMemoryPermissionAuditSink,
  InMemoryPermissionPolicyStore,
  PermissionBroker,
  PermissionDeniedError,
  PermissionEvaluator,
  ProtectedPaths,
  TemporaryGrantStore,
  classifyCanonicalPath,
  normalizeAgentPathFor,
} from "../src/agent/permissions/index.js";
import type { BrokerOptions, PermissionAuditSink } from "../src/agent/permissions/index.js";

const roots: string[] = [];

async function fixture(options: {
  preset?: "restricted" | "ask_when_needed" | "full_access";
  rules?: Array<{ capability: "fs.read" | "fs.write" | "fs.edit"; path: string; recursive: boolean; policy: "allow" | "ask" | "deny" }>;
  persistentExecAllow?: boolean;
} = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), "biomed-perm-"));
  roots.push(base);
  const workspaceRoot = path.join(base, "workspaces", "task_ts_1");
  const taskOutputRoot = path.join(base, "output", "tasks", "task_ts_1");
  const repositoryRoot = base;
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(path.join(taskOutputRoot, "state"), { recursive: true });
  await mkdir(path.join(taskOutputRoot, "artifacts"), { recursive: true });
  const policyStore = new InMemoryPermissionPolicyStore();
  if (options.preset !== undefined) await policyStore.setPreset(options.preset);
  for (const rule of options.rules ?? []) await policyStore.addRule(rule);
  if (options.persistentExecAllow === true) await policyStore.setPersistentExecAllow(true);
  const protectedPaths = new ProtectedPaths({ taskOutputRoot });
  const grants = new TemporaryGrantStore();
  const evaluator = new PermissionEvaluator({ protectedPaths, grants, policyStore });
  const audit = new InMemoryPermissionAuditSink();
  const events: Array<{ type: string; request_id?: string }> = [];
  const broker = new PermissionBroker({
    taskId: "task_ts_1",
    runId: "run_ts_1",
    evaluator,
    grants,
    policyStore,
    audit,
    recordRunEvent: async (payload) => {
      events.push(payload as { type: string; request_id?: string });
    },
  });
  return { base, workspaceRoot, taskOutputRoot, repositoryRoot, broker, evaluator, grants, policyStore, audit, events };
}

async function classify(input: string, workspaceAnchor: string, repositoryRoot: string, taskOutputRoot: string, dataRoot = repositoryRoot) {
  const normalized = await normalizeAgentPathFor(input, workspaceAnchor);
  return {
    ...normalized,
    scope: classifyCanonicalPath(normalized.canonical, {
      workspaceRoot: workspaceAnchor,
      taskOutputRoot,
      dataRoot,
      repositoryRoot,
    }),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }))));
});

describe("path normalization + scope classification (P1)", () => {
  test("relative paths anchor at the workspace; absolute paths classify by scope", async () => {
    const { workspaceRoot, taskOutputRoot, repositoryRoot } = await fixture();
    await mkdir(path.join(workspaceRoot, "notes"), { recursive: true });
    await writeFile(path.join(workspaceRoot, "notes", "a.md"), "x", "utf8");
    await writeFile(path.join(taskOutputRoot, "state", "task.json"), "{}", "utf8");

    const relative = await classify("notes/a.md", workspaceRoot, repositoryRoot, taskOutputRoot);
    expect(relative.absolute).toBe(path.join(workspaceRoot, "notes", "a.md"));
    expect(relative.scope).toBe("workspace");

    const output = await classify(
      path.join(taskOutputRoot, "artifacts", "result.csv"),
      workspaceRoot,
      repositoryRoot,
      taskOutputRoot,
    );
    expect(output.scope).toBe("task_output");

    const project = await classify(path.join(repositoryRoot, "package.json"), workspaceRoot, repositoryRoot, taskOutputRoot);
    expect(project.scope).toBe("project");

    const external = await classify(path.join(baseExternal()), workspaceRoot, repositoryRoot, taskOutputRoot);
    expect(external.scope).toBe("external");
  });

  test("framework control plane is its own scope, never ordinary project", async () => {
    const { workspaceRoot, taskOutputRoot, repositoryRoot } = await fixture();
    // dataRoot in this fixture layout IS the base dir: settings live at
    // <base>/settings (permission rules + model credentials) and must not be
    // reachable through a project grant (P0 audit).
    const settings = path.join(repositoryRoot, "settings", "agent-permissions.json");
    await mkdir(path.dirname(settings), { recursive: true });
    await writeFile(settings, "{}", "utf8");
    const settingsScope = await classify(settings, workspaceRoot, repositoryRoot, taskOutputRoot);
    expect(settingsScope.scope).toBe("framework_internal");
    // Other tasks' workspaces and outputs are framework-internal too.
    const otherWorkspace = path.join(repositoryRoot, "workspaces", "task_other", "a.csv");
    await mkdir(path.dirname(otherWorkspace), { recursive: true });
    await writeFile(otherWorkspace, "x", "utf8");
    expect((await classify(otherWorkspace, workspaceRoot, repositoryRoot, taskOutputRoot)).scope)
      .toBe("framework_internal");
    const otherOutput = path.join(repositoryRoot, "output", "tasks", "task_other", "state", "task.json");
    await mkdir(path.dirname(otherOutput), { recursive: true });
    await writeFile(otherOutput, "{}", "utf8");
    expect((await classify(otherOutput, workspaceRoot, repositoryRoot, taskOutputRoot)).scope)
      .toBe("framework_internal");
    // The CURRENT task's dirs keep their own scopes.
    expect((await classify(path.join(workspaceRoot, "notes", "a.md"), workspaceRoot, repositoryRoot, taskOutputRoot)).scope)
      .toBe("workspace");
    expect((await classify(path.join(taskOutputRoot, "state", "task.json"), workspaceRoot, repositoryRoot, taskOutputRoot)).scope)
      .toBe("task_output");
  });

  test("framework-internal scope is hard-denied for every capability even with grants and rules", async () => {
    const { broker, grants, policyStore, repositoryRoot } = await fixture();
    const settings = path.join(repositoryRoot, "settings", "model-auth.json");
    await mkdir(path.dirname(settings), { recursive: true });
    await writeFile(settings, "{}", "utf8");
    // A run grant + a persistent allow rule for the exact path must not help.
    grants.add("run", "task_ts_1", "run_ts_1", {
      capability: "fs.read",
      scope: "framework_internal",
    });
    await policyStore.addRule({
      capability: "fs.read",
      path: settings,
      recursive: true,
      policy: "allow",
    });
    await expect(broker.evaluate({
      capability: "fs.read",
      resource: settings,
      canonicalResource: settings,
      scope: "framework_internal",
    })).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(broker.evaluate({
      capability: "fs.write",
      resource: settings,
      canonicalResource: settings,
      scope: "framework_internal",
    })).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  test("case-insensitive containment on Windows; prefix confusion is impossible", async () => {
    const { workspaceRoot, taskOutputRoot, repositoryRoot } = await fixture();
    const workspace = process.platform === "win32"
      ? workspaceRoot.toUpperCase()
      : workspaceRoot;
    const normalized = await normalizeAgentPathFor(
      process.platform === "win32"
        ? `${workspace}\\notes\\a.md`
        : `${workspace}/notes/a.md`,
      workspaceRoot,
    );
    expect(classifyCanonicalPath(normalized.canonical, {
      workspaceRoot,
      taskOutputRoot,
      dataRoot: repositoryRoot,
      repositoryRoot,
    })).toBe("workspace");
    // C:\work must not be contained by C:\workspace-evil
    const evil = await normalizeAgentPathFor(
      path.join(os.tmpdir(), "biomed-workspace-evil", "x.txt"),
      workspaceRoot,
    );
    expect(classifyCanonicalPath(evil.canonical, {
      workspaceRoot,
      taskOutputRoot,
      dataRoot: repositoryRoot,
      repositoryRoot,
    })).toBe("external");
  });

  test("traversal resolves out of the workspace; reserved representations still reject", async () => {
    const { workspaceRoot } = await fixture();
    // ``../`` escapes are now scope decisions, not input errors: the path
    // resolves to an absolute path outside the workspace and flows into the
    // broker (ADR-026 §2). It must never throw INVALID.
    const escaped = await normalizeAgentPathFor("../escape", workspaceRoot);
    expect(escaped.absolute).not.toBe(workspaceRoot);
    expect(escaped.canonical).not.toBeUndefined();
    const doubled = await normalizeAgentPathFor("a/../../b", workspaceRoot);
    expect(doubled.absolute).not.toBe(workspaceRoot);
    expect(doubled.canonical).not.toBeUndefined();
    // NUL bytes and reserved Windows aliases remain hard input errors.
    await expect(normalizeAgentPathFor("NUL", workspaceRoot)).rejects.toMatchObject({
      code: "INVALID",
    });
  });

  test("non-existent targets keep their missing suffix after canonicalization", async () => {
    // The classic over-grant trap: requesting
    // ``D:\datasets\new-project\result.csv`` when only ``D:\datasets``
    // exists must canonicalize to the FULL target, not collapse to
    // ``D:\datasets`` (which would turn an "always allow this directory"
    // grant into ``D:\datasets\**``).
    const { workspaceRoot } = await fixture();
    const deep = path.join(workspaceRoot, "a", "b", "c", "file.csv");
    const normalized = await normalizeAgentPathFor(deep, workspaceRoot);
    const canonical = path.resolve(normalized.canonical);
    const expected = path.resolve(deep);
    if (process.platform === "win32") {
      expect(canonical.toLowerCase()).toBe(expected.toLowerCase());
    } else {
      expect(canonical).toBe(expected);
    }
    expect(normalized.exists).toBe(false);
  });
});

function baseExternal(): string {
  return path.join(os.tmpdir(), "biomed-perm-external-x");
}

describe("PermissionEvaluator decision order (P1)", () => {
  test("framework invariant denies writes into task state/artifacts regardless of grants", async () => {
    const { broker, taskOutputRoot } = await fixture({ preset: "full_access" });
    const target = path.join(taskOutputRoot, "artifacts", "formal.csv");
    await expect(broker.evaluate({
      capability: "fs.write",
      resource: target,
      canonicalResource: target,
      scope: "task_output",
    })).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  test("workspace is free; external asks by default; restricted denies external", async () => {
    const ask = await fixture();
    const workspaceDecision = await ask.broker.evaluate({
      capability: "fs.write",
      resource: "notes/a.md",
      canonicalResource: path.join(ask.workspaceRoot, "notes", "a.md"),
      scope: "workspace",
    });
    expect(workspaceDecision).toEqual({ decision: "allow" });

    // External read defaults to ASK: the call suspends and the broker
    // reports a pending request instead of resolving.
    const externalAsk = ask.broker.evaluate({
      capability: "fs.read",
      resource: path.join(baseExternal(), "clinical.csv"),
      canonicalResource: path.join(baseExternal(), "clinical.csv"),
      scope: "external",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ask.broker.hasPending("run_ts_1")).toBe(true);
    await ask.broker.resolve("run_ts_1", (ask.events.at(-1) as { request_id: string }).request_id, "allow", "once");
    await expect(externalAsk).resolves.toMatchObject({ decision: "allow" });

    const restricted = await fixture({ preset: "restricted" });
    await expect(restricted.broker.evaluate({
      capability: "fs.read",
      resource: path.join(baseExternal(), "clinical.csv"),
      canonicalResource: path.join(baseExternal(), "clinical.csv"),
      scope: "external",
    })).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  test("task output read is allowed; write/edit are denied by default", async () => {
    const { broker, taskOutputRoot } = await fixture();
    await expect(broker.evaluate({
      capability: "fs.read",
      resource: path.join(taskOutputRoot, "parsed", "a.csv"),
      canonicalResource: path.join(taskOutputRoot, "parsed", "a.csv"),
      scope: "task_output",
    })).resolves.toMatchObject({ decision: "allow" });
    await expect(broker.evaluate({
      capability: "fs.write",
      resource: path.join(taskOutputRoot, "parsed", "a.csv"),
      canonicalResource: path.join(taskOutputRoot, "parsed", "a.csv"),
      scope: "task_output",
    })).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  test("most specific persistent rule wins over configuration order", async () => {
    const external = path.join(baseExternal());
    const { broker } = await fixture({
      rules: [
        { capability: "fs.read", path: external, recursive: true, policy: "deny" },
        { capability: "fs.read", path: path.join(external, "open"), recursive: true, policy: "allow" },
      ],
    });
    const denied = path.join(external, "private", "a.txt");
    const allowed = path.join(external, "open", "a.txt");
    await expect(broker.evaluate({
      capability: "fs.read",
      resource: denied,
      canonicalResource: denied,
      scope: "external",
    })).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(broker.evaluate({
      capability: "fs.read",
      resource: allowed,
      canonicalResource: allowed,
      scope: "external",
    })).resolves.toMatchObject({ decision: "allow" });
  });

  test("explicit rule can downgrade a preset default to ask", async () => {
    const { broker } = await fixture({
      rules: [
        { capability: "fs.read", path: baseExternal(), recursive: true, policy: "ask" },
      ],
    });
    void broker.evaluate({
      capability: "fs.read",
      resource: path.join(baseExternal(), "x.csv"),
      canonicalResource: path.join(baseExternal(), "x.csv"),
      scope: "external",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(broker.hasPending("run_ts_1")).toBe(true);
  });
});

describe("PermissionBroker suspend/resume (P1)", () => {
  test("ask suspends the tool call; once resolution continues it", async () => {
    const { broker, events, audit } = await fixture();
    const requested = broker.evaluate({
      capability: "fs.read",
      resource: path.join(baseExternal(), "clinical.csv"),
      canonicalResource: path.join(baseExternal(), "clinical.csv"),
      scope: "external",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events.at(-1)).toMatchObject({ type: "permission_requested" });
    const requestId = (events.at(-1) as { request_id: string }).request_id;

    const resolved = await broker.resolve("run_ts_1", requestId, "allow", "once");
    expect(resolved).toBe(true);
    await expect(requested).resolves.toMatchObject({ decision: "allow" });
    expect(events.at(-1)).toMatchObject({ type: "permission_resolved", decision: "allow" });
    expect(audit.records.filter((entry) => entry.decision === "pending")).toHaveLength(1);
    expect(audit.records.filter((entry) => entry.decision === "allow")).toHaveLength(1);
  });

  test("deny rejects the suspended call with a structured permission error", async () => {
    const { broker, events } = await fixture();
    const requested = broker.evaluate({
      capability: "fs.read",
      resource: path.join(baseExternal(), "clinical.csv"),
      canonicalResource: path.join(baseExternal(), "clinical.csv"),
      scope: "external",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const requestId = (events.at(-1) as { request_id: string }).request_id;
    await broker.resolve("run_ts_1", requestId, "deny");
    await expect(requested).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  test("run grant auto-allows the same capability × scope for the rest of the run", async () => {
    const { broker, events } = await fixture();
    const external = path.join(baseExternal(), "data", "a.csv");
    const first = broker.evaluate({
      capability: "fs.read",
      resource: external,
      canonicalResource: external,
      scope: "external",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const requestId = (events.at(-1) as { request_id: string }).request_id;
    await broker.resolve("run_ts_1", requestId, "allow", "run");
    await expect(first).resolves.toMatchObject({ decision: "allow" });

    // Second external read within the same run: no new ask.
    await expect(broker.evaluate({
      capability: "fs.read",
      resource: path.join(baseExternal(), "data", "b.csv"),
      canonicalResource: path.join(baseExternal(), "data", "b.csv"),
      scope: "external",
    })).resolves.toMatchObject({ decision: "allow" });
    expect(events.filter((event) => event.type === "permission_requested")).toHaveLength(1);
  });

  test("task grant survives across runs (new run id still allowed)", async () => {
    const { broker, events, grants } = await fixture();
    const external = path.join(baseExternal(), "x.csv");
    const first = broker.evaluate({
      capability: "fs.read",
      resource: external,
      canonicalResource: external,
      scope: "external",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const requestId = (events.at(-1) as { request_id: string }).request_id;
    await broker.resolve("run_ts_1", requestId, "allow", "task");
    await expect(first).resolves.toMatchObject({ decision: "allow" });
    grants.clearRun("run_ts_1");
    await expect(broker.evaluate({
      capability: "fs.read",
      resource: external,
      canonicalResource: external,
      scope: "external",
    })).resolves.toMatchObject({ decision: "allow" });
  });

  test("persistent grant writes a user rule into the policy store", async () => {
    const { broker, events, policyStore } = await fixture();
    const external = path.join(baseExternal(), "keep");
    const requested = broker.evaluate({
      capability: "fs.read",
      resource: external,
      canonicalResource: external,
      scope: "external",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const requestId = (events.at(-1) as { request_id: string }).request_id;
    await broker.resolve("run_ts_1", requestId, "allow", "persistent");
    await expect(requested).resolves.toMatchObject({ decision: "allow" });

    const settings = await policyStore.getSettings();
    expect(settings.rules).toEqual([
      expect.objectContaining({ capability: "fs.read", path: external, recursive: true, policy: "allow" }),
    ]);
    // A later, different run sees the persistent rule through the evaluator.
    await expect(broker.evaluate({
      capability: "fs.read",
      resource: path.join(external, "sub", "y.csv"),
      canonicalResource: path.join(external, "sub", "y.csv"),
      scope: "external",
    })).resolves.toMatchObject({ decision: "allow" });
  });

  test("unknown request ids, duplicate resolutions, and expiry are rejected safely", async () => {
    const { broker, events } = await fixture();
    expect(await broker.resolve("run_ts_1", "permission_nope", "allow")).toBe(false);

    const requested = broker.evaluate({
      capability: "fs.read",
      resource: path.join(baseExternal(), "x.csv"),
      canonicalResource: path.join(baseExternal(), "x.csv"),
      scope: "external",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const requestId = (events.at(-1) as { request_id: string }).request_id;
    expect(await broker.resolve("run_ts_1", requestId, "allow", "once")).toBe(true);
    expect(await broker.resolve("run_ts_1", requestId, "allow", "once")).toBe(false);
    await expect(requested).resolves.toMatchObject({ decision: "allow" });
  });

  test("persistence failure while suspending settles the tool call and leaves no pending entry", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "biomed-perm-fail-"));
    roots.push(base);
    const workspaceRoot = path.join(base, "workspaces", "task_ts_1");
    await mkdir(workspaceRoot, { recursive: true });
    const policyStore = new InMemoryPermissionPolicyStore();
    const grants = new TemporaryGrantStore();
    const evaluator = new PermissionEvaluator({
      protectedPaths: new ProtectedPaths({ taskOutputRoot: path.join(base, "output", "tasks", "task_ts_1") }),
      grants,
      policyStore,
    });
    const failingAudit: PermissionAuditSink = {
      record: async () => {
        throw new Error("disk full");
      },
    };
    const broker = new PermissionBroker({
      taskId: "task_ts_1",
      runId: "run_ts_1",
      evaluator,
      grants,
      policyStore,
      audit: failingAudit,
      recordRunEvent: async () => undefined,
    });
    // The audit failure must surface to the tool call (reject, not hang) and
    // must not leave an orphaned pending entry that blocks later requests
    // (audit fix: persistence failure settles the caller).
    await expect(broker.evaluate({
      capability: "fs.read",
      resource: path.join(baseExternal(), "x.csv"),
      canonicalResource: path.join(baseExternal(), "x.csv"),
      scope: "external",
    })).rejects.toThrow("disk full");
    expect(broker.hasPending("run_ts_1")).toBe(false);
  });

  test("persistence failure while resolving settles the original tool call", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "biomed-perm-fail2-"));
    roots.push(base);
    const workspaceRoot = path.join(base, "workspaces", "task_ts_1");
    await mkdir(workspaceRoot, { recursive: true });
    const policyStore = new InMemoryPermissionPolicyStore();
    const grants = new TemporaryGrantStore();
    const evaluator = new PermissionEvaluator({
      protectedPaths: new ProtectedPaths({ taskOutputRoot: path.join(base, "output", "tasks", "task_ts_1") }),
      grants,
      policyStore,
    });
    const events: Array<{ type: string; request_id?: string }> = [];
    const failingEvents: BrokerOptions["recordRunEvent"] = async () => {
      throw new Error("event stream unwritable");
    };
    const broker = new PermissionBroker({
      taskId: "task_ts_1",
      runId: "run_ts_1",
      evaluator,
      grants,
      policyStore,
      audit: new InMemoryPermissionAuditSink(),
      recordRunEvent: async (payload) => {
        events.push(payload as { type: string; request_id?: string });
      },
    });
    const requested = broker.evaluate({
      capability: "fs.read",
      resource: path.join(baseExternal(), "x.csv"),
      canonicalResource: path.join(baseExternal(), "x.csv"),
      scope: "external",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const requestId = (events.at(-1) as { request_id: string }).request_id;
    // Swap in a failing event recorder AFTER the request was suspended.
    (broker as unknown as { recordRunEvent: BrokerOptions["recordRunEvent"] }).recordRunEvent = failingEvents;
    await expect(broker.resolve("run_ts_1", requestId, "allow", "once")).rejects.toThrow(
      "event stream unwritable",
    );
    // The original tool call must settle with the failure, never hang.
    await expect(requested).rejects.toThrow("event stream unwritable");
    expect(broker.hasPending("run_ts_1")).toBe(false);
  });

  test("cancel rejects the pending request (run cancelled while waiting)", async () => {
    const { broker } = await fixture();
    const requested = broker.evaluate({
      capability: "fs.read",
      resource: path.join(baseExternal(), "x.csv"),
      canonicalResource: path.join(baseExternal(), "x.csv"),
      scope: "external",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(broker.hasPending("run_ts_1")).toBe(true);
    broker.rejectPending("run_ts_1", new Error("run cancelled"));
    await expect(requested).rejects.toThrow("run cancelled");
    expect(broker.hasPending("run_ts_1")).toBe(false);
  });

  test("exec capability defaults to ask and respects persistent exec allow", async () => {
    const ask = await fixture();
    const pending = ask.broker.evaluate({
      capability: "process.exec",
      command: "python scripts/a.py",
      cwd: ask.workspaceRoot,
      scope: "workspace",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ask.events.at(-1)).toMatchObject({ type: "permission_requested", capability: "process.exec" });
    const requestId = (ask.events.at(-1) as { request_id: string }).request_id;
    await ask.broker.resolve("run_ts_1", requestId, "allow", "persistent");
    await expect(pending).resolves.toMatchObject({ decision: "allow" });

    const allowed = await fixture({ persistentExecAllow: true });
    await expect(allowed.broker.evaluate({
      capability: "process.exec",
      command: "node --version",
      cwd: allowed.workspaceRoot,
      scope: "workspace",
    })).resolves.toMatchObject({ decision: "allow" });

    const restricted = await fixture({ preset: "restricted" });
    await expect(restricted.broker.evaluate({
      capability: "process.exec",
      command: "node --version",
      cwd: restricted.workspaceRoot,
      scope: "workspace",
    })).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  test("Restricted preset hard-denies exec even with a persistent exec approval (revocation is effective)", async () => {
    // First grant a persistent exec approval while in ask-when-needed.
    const granted = await fixture();
    await granted.policyStore.setPersistentExecAllow(true);
    await expect(granted.broker.evaluate({
      capability: "process.exec",
      command: "node --version",
      cwd: granted.workspaceRoot,
      scope: "workspace",
    })).resolves.toMatchObject({ decision: "allow" });

    // Switching to Restricted must deny immediately — the flag alone is not
    // allowed to bypass the preset.
    await granted.policyStore.setPreset("restricted");
    await expect(granted.broker.evaluate({
      capability: "process.exec",
      command: "node --version",
      cwd: granted.workspaceRoot,
      scope: "workspace",
    })).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  test("Restricted beats temporary grants and persistent file rules (hard lockdown)", async () => {
    const { broker, grants, policyStore, base } = await fixture();
    const external = path.join(baseExternal());
    await mkdir(external, { recursive: true });
    await writeFile(path.join(external, "clinical.csv"), "x", "utf8");
    // While permissive, the user approves a run grant AND a persistent rule
    // for the external scope/path.
    grants.add("run", "task_ts_1", "run_ts_1", {
      capability: "fs.read",
      scope: "external",
    });
    await policyStore.addRule({
      capability: "fs.read",
      path: external,
      recursive: true,
      policy: "allow",
    });
    await expect(broker.evaluate({
      capability: "fs.read",
      resource: path.join(external, "clinical.csv"),
      canonicalResource: path.join(external, "clinical.csv"),
      scope: "external",
    })).resolves.toMatchObject({ decision: "allow" });

    // Switching to Restricted must revoke both — grants/rules are evaluated
    // AFTER the Restricted preset (audit fix: real hard lockdown).
    await policyStore.setPreset("restricted");
    await expect(broker.evaluate({
      capability: "fs.read",
      resource: path.join(external, "clinical.csv"),
      canonicalResource: path.join(external, "clinical.csv"),
      scope: "external",
    })).rejects.toBeInstanceOf(PermissionDeniedError);
    // Workspace file ops stay allowed under Restricted.
    await writeFile(path.join(base, "workspaces", "task_ts_1", "notes.md"), "x", "utf8");
    await expect(broker.evaluate({
      capability: "fs.write",
      resource: path.join(base, "workspaces", "task_ts_1", "notes.md"),
      canonicalResource: path.join(base, "workspaces", "task_ts_1", "notes.md"),
      scope: "workspace",
    })).resolves.toMatchObject({ decision: "allow" });
  });

  test("resolve is bound to the runId: a wrong run cannot approve a pending request", async () => {
    const { broker, events } = await fixture();
    void broker.evaluate({
      capability: "fs.read",
      resource: path.join(baseExternal(), "a.csv"),
      canonicalResource: path.join(baseExternal(), "a.csv"),
      scope: "external",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const requestId = (events.at(-1) as { request_id: string }).request_id;

    // A different runId with the same requestId must not resolve it.
    expect(await broker.resolve("run_other", requestId, "allow", "once")).toBe(false);
    expect(await broker.resolve("run_ts_1", requestId, "allow", "once")).toBe(true);
  });

  test("one pending request per run; a second concurrent ask is denied", async () => {
    const { broker } = await fixture();
    void broker.evaluate({
      capability: "fs.read",
      resource: path.join(baseExternal(), "a.csv"),
      canonicalResource: path.join(baseExternal(), "a.csv"),
      scope: "external",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(broker.evaluate({
      capability: "fs.read",
      resource: path.join(baseExternal(), "b.csv"),
      canonicalResource: path.join(baseExternal(), "b.csv"),
      scope: "external",
    })).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});

describe("permission audit (P1)", () => {
  test("records capability, scope, resource, decision, grant scope, and timestamps", async () => {
    const { broker, audit, events } = await fixture();
    const resource = path.join(baseExternal(), "audit.csv");
    const requested = broker.evaluate({
      capability: "fs.write",
      resource,
      canonicalResource: resource,
      scope: "external",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const requestId = (events.at(-1) as { request_id: string }).request_id;
    await broker.resolve("run_ts_1", requestId, "allow", "run");
    await expect(requested).resolves.toMatchObject({ decision: "allow" });

    expect(audit.records).toHaveLength(2);
    expect(audit.records[0]).toMatchObject({
      permission_request_id: requestId,
      task_id: "task_ts_1",
      run_id: "run_ts_1",
      capability: "fs.write",
      scope: "external",
      resource,
      decision: "pending",
    });
    expect(audit.records[1]).toMatchObject({
      permission_request_id: requestId,
      decision: "allow",
      grant_scope: "run",
    });
    for (const entry of audit.records) {
      expect(typeof entry.timestamp).toBe("string");
      expect(entry.timestamp.length).toBeGreaterThan(0);
    }
  });
});
