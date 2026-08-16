import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
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
    const createdBody = await created.json() as { rule: { id: string; path: string } };
    expect(createdBody.rule).toMatchObject({
      capability: "fs.read",
      recursive: true,
      policy: "allow",
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
});
