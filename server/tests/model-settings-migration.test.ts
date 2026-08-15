import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { ModelSettingsService } from "../src/settings/model-settings.js";

function randomId(): string {
  return Math.random().toString(16).slice(2);
}

describe("legacy model.json migration", () => {
  test("migrates legacy settings into the new registry without a Python bridge", async () => {
    const settingsDir = path.join(os.tmpdir(), `biomed-${randomId()}-settings`);
    await mkdir(settingsDir, { recursive: true });
    await writeFile(
      path.join(settingsDir, "model.json"),
      JSON.stringify({
        base_url: "https://legacy.example/v1",
        model_name: "legacy-chat",
        api_key: "sk-legacy-secret",
        advanced: { temperature: 0.4 },
      }),
      "utf8",
    );

    const service = await ModelSettingsService.create({ settingsDir, environment: {} });

    const auth = await readFile(path.join(settingsDir, "model-auth.json"), "utf8");
    expect(auth).toContain("sk-legacy-secret");

    const registry = JSON.parse(
      await readFile(path.join(settingsDir, "model-registry.json"), "utf8"),
    ) as { settings: { base_url: string; model_name: string; advanced: { temperature: number } } };
    expect(registry.settings.base_url).toBe("https://legacy.example/v1");
    expect(registry.settings.model_name).toBe("legacy-chat");
    expect(registry.settings.advanced.temperature).toBe(0.4);

    const active = await service.resolveActiveModel();
    expect(active.apiKey).toBe("sk-legacy-secret");
    expect(active.modelId).toBe("legacy-chat");
  });
});