import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ModelSettingsService } from "../src/settings/model-settings.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe("network fault injection", () => {
  test("model discovery fails closed when the provider is unreachable", async () => {
    const settingsDir = await mkdtemp(path.join(os.tmpdir(), "biomed-net-"));
    roots.push(settingsDir);
    const service = await ModelSettingsService.create({
      settingsDir,
      environment: {},
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
      fetcher: async () => {
        throw Object.assign(new Error("connect ECONNREFUSED 93.184.216.34:443"), { code: "ECONNREFUSED" });
      },
    });

    await expect(service.discover("https://example.com/v1", "sk-key")).rejects.toThrow();
  });
});