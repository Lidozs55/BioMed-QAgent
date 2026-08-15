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

describe("concurrent settings writes", () => {
  test("serializes concurrent PUT and ends in a consistent state (M10-T06)", async () => {
    const settingsDir = await mkdtemp(path.join(os.tmpdir(), "biomed-put-"));
    roots.push(settingsDir);
    const service = await ModelSettingsService.create({ settingsDir, environment: {} });
    const server = createServer((request, response) => {
      if (!service.handle(request, response)) response.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const statuses = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        fetch(`${base}/api/v1/settings`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model_name: `model-${i}` }),
        }).then((res) => res.status),
      ),
    );
    expect(statuses.every((status) => status === 200)).toBe(true);

    const get = await fetch(`${base}/api/v1/settings`);
    const settings = await get.json() as { model_name: string };
    expect(/^model-\d+$/.test(settings.model_name)).toBe(true);
  });
});