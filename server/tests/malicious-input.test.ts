import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ModelSettingsService } from "../src/settings/model-settings.js";

const servers: Server[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe("malicious large input", () => {
  test("oversized and deeply nested settings do not crash the service", async () => {
    const settingsDir = await mkdtemp(path.join(os.tmpdir(), "biomed-malicious-"));
    roots.push(settingsDir);
    const service = await ModelSettingsService.create({ settingsDir });
    const server = createServer((request, response) => {
      if (!service.handle(request, response)) response.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const deep: Record<string, unknown> = {};
    let cursor: Record<string, unknown> = deep;
    for (let i = 0; i < 100; i += 1) { cursor.child = {}; cursor = cursor.child as Record<string, unknown>; }

    const res = await fetch(`${base}/api/v1/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model_name: "x".repeat(200_000), runtime_limits: deep }),
    });
    expect([200, 400, 413, 422]).toContain(res.status);

    const get = await fetch(`${base}/api/v1/settings`);
    expect(get.status).toBe(200);
  });
});