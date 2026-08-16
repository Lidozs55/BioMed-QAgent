import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";

import { afterEach, describe, expect, test } from "vitest";

import { JsonPermissionPolicyStore } from "../src/agent/permissions/index.js";
import { createPermissionSettingsApi } from "../src/settings/permission-settings.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "biomed-perm-settings-"));
  roots.push(dir);
  const filePath = path.join(dir, "agent-permissions.json");
  const policyStore = new JsonPermissionPolicyStore(filePath);
  const api = createPermissionSettingsApi(policyStore);
  const server: Server = createServer((request, response) => {
    if (!api.handle(request, response)) response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, filePath, server };
}

describe("agent permission settings API (P6)", () => {
  test("GET returns the default ask-when-needed settings", async () => {
    const { base, server } = await fixture();
    const response = await fetch(`${base}/api/v1/settings/agent-permissions`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      schema_version: 1,
      preset: "ask_when_needed",
      rules: [],
      persistent_exec_allow: false,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("PUT switches the preset and persists atomically to disk", async () => {
    const { base, filePath, server } = await fixture();
    const response = await fetch(`${base}/api/v1/settings/agent-permissions`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preset: "restricted" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ preset: "restricted" });

    const stored = JSON.parse(await readFile(filePath, "utf8")) as { preset: string };
    expect(stored.preset).toBe("restricted");

    // Invalid preset → 422.
    const invalid = await fetch(`${base}/api/v1/settings/agent-permissions`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preset: "chaotic" }),
    });
    expect(invalid.status).toBe(422);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("PUT persistent-exec enables and revokes command execution approval", async () => {
    const { base, server } = await fixture();
    const enable = await fetch(`${base}/api/v1/settings/agent-permissions/persistent-exec`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(enable.status).toBe(200);
    expect(await enable.json()).toMatchObject({ persistent_exec_allow: true });

    const revoke = await fetch(`${base}/api/v1/settings/agent-permissions/persistent-exec`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(revoke.status).toBe(200);
    expect(await revoke.json()).toMatchObject({ persistent_exec_allow: false });

    const invalid = await fetch(`${base}/api/v1/settings/agent-permissions/persistent-exec`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: "yes" }),
    });
    expect(invalid.status).toBe(422);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("switching to Restricted revokes a previously granted persistent exec approval", async () => {
    const { base, server } = await fixture();
    const enable = await fetch(`${base}/api/v1/settings/agent-permissions/persistent-exec`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect((await enable.json() as { persistent_exec_allow: boolean }).persistent_exec_allow).toBe(true);

    const restricted = await fetch(`${base}/api/v1/settings/agent-permissions`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preset: "restricted" }),
    });
    expect(restricted.status).toBe(200);
    expect(await restricted.json()).toMatchObject({
      preset: "restricted",
      persistent_exec_allow: false,
    });

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("POST canonicalizes persistent rules to absolute paths; DELETE removes them", async () => {
    const { base, filePath, server } = await fixture();
    const ruleRoot = await mkdtemp(path.join(os.tmpdir(), "biomed-rule-root-"));
    roots.push(ruleRoot);
    const target = path.join(ruleRoot, "nested", "dir");
    await mkdir(target, { recursive: true });

    const created = await fetch(`${base}/api/v1/settings/agent-permissions/rules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capability: "fs.read",
        path: target,
        recursive: true,
        policy: "allow",
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { rule: { id: string; path: string; resource_scope: string } };
    expect(createdBody.rule).toMatchObject({
      capability: "fs.read",
      recursive: true,
      policy: "allow",
      // Round-4 audit: rules default to the project scope; the caller can
      // bind an explicit scope (e.g. ``sensitive``) so a project rule can
      // never cross into sensitive targets.
      resource_scope: "project",
    });
    // The stored path is canonical (realpath), not the raw input string.
    const canonicalExpected = await realpath(target);
    const storedPath = createdBody.rule.path;
    if (process.platform === "win32") {
      expect(storedPath.toLowerCase()).toBe(canonicalExpected.toLowerCase());
    } else {
      expect(storedPath).toBe(canonicalExpected);
    }

    const stored = JSON.parse(await readFile(filePath, "utf8")) as { rules: unknown[] };
    expect(stored.rules).toHaveLength(1);
    const deleted = await fetch(
      `${base}/api/v1/settings/agent-permissions/rules/${createdBody.rule.id}`,
      { method: "DELETE" },
    );
    expect(deleted.status).toBe(200);
    expect((await deleted.json() as { rules: unknown[] }).rules).toEqual([]);

    // Invalid capability → 422.
    const invalid = await fetch(`${base}/api/v1/settings/agent-permissions/rules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capability: "network.http",
        path: "D:\\x",
        recursive: true,
        policy: "allow",
      }),
    });
    expect(invalid.status).toBe(422);

    // An explicit sensitive scope binds the rule (round-4 audit) and a
    // framework_internal scope is rejected.
    const sensitive = await fetch(`${base}/api/v1/settings/agent-permissions/rules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capability: "fs.read",
        resource_scope: "sensitive",
        path: "D:\\repo\\credentials.json",
        recursive: false,
        policy: "allow",
      }),
    });
    expect(sensitive.status).toBe(201);
    expect((await sensitive.json() as { rule: { resource_scope: string } }).rule.resource_scope).toBe("sensitive");
    const framework = await fetch(`${base}/api/v1/settings/agent-permissions/rules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capability: "fs.read",
        resource_scope: "framework_internal",
        path: "D:\\x",
        recursive: true,
        policy: "allow",
      }),
    });
    expect(framework.status).toBe(422);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("a freshly created store instance reads the same persisted settings", async () => {
    const { base, filePath, server } = await fixture();
    await fetch(`${base}/api/v1/settings/agent-permissions`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preset: "full_access" }),
    });
    // New instance (e.g. after restart) sees the persisted preset.
    const reopened = new JsonPermissionPolicyStore(filePath);
    expect((await reopened.getSettings()).preset).toBe("full_access");
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("round-4 audit: pre-resource_scope rules load as project-scoped (fail-safe migration)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "biomed-perm-legacy-rule-"));
    roots.push(dir);
    const filePath = path.join(dir, "agent-permissions.json");
    // A settings file written by an older version: rules carry no
    // resource_scope. Loading must bind them to ``project`` — they keep
    // working for project targets but can never cover sensitive/external
    // paths (round-4 audit).
    await writeFile(filePath, JSON.stringify({
      schema_version: 1,
      preset: "ask_when_needed",
      persistent_exec_allow: false,
      rules: [{
        id: "rule_legacy",
        capability: "fs.read",
        path: "D:\\repo",
        recursive: true,
        policy: "allow",
      }],
    }), "utf8");
    const store = new JsonPermissionPolicyStore(filePath);
    const settings = await store.getSettings();
    expect(settings.rules).toHaveLength(1);
    expect(settings.rules[0]).toMatchObject({ id: "rule_legacy", resource_scope: "project" });
  });

  test("concurrent mutations are serialized: no rule is lost (audit fix)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "biomed-perm-serial-"));
    roots.push(dir);
    const store = new JsonPermissionPolicyStore(path.join(dir, "agent-permissions.json"));
    const paths = ["D:\\a", "D:\\b", "D:\\c", "D:\\d", "D:\\e"];
    await Promise.all(paths.map((p) => store.addRule({
      capability: "fs.read",
      path: p,
      resource_scope: "project",
      recursive: true,
      policy: "allow",
    })));
    const settings = await store.getSettings();
    expect(settings.rules).toHaveLength(paths.length);
    // And the on-disk state matches the in-memory state (a restart sees the
    // same rules).
    const reopened = new JsonPermissionPolicyStore(path.join(dir, "agent-permissions.json"));
    expect((await reopened.getSettings()).rules).toHaveLength(paths.length);
  });

  test("a failed disk write leaves the cache unchanged (write-then-swap)", async () => {
    // filePath points INSIDE a path whose parent is a FILE, so writeJsonAtomic
    // cannot create the directory: the mutation must fail and the in-memory
    // cache must NOT pretend the rule was saved.
    const dir = await mkdtemp(path.join(os.tmpdir(), "biomed-perm-fail-"));
    roots.push(dir);
    const blocker = path.join(dir, "blocker");
    await writeFile(blocker, "x", "utf8");
    const store = new JsonPermissionPolicyStore(path.join(blocker, "agent-permissions.json"));
    await expect(store.addRule({
      capability: "fs.read",
      path: "D:\\x",
      resource_scope: "project",
      recursive: true,
      policy: "allow",
    })).rejects.toThrow();
    const settings = await store.getSettings();
    expect(settings.rules).toHaveLength(0);
    // A later successful mutation still works (the queue is not poisoned).
    const good = new JsonPermissionPolicyStore(path.join(dir, "agent-permissions.json"));
    await good.addRule({ capability: "fs.read", path: "D:\\y", resource_scope: "project", recursive: true, policy: "allow" });
    expect((await good.getSettings()).rules).toHaveLength(1);
  });

  test("persistent exec cannot be enabled while Restricted (store-level invariant)", async () => {
    const { base, server } = await fixture();
    // Restricted first.
    const restricted = await fetch(`${base}/api/v1/settings/agent-permissions`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preset: "restricted" }),
    });
    expect(restricted.status).toBe(200);
    // Enabling the flag must be refused at the API level (409), not just in
    // the UI — otherwise switching back to ask_when_needed later would
    // silently resurrect a permanent exec approval (round-3 audit).
    const enable = await fetch(`${base}/api/v1/settings/agent-permissions/persistent-exec`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(enable.status).toBe(409);
    // The flag was NOT persisted.
    const settings = await fetch(`${base}/api/v1/settings/agent-permissions`);
    expect(await settings.json()).toMatchObject({
      preset: "restricted",
      persistent_exec_allow: false,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("temp grants can be listed and revoked through the settings API", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "biomed-perm-grants-"));
    roots.push(dir);
    const policyStore = new JsonPermissionPolicyStore(path.join(dir, "agent-permissions.json"));
    const { PermissionBroker, PermissionBrokerRegistry, PermissionEvaluator, ProtectedPaths, TemporaryGrantStore, InMemoryPermissionAuditSink } =
      await import("../src/agent/permissions/index.js");
    const registry = new PermissionBrokerRegistry();
    const api = createPermissionSettingsApi(policyStore, registry);
    const server: Server = createServer((request, response) => {
      if (!api.handle(request, response)) response.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // A live broker with one run grant.
    const grants = new TemporaryGrantStore();
    const broker = new PermissionBroker({
      taskId: "task_ts_1",
      runId: "run_ts_1",
      evaluator: new PermissionEvaluator({
        protectedPaths: new ProtectedPaths({ taskOutputRoot: path.join(dir, "output") }),
        grants,
        policyStore,
      }),
      grants,
      policyStore,
      audit: new InMemoryPermissionAuditSink(),
      recordRunEvent: async () => undefined,
    });
    registry.register("task_ts_1", broker);
    const id = grants.add("run", "task_ts_1", "run_ts_1", {
      capability: "fs.read",
      scope: "external",
      root: path.join(dir, "data"),
    });

    const listing = await fetch(`${base}/api/v1/settings/agent-permissions/temp-grants`);
    expect(listing.status).toBe(200);
    const body = await listing.json() as { grants: Array<{ id: string; root: string; boundTo: string }> };
    expect(body.grants).toHaveLength(1);
    expect(body.grants[0]).toMatchObject({ id, boundTo: "run", root: path.join(dir, "data") });

    const revoked = await fetch(`${base}/api/v1/settings/agent-permissions/temp-grants/${id}`, {
      method: "DELETE",
    });
    expect(revoked.status).toBe(200);
    expect(grants.list()).toHaveLength(0);

    const again = await fetch(`${base}/api/v1/settings/agent-permissions/temp-grants/${id}`, {
      method: "DELETE",
    });
    expect(again.status).toBe(422);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("switching the preset to Restricted invalidates pending approvals host-wide", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "biomed-perm-invalidate-"));
    roots.push(dir);
    const policyStore = new JsonPermissionPolicyStore(path.join(dir, "agent-permissions.json"));
    const { PermissionBroker, PermissionBrokerRegistry, PermissionEvaluator, ProtectedPaths, TemporaryGrantStore, InMemoryPermissionAuditSink } =
      await import("../src/agent/permissions/index.js");
    const registry = new PermissionBrokerRegistry();
    const api = createPermissionSettingsApi(policyStore, registry);
    const server: Server = createServer((request, response) => {
      if (!api.handle(request, response)) response.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const grants = new TemporaryGrantStore();
    const broker = new PermissionBroker({
      taskId: "task_ts_1",
      runId: "run_ts_1",
      evaluator: new PermissionEvaluator({
        protectedPaths: new ProtectedPaths({ taskOutputRoot: path.join(dir, "output") }),
        grants,
        policyStore,
      }),
      grants,
      policyStore,
      audit: new InMemoryPermissionAuditSink(),
      recordRunEvent: async () => undefined,
    });
    registry.register("task_ts_1", broker);
    const suspended = broker.evaluate({
      capability: "fs.read",
      resource: path.join(dir, "x.csv"),
      canonicalResource: path.join(dir, "x.csv"),
      scope: "external",
    });
    // The promise will reject while the PUT below is in flight; keep the
    // placeholder so the eventual ``rejects`` assertion is not flagged as an
    // unhandled rejection in between.
    suspended.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(broker.hasPending("run_ts_1")).toBe(true);

    const restricted = await fetch(`${base}/api/v1/settings/agent-permissions`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preset: "restricted" }),
    });
    expect(restricted.status).toBe(200);
    // The pending tool call settled with a denial and the card is gone.
    await expect(suspended).rejects.toThrow("preset switched to restricted");
    expect(broker.hasPending("run_ts_1")).toBe(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("round-4 audit: Restricted CLEARS temporary grants host-wide (no resurrection on switch-back)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "biomed-perm-lockdown-"));
    roots.push(dir);
    const policyStore = new JsonPermissionPolicyStore(path.join(dir, "agent-permissions.json"));
    const { PermissionBroker, PermissionBrokerRegistry, PermissionEvaluator, ProtectedPaths, TemporaryGrantStore, InMemoryPermissionAuditSink } =
      await import("../src/agent/permissions/index.js");
    const registry = new PermissionBrokerRegistry();
    const api = createPermissionSettingsApi(policyStore, registry);
    const server: Server = createServer((request, response) => {
      if (!api.handle(request, response)) response.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const grants = new TemporaryGrantStore();
    grants.add("run", "task_ts_1", "run_ts_1", {
      capability: "fs.read",
      scope: "external",
      root: path.join(dir, "data"),
    });
    grants.add("task", "task_ts_1", "run_ts_1", {
      capability: "fs.read",
      scope: "external",
      root: null,
    });
    const broker = new PermissionBroker({
      taskId: "task_ts_1",
      runId: "run_ts_1",
      evaluator: new PermissionEvaluator({
        protectedPaths: new ProtectedPaths({ taskOutputRoot: path.join(dir, "output") }),
        grants,
        policyStore,
      }),
      grants,
      policyStore,
      audit: new InMemoryPermissionAuditSink(),
      recordRunEvent: async () => undefined,
    });
    registry.register("task_ts_1", broker);
    expect(registry.listTemporaryGrants()).toHaveLength(2);

    const restricted = await fetch(`${base}/api/v1/settings/agent-permissions`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preset: "restricted" }),
    });
    expect(restricted.status).toBe(200);

    // Lockdown clears, it does not merely suppress: switching back must not
    // resurrect previously approved grants (ADR-026 "cannot survive").
    expect(registry.listTemporaryGrants()).toHaveLength(0);

    const back = await fetch(`${base}/api/v1/settings/agent-permissions`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preset: "ask_when_needed" }),
    });
    expect(back.status).toBe(200);
    expect(registry.listTemporaryGrants()).toHaveLength(0);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
