import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DEFAULT_RUNTIME_LIMITS } from "@biomed/contracts";
import { describe, expect, test, vi } from "vitest";

import { ModelSettingsService } from "../src/settings/model-settings.js";

function randomId(): string {
  return Math.random().toString(16).slice(2);
}

function tmpSettingsDir(): string {
  return path.join(os.tmpdir(), `biomed-${randomId()}-settings`);
}

describe("legacy model.json migration", () => {
  test("migrates legacy settings into the new registry without a Python bridge", async () => {
    const settingsDir = tmpSettingsDir();
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

describe("loaded registry schema validation", () => {
  test("clamps corrupt numeric and boolean settings on disk back to defaults", async () => {
    const settingsDir = tmpSettingsDir();
    await mkdir(settingsDir, { recursive: true });
    // Written as raw JSON so ``1e999`` parses to Infinity (a corrupt value
    // JSON.stringify could not have produced).
    await writeFile(
      path.join(settingsDir, "model-registry.json"),
      `{
        "version": 1,
        "settings": {
          "provider_id": null,
          "active_model_id": null,
          "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
          "model_name": "qwen3.7-plus",
          "max_tokens": -5,
          "context_window": 1e999,
          "safety_reserve_ratio": 0.9,
          "compaction_trigger_ratio": 5,
          "compaction_target_ratio": "0.5",
          "advanced": {
            "temperature": "hot",
            "top_p": 3,
            "repetition_penalty": -1,
            "enable_search": "yes",
            "thinking_mode": null
          },
          "runtime_limits": { "command_timeout_seconds": 999999, "gdc_max_files": 0 },
          "runtime_limits_version": 1
        },
        "providers": [],
        "models": []
      }`,
      "utf8",
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const service = await ModelSettingsService.create({ settingsDir, environment: {} });
      expect(service.getSettings()).toMatchObject({
        max_tokens: 8192,
        // context_window falls back to the null default → inferred at runtime.
        context_window: 131_072,
        safety_reserve_ratio: 0.05,
        compaction_trigger_ratio: 0.85,
        compaction_target_ratio: 0.45,
        advanced: {
          temperature: 0.7,
          top_p: 1,
          repetition_penalty: 1,
          enable_search: false,
          thinking_mode: false,
        },
        runtime_limits: { ...DEFAULT_RUNTIME_LIMITS },
      });
      // Repairing loaded values must not be silent.
      expect(
        warnSpy.mock.calls.some((args) => args.join(" ").includes("settings.max_tokens")),
      ).toBe(true);
      expect(
        warnSpy.mock.calls.some((args) => args.join(" ").includes("runtime_limits.command_timeout_seconds")),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("vision model role migration", () => {
  test("existing registries load with vision_model_id null and never infer it from capabilities", async () => {
    const settingsDir = tmpSettingsDir();
    await mkdir(settingsDir, { recursive: true });
    // A pre-vision-role registry: no vision_model_id field, and an active
    // manually-edited model that happens to carry an image capability.
    await writeFile(
      path.join(settingsDir, "model-registry.json"),
      JSON.stringify({
        version: 1,
        settings: {
          provider_id: "provider_old",
          active_model_id: "model_old",
          base_url: "https://legacy.example/v1",
          model_name: "legacy-vl",
          max_tokens: 4096,
          context_window: 32768,
          safety_reserve_ratio: 0.05,
          compaction_trigger_ratio: 0.85,
          compaction_target_ratio: 0.6,
          advanced: {
            temperature: 0.7,
            top_p: 1,
            repetition_penalty: 1,
            enable_search: false,
            thinking_mode: false,
          },
          runtime_limits_version: 1,
        },
        providers: [{
          id: "provider_old",
          name: "Legacy",
          base_url: "https://legacy.example/v1",
          preset_id: null,
          description: "",
          enabled: true,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        }],
        models: [{
          id: "model_old",
          provider_id: "provider_old",
          model_id: "legacy-vl",
          name: "Legacy VL",
          description: "",
          context_window: 32768,
          max_output_tokens: 4096,
          suggested_max_tokens: 4096,
          capabilities: { text: true, image: true, video: false, audio: false },
          params: {},
          source: "manual",
          metadata_source: "user",
          active: true,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        }],
      }),
      "utf8",
    );
    const registryPath = path.join(settingsDir, "model-registry.json");

    const service = await ModelSettingsService.create({ settingsDir, environment: {} });

    // The explicit visual role stays unset: a manually edited capability is
    // never promoted into an assignment during migration.
    const stored = JSON.parse(await readFile(registryPath, "utf8")) as {
      settings: { vision_model_id?: unknown };
    };
    expect(stored.settings.vision_model_id).toBeNull();
    expect(service.getSettings()).toMatchObject({ vision_model_id: null });
  });

  test("corrupt on-disk vision_model_id values fall back to null with a warning", async () => {
    const settingsDir = tmpSettingsDir();
    await mkdir(settingsDir, { recursive: true });
    await writeFile(
      path.join(settingsDir, "model-registry.json"),
      JSON.stringify({
        version: 1,
        settings: {
          provider_id: null,
          active_model_id: null,
          base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          model_name: "",
          max_tokens: 8192,
          context_window: null,
          safety_reserve_ratio: 0.05,
          compaction_trigger_ratio: 0.85,
          compaction_target_ratio: 0.45,
          advanced: {},
          vision_model_id: 42,
          runtime_limits_version: 1,
        },
        providers: [],
        models: [],
      }),
      "utf8",
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const service = await ModelSettingsService.create({ settingsDir, environment: {} });
      expect(service.getSettings()).toMatchObject({ vision_model_id: null });
      expect(
        warnSpy.mock.calls.some((args) => args.join(" ").includes("vision_model_id")),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("legacy value range clamping on migration", () => {
  test("clamps out-of-range legacy model.json values before persisting", async () => {
    const settingsDir = tmpSettingsDir();
    await mkdir(settingsDir, { recursive: true });
    await writeFile(
      path.join(settingsDir, "model.json"),
      JSON.stringify({
        base_url: "https://legacy.example/v1",
        model_name: "legacy-chat",
        api_key: "sk-legacy-secret",
        max_tokens: 999_999_999,
        context_window: -1,
        compaction_target_ratio: 0.999,
        advanced: { temperature: "hot", enable_search: "yes" },
      }),
      "utf8",
    );

    const service = await ModelSettingsService.create({ settingsDir, environment: {} });

    expect(service.getSettings()).toMatchObject({
      max_tokens: 8192,
      context_window: 131_072,
      compaction_target_ratio: 0.45,
      advanced: { temperature: 0.7, enable_search: false },
    });
  });

  test("clamps corrupt legacy SQLite model capacities", async () => {
    const settingsDir = tmpSettingsDir();
    const databasePath = path.join(settingsDir, "model_registry.db");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(settingsDir, { recursive: true });
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE providers (id TEXT, name TEXT, base_url TEXT, api_key TEXT,
        preset_id TEXT, description TEXT, enabled INTEGER, created_at TEXT, updated_at TEXT);
      CREATE TABLE managed_models (id TEXT, provider_id TEXT, model_id TEXT, name TEXT,
        description TEXT, context_window INTEGER, max_output_tokens INTEGER,
        suggested_max_tokens INTEGER, capabilities TEXT, params TEXT, param_specs TEXT,
        source TEXT, active INTEGER, created_at TEXT, updated_at TEXT);
      INSERT INTO providers VALUES ('provider_old', 'Legacy', 'https://legacy.example/v1',
        'legacy-secret', 'openai', '', 1, '2026-01-01', '2026-01-01');
      INSERT INTO managed_models VALUES ('model_old', 'provider_old', 'legacy-model',
        'Legacy model', '', 999999999, -5, 0, '{"text":true}',
        '{}', '[]', 'manual', 1, '2026-01-01', '2026-01-01');
    `);
    database.close();

    const service = await ModelSettingsService.create({
      settingsDir,
      legacyRegistryPath: databasePath,
    });

    expect(service.listModels()[0]).toMatchObject({
      model_id: "legacy-model",
      context_window: null,
      max_output_tokens: null,
      suggested_max_tokens: null,
    });
    // The clamped-out window falls back to null (unknown) → inferred 131072.
    expect(await service.resolveActiveModel()).toMatchObject({
      modelId: "legacy-model",
      contextWindow: 131_072,
      maxTokens: 8192,
    });
  });
});
