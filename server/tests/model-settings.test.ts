import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, test } from "vitest";

import { DEFAULT_RUNTIME_LIMITS } from "@biomed/contracts";

import { ModelSettingsService } from "../src/settings/model-settings.js";
import { ENV_BOOTSTRAP_PROVIDER_ID } from "../src/settings/model-registry/store.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

async function serve(service: ModelSettingsService): Promise<string> {
  const server = createServer((request, response) => {
    if (!service.handle(request, response)) response.writeHead(404).end();
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("TypeScript model settings", () => {
  test("creates providers and models, masks secrets, and feeds active parameters to Pi", async () => {
    const settingsDir = path.join(tmpdir(), `biomed-${randomId()}-settings`);
    const service = await ModelSettingsService.create({ settingsDir, environment: {} });
    const baseUrl = await serve(service);

    const providerResponse = await fetch(`${baseUrl}/api/v1/model-registry/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Custom OpenAI",
        base_url: "https://models.example/v1",
        api_key: "sk-secret-provider-value",
      }),
    });
    const provider = await providerResponse.json() as Record<string, unknown>;
    expect(provider.api_key).toBe("sk-secre...alue");
    expect(provider.api_key).not.toBe("sk-secret-provider-value");

    const modelResponse = await fetch(`${baseUrl}/api/v1/model-registry/models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider_id: provider.id,
        model_id: "custom-chat",
        context_window: 64000,
        params: { max_tokens: 3072, temperature: 0.25, top_p: 0.8 },
      }),
    });
    const model = await modelResponse.json() as Record<string, unknown>;
    const activated = await fetch(
      `${baseUrl}/api/v1/model-registry/models/${String(model.id)}/activate`,
      { method: "POST" },
    );
    expect((await activated.json() as Record<string, unknown>).model_name).toBe("custom-chat");

    expect(await service.resolveActiveModel()).toEqual({
      provider: provider.id,
      modelId: "custom-chat",
      apiKey: "sk-secret-provider-value",
      baseUrl: "https://models.example/v1",
      contextWindow: 64000,
      maxTokens: 3072,
      compactionTriggerRatio: 0.85,
      compactionTargetRatio: 0.45,
      temperature: 0.25,
      topP: 0.8,
      repetitionPenalty: 1,
      enableSearch: false,
      thinkingMode: false,
    });
    expect(await readFile(path.join(settingsDir, "model-registry.json"), "utf8"))
      .not.toContain("sk-secret-provider-value");
    expect(await readFile(path.join(settingsDir, "model-auth.json"), "utf8"))
      .toContain("sk-secret-provider-value");
  });

  test("activates the first managed model automatically and keeps it as runtime settings", async () => {
    const settingsDir = path.join(tmpdir(), `biomed-${randomId()}-settings`);
    const service = await ModelSettingsService.create({ settingsDir, environment: {} });
    const baseUrl = await serve(service);

    const providerResponse = await fetch(`${baseUrl}/api/v1/model-registry/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Auto Provider",
        base_url: "https://models.example/v1",
        api_key: "sk-auto-secret",
      }),
    });
    const provider = await providerResponse.json() as Record<string, unknown>;
    const modelResponse = await fetch(`${baseUrl}/api/v1/model-registry/models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider_id: provider.id,
        model_id: "custom-auto",
        context_window: 64000,
      }),
    });
    const model = await modelResponse.json() as Record<string, unknown>;

    expect(model.active).toBe(true);
    const settings = await (await fetch(`${baseUrl}/api/v1/settings`)).json() as Record<string, unknown>;
    expect(settings.model_name).toBe("custom-auto");
    expect(settings.run_ready).toBe(true);
    await expect(service.resolveActiveModel()).resolves.toMatchObject({
      provider: provider.id,
      modelId: "custom-auto",
      apiKey: "sk-auto-secret",
      baseUrl: "https://models.example/v1",
    });
  });

  test("does not replace an already active model when another model is added", async () => {
    const settingsDir = path.join(tmpdir(), `biomed-${randomId()}-settings`);
    const service = await ModelSettingsService.create({ settingsDir, environment: {} });
    const baseUrl = await serve(service);

    const providerResponse = await fetch(`${baseUrl}/api/v1/model-registry/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Active Provider",
        base_url: "https://models.example/v1",
        api_key: "sk-active-secret",
      }),
    });
    const provider = await providerResponse.json() as Record<string, unknown>;
    const create = async (modelId: string): Promise<Record<string, unknown>> => {
      const response = await fetch(`${baseUrl}/api/v1/model-registry/models`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider_id: provider.id, model_id: modelId }),
      });
      return await response.json() as Record<string, unknown>;
    };

    const first = await create("first-model");
    const second = await create("second-model");
    const models = await (await fetch(`${baseUrl}/api/v1/model-registry/models`)).json() as Array<Record<string, unknown>>;
    const active = models.filter((model) => model.active === true);

    expect(first.active).toBe(true);
    expect(second.active).toBe(false);
    expect(active).toHaveLength(1);
    expect((active[0] as Record<string, unknown>).model_id).toBe("first-model");
    expect((await service.resolveActiveModel()).modelId).toBe("first-model");
  });

  test("clears active runtime settings when the active model is deleted", async () => {
    const settingsDir = path.join(tmpdir(), `biomed-${randomId()}-settings`);
    const service = await ModelSettingsService.create({ settingsDir, environment: {} });
    const baseUrl = await serve(service);
    const providerResponse = await fetch(`${baseUrl}/api/v1/model-registry/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Delete Provider",
        base_url: "https://models.example/v1",
        api_key: "sk-delete-secret",
      }),
    });
    const provider = await providerResponse.json() as Record<string, unknown>;
    const modelResponse = await fetch(`${baseUrl}/api/v1/model-registry/models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider_id: provider.id, model_id: "delete-me" }),
    });
    const model = await modelResponse.json() as Record<string, unknown>;

    await fetch(`${baseUrl}/api/v1/model-registry/models/${String(model.id)}`, {
      method: "DELETE",
    });
    const settings = await (await fetch(`${baseUrl}/api/v1/settings`)).json() as Record<string, unknown>;

    expect(settings.model_name).toBe("");
    expect(settings.run_ready).toBe(false);
    expect(settings.run_block_reason).not.toBeNull();
    await expect(service.resolveActiveModel()).rejects.toThrow();
  });

  test("clears active runtime settings when the active provider is deleted", async () => {
    const settingsDir = path.join(tmpdir(), `biomed-${randomId()}-settings`);
    const service = await ModelSettingsService.create({ settingsDir, environment: {} });
    const baseUrl = await serve(service);
    const providerResponse = await fetch(`${baseUrl}/api/v1/model-registry/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Delete Provider Active",
        base_url: "https://models.example/v1",
        api_key: "sk-delete-provider-secret",
      }),
    });
    const provider = await providerResponse.json() as Record<string, unknown>;
    const modelResponse = await fetch(`${baseUrl}/api/v1/model-registry/models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider_id: provider.id, model_id: "delete-provider-model" }),
    });
    const model = await modelResponse.json() as Record<string, unknown>;

    await fetch(`${baseUrl}/api/v1/model-registry/providers/${String(provider.id)}`, {
      method: "DELETE",
    });
    const settings = await (await fetch(`${baseUrl}/api/v1/settings`)).json() as Record<string, unknown>;

    expect(settings.model_name).toBe("");
    expect(settings.run_ready).toBe(false);
    expect(settings.run_block_reason).not.toBeNull();
    await expect(service.resolveActiveModel()).rejects.toThrow();
    expect(model.id).toBeTruthy();
  });

  test("persists, validates, and resets runtime limits", async () => {
    const settingsDir = path.join(tmpdir(), `biomed-${randomId()}-settings`);
    const service = await ModelSettingsService.create({ settingsDir, environment: {} });
    const baseUrl = await serve(service);

    const updated = await fetch(`${baseUrl}/api/v1/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runtime_limits: {
          command_timeout_seconds: 7200,
          gdc_max_files: 200,
        },
      }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      runtime_limits: {
        ...DEFAULT_RUNTIME_LIMITS,
        command_timeout_seconds: 7200,
        gdc_max_files: 200,
      },
    });
    expect(service.resolveRuntimeLimits()).toMatchObject({
      command_timeout_seconds: 7200,
      gdc_max_files: 200,
    });

    const beforeInvalid = service.getSettings();
    const invalid = await fetch(`${baseUrl}/api/v1/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        base_url: "https://must-not-stick.example/v1",
        runtime_limits: { command_timeout_seconds: 86_401 },
      }),
    });
    expect(invalid.status).toBe(422);
    expect(service.resolveRuntimeLimits().command_timeout_seconds).toBe(7200);
    expect(service.getSettings()).toEqual(beforeInvalid);

    const unknown = await fetch(`${baseUrl}/api/v1/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runtime_limits: { imaginary_limit: 1 } }),
    });
    expect(unknown.status).toBe(422);

    const reset = await fetch(`${baseUrl}/api/v1/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runtime_limits: null }),
    });
    expect(reset.status).toBe(200);
    expect(service.resolveRuntimeLimits()).toEqual(DEFAULT_RUNTIME_LIMITS);
  });

  test("exposes a context budget warning while keeping the API-ready state", async () => {
    const settingsDir = path.join(tmpdir(), `biomed-${randomId()}-settings`);
    const service = await ModelSettingsService.create({ settingsDir, environment: {} });
    const baseUrl = await serve(service);

    const providerResponse = await fetch(`${baseUrl}/api/v1/model-registry/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Small Context Provider",
        base_url: "https://models.example/v1",
        api_key: "sk-small-context-provider",
      }),
    });
    const provider = await providerResponse.json() as Record<string, unknown>;
    const modelResponse = await fetch(`${baseUrl}/api/v1/model-registry/models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider_id: provider.id,
        model_id: "small-context-chat",
        context_window: 4094,
        source: "manual",
      }),
    });
    const model = await modelResponse.json() as Record<string, unknown>;
    await fetch(`${baseUrl}/api/v1/model-registry/models/${String(model.id)}/activate`, {
      method: "POST",
    });

    expect(service.getSettings()).toMatchObject({
      context_window: 4094,
      available_input_tokens: 0,
      run_ready: true,
      run_block_reason: "上下文窗口不足以容纳最大输出和保留空间",
    });
  });

  test("migrates unversioned legacy runtime limits to the widened defaults", async () => {
    const settingsDir = path.join(tmpdir(), `biomed-${randomId()}-settings`);
    await ModelSettingsService.create({ settingsDir, environment: {} });
    const registryPath = path.join(settingsDir, "model-registry.json");
    const stored = JSON.parse(await readFile(registryPath, "utf8")) as {
      settings: Record<string, unknown>;
    };
    delete stored.settings.runtime_limits_version;
    stored.settings.runtime_limits = {
      agent_max_turns: 240,
      http_timeout_seconds: 30,
      browser_timeout_seconds: 120,
    };
    await writeFile(registryPath, JSON.stringify(stored), "utf8");

    const migrated = await ModelSettingsService.create({ settingsDir, environment: {} });
    expect(migrated.resolveRuntimeLimits()).toEqual(DEFAULT_RUNTIME_LIMITS);
    const persisted = JSON.parse(await readFile(registryPath, "utf8")) as {
      settings: { runtime_limits_version?: number };
    };
    expect(persisted.settings.runtime_limits_version).toBe(1);
  });

  test("feeds configured compaction thresholds into the Pi model config", async () => {
    const settingsDir = path.join(tmpdir(), `biomed-${randomId()}-settings`);
    const service = await ModelSettingsService.create({
      settingsDir,
      environment: { PI_API_KEY: "sk-direct-secret" },
    });
    const baseUrl = await serve(service);

    await fetch(`${baseUrl}/api/v1/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        compaction_trigger_ratio: 0.9,
        compaction_target_ratio: 0.55,
      }),
    });

    expect(await service.resolveActiveModel()).toMatchObject({
      compactionTriggerRatio: 0.9,
      compactionTargetRatio: 0.55,
    });
  });

  test("returns frontend-compatible model discovery metadata", async () => {
    const settingsDir = path.join(tmpdir(), `biomed-${randomId()}-settings`);
    const fetcher = async (): Promise<Response> => new Response(
      JSON.stringify({ data: [{ id: "custom-128k-chat" }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const service = await ModelSettingsService.create({
      settingsDir,
      environment: {},
      fetcher,
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    const baseUrl = await serve(service);

    const response = await fetch(`${baseUrl}/api/v1/models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preview_base_url: "https://models.example/v1" }),
    });
    const body = await response.json() as { models: Array<Record<string, unknown>> };

    expect(body.models).toEqual([expect.objectContaining({
      id: "custom-128k-chat",
      context_window: 131072,
      max_output_tokens: 4096,
      suggested_max_tokens: 4096,
      capability_source: "api",
      api_available: true,
    })]);
  });

  test("VLM fallback does not leak a non-DashScope active provider key", async () => {
    const settingsDir = path.join(tmpdir(), `biomed-${randomId()}-settings`);
    const service = await ModelSettingsService.create({ settingsDir, environment: {} });
    const baseUrl = await serve(service);
    const providerResponse = await fetch(`${baseUrl}/api/v1/model-registry/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Custom Text Provider",
        base_url: "https://models.example/v1",
        api_key: "sk-custom-provider",
      }),
    });
    const provider = await providerResponse.json() as Record<string, unknown>;
    const modelResponse = await fetch(`${baseUrl}/api/v1/model-registry/models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider_id: provider.id,
        model_id: "custom-chat",
      }),
    });
    const model = await modelResponse.json() as Record<string, unknown>;
    await fetch(`${baseUrl}/api/v1/model-registry/models/${String(model.id)}/activate`, {
      method: "POST",
    });
    expect(await service.resolveVlmConfig()).toEqual({
      apiKey: "",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen-vl-max",
    });
  });

  test("preserves a masked key and clears it only on an explicit empty value", async () => {
    const settingsDir = path.join(tmpdir(), `biomed-${randomId()}-settings`);
    const service = await ModelSettingsService.create({
      settingsDir,
      environment: { PI_API_KEY: "sk-direct-secret" },
    });
    const baseUrl = await serve(service);
    const current = await (await fetch(`${baseUrl}/api/v1/settings`)).json() as Record<string, unknown>;

    await fetch(`${baseUrl}/api/v1/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: current.api_key, temperature: 0.4 }),
    });
    expect((await service.resolveActiveModel()).apiKey).toBe("sk-direct-secret");

    await fetch(`${baseUrl}/api/v1/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: "" }),
    });
    await expect(service.resolveActiveModel()).rejects.toThrow("credentials");
  });

  test("imports the legacy SQLite registry once", async () => {
    const settingsDir = path.join(tmpdir(), `biomed-${randomId()}-settings`);
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
        'Legacy model', '', 32000, 2048, 2048, '{"text":true}',
        '{"temperature":0.15}', '[]', 'manual', 1, '2026-01-01', '2026-01-01');
    `);
    database.close();

    const first = await ModelSettingsService.create({ settingsDir, legacyRegistryPath: databasePath });
    expect(await first.resolveActiveModel()).toMatchObject({
      provider: "openai",
      modelId: "legacy-model",
      apiKey: "legacy-secret",
      temperature: 0.15,
      topP: 1,
      repetitionPenalty: 1,
      enableSearch: false,
      thinkingMode: false,
    });
    const second = await ModelSettingsService.create({ settingsDir, legacyRegistryPath: databasePath });
    const baseUrl = await serve(second);
    const providers = await (await fetch(`${baseUrl}/api/v1/model-registry/providers`)).json() as unknown[];
    expect(providers).toHaveLength(1);
  });
  test("bootstraps a DashScope provider from DASHSCOPE_API_KEY when no providers exist", async () => {
    const settingsDir = path.join(tmpdir(), `biomed-${randomId()}-settings`);
    const service = await ModelSettingsService.create({
      settingsDir,
      environment: { DASHSCOPE_API_KEY: "sk-dashscope-env" },
    });
    const baseUrl = await serve(service);

    const providers = await (await fetch(`${baseUrl}/api/v1/model-registry/providers`))
      .json() as Array<Record<string, unknown>>;
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      id: ENV_BOOTSTRAP_PROVIDER_ID,
      preset_id: "dashscope",
      api_key_configured: true,
    });

    const models = await (await fetch(`${baseUrl}/api/v1/model-registry/models`))
      .json() as Array<Record<string, unknown>>;
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ model_id: "qwen3.7-plus", active: true });

    const settings = await (await fetch(`${baseUrl}/api/v1/settings`)).json() as Record<string, unknown>;
    expect(settings.model_name).toBe("qwen3.7-plus");
    expect(settings.api_key_configured).toBe(true);
    await expect(service.resolveActiveModel()).resolves.toMatchObject({
      provider: "dashscope",
      modelId: "qwen3.7-plus",
      apiKey: "sk-dashscope-env",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    });
  });

  test("env bootstrap is idempotent and never overrides existing providers", async () => {
    const env = { DASHSCOPE_API_KEY: "sk-dashscope-env" };
    const settingsDir = path.join(tmpdir(), `biomed-${randomId()}-settings`);
    await ModelSettingsService.create({ settingsDir, environment: env });
    const second = await ModelSettingsService.create({ settingsDir, environment: env });
    const baseUrl = await serve(second);
    const providers = await (await fetch(`${baseUrl}/api/v1/model-registry/providers`)).json() as unknown[];
    expect(providers).toHaveLength(1);

    const customDir = path.join(tmpdir(), `biomed-${randomId()}-settings`);
    const first = await ModelSettingsService.create({ settingsDir: customDir, environment: {} });
    const firstBase = await serve(first);
    await fetch(`${firstBase}/api/v1/model-registry/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Custom",
        base_url: "https://models.example/v1",
        api_key: "sk-custom",
      }),
    });
    const restarted = await ModelSettingsService.create({ settingsDir: customDir, environment: env });
    const restartedBase = await serve(restarted);
    const customProviders = await (await fetch(`${restartedBase}/api/v1/model-registry/providers`))
      .json() as Array<Record<string, unknown>>;
    expect(customProviders).toHaveLength(1);
    expect(customProviders[0]).toMatchObject({ name: "Custom" });
  });

  test("falls back to qwen3.7-plus as the default model name", async () => {
    const settingsDir = path.join(tmpdir(), `biomed-${randomId()}-settings`);
    const service = await ModelSettingsService.create({ settingsDir, environment: {} });
    const baseUrl = await serve(service);
    const settings = await (await fetch(`${baseUrl}/api/v1/settings`)).json() as Record<string, unknown>;
    expect(settings.model_name).toBe("qwen3.7-plus");
  });
});

function randomId(): string {
  return Math.random().toString(36).slice(2);
}
