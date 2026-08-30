import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, test } from "vitest";

import { DEFAULT_RUNTIME_LIMITS } from "@biomed/contracts";

import { ModelSettingsService } from "../src/settings/model-settings.js";
import {
  bootstrapEnvironmentDefaults,
  defaultRegistry,
  ENV_BOOTSTRAP_PROVIDER_ID,
  type AuthState,
} from "../src/settings/model-registry/store.js";

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
      safetyReserveTokens: 3200,
      enableSearch: false,
      thinkingMode: false,
      params: { max_tokens: 3072, temperature: 0.25, top_p: 0.8 },
    });
    expect(await readFile(path.join(settingsDir, "model-registry.json"), "utf8"))
      .not.toContain("sk-secret-provider-value");
    expect(await readFile(path.join(settingsDir, "model-auth.json"), "utf8"))
      .toContain("sk-secret-provider-value");
  });

  test("allows editing the context window of an API-sourced model and syncs active settings", async () => {
    const settingsDir = path.join(tmpdir(), `biomed-${randomId()}-settings`);
    const service = await ModelSettingsService.create({ settingsDir, environment: {} });
    const baseUrl = await serve(service);

    const providerResponse = await fetch(`${baseUrl}/api/v1/model-registry/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Custom OpenAI",
        base_url: "https://models.example/v1",
        api_key: "sk-custom-window",
      }),
    });
    const provider = await providerResponse.json() as Record<string, unknown>;

    const modelResponse = await fetch(`${baseUrl}/api/v1/model-registry/models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider_id: provider.id,
        model_id: "custom-chat",
        source: "api",
        context_window: 64000,
      }),
    });
    const model = await modelResponse.json() as Record<string, unknown>;
    expect(model).toMatchObject({ context_window: 64000, source: "api", active: true });

    const updateResponse = await fetch(
      `${baseUrl}/api/v1/model-registry/models/${String(model.id)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ context_window: 131072 }),
      },
    );
    const updated = await updateResponse.json() as Record<string, unknown>;
    expect(updated).toMatchObject({ context_window: 131072, metadata_source: "user" });

    const settings = await (await fetch(`${baseUrl}/api/v1/settings`)).json() as Record<string, unknown>;
    expect(settings.context_window).toBe(131072);
    expect(await service.resolveActiveModel()).toMatchObject({ contextWindow: 131072 });
  });

  test("allows editing model modalities (capabilities) via updateModel", async () => {
    const settingsDir = path.join(tmpdir(), `biomed-${randomId()}-settings`);
    const service = await ModelSettingsService.create({ settingsDir, environment: {} });
    const provider = await service.createProvider({
      name: "Custom OpenAI",
      base_url: "https://models.example/v1",
      api_key: "sk-modality",
    });
    const model = await service.createModel({
      provider_id: provider.id,
      model_id: "custom-chat",
      source: "api",
    });
    expect(model.capabilities).toEqual({ text: true, image: false, video: false, audio: false });
    expect(model.metadata_source).toBe("api");

    // 用户勾选图像/音频模态：落盘且归一化（未勾选的 video 保持 false）。
    const updated = await service.updateModel(model.id, {
      capabilities: { text: true, image: true, audio: true },
    });
    expect(updated.capabilities).toEqual({ text: true, image: true, video: false, audio: true });
    expect(updated.metadata_source).toBe("user");

    // 不传 capabilities 时不得改动已有模态。
    const untouched = await service.updateModel(model.id, { description: "note" });
    expect(untouched.capabilities).toEqual({ text: true, image: true, video: false, audio: true });
  });

  test("accepts max_tokens values beyond the legacy spec upper bound", async () => {
    const settingsDir = path.join(tmpdir(), `biomed-${randomId()}-settings`);
    const service = await ModelSettingsService.create({ settingsDir, environment: {} });
    const provider = await service.createProvider({
      name: "Custom OpenAI",
      base_url: "https://models.example/v1",
      api_key: "sk-max-tokens",
    });
    const model = await service.createModel({
      provider_id: provider.id,
      model_id: "custom-chat",
    });

    // 旧规格上限为 262144/131072，现已取消：超大值允许保存（仅要求正整数）。
    const updated = await service.updateModel(model.id, { params: { max_tokens: 400_000 } });
    expect(updated.params.max_tokens).toBe(400_000);
  });

  test("marks metadata as user-edited when any editable field changes", async () => {
    const settingsDir = path.join(tmpdir(), `biomed-${randomId()}-settings`);
    const service = await ModelSettingsService.create({ settingsDir, environment: {} });
    const provider = await service.createProvider({
      name: "Custom OpenAI",
      base_url: "https://models.example/v1",
      api_key: "sk-user-edit",
    });
    const model = await service.createModel({
      provider_id: provider.id,
      model_id: "custom-chat",
      source: "api",
    });
    expect(model.metadata_source).toBe("api");

    // 参数被编辑即视为手动配置（不再被目录启动同步覆盖）。
    const paramsEdited = await service.updateModel(model.id, { params: { temperature: 0.1 } });
    expect(paramsEdited.metadata_source).toBe("user");

    // 名称被编辑同样标记。
    const second = await service.createModel({
      provider_id: provider.id,
      model_id: "custom-chat-2",
      source: "api",
    });
    const named = await service.updateModel(second.id, { name: "My Model" });
    expect(named.metadata_source).toBe("user");
  });

  test("syncs active-model parameter edits into runtime settings without reactivation", async () => {
    const settingsDir = path.join(tmpdir(), `biomed-${randomId()}-settings`);
    const service = await ModelSettingsService.create({ settingsDir, environment: {} });
    const provider = await service.createProvider({
      name: "Custom OpenAI",
      base_url: "https://models.example/v1",
      api_key: "sk-provider",
    });
    const model = await service.createModel({
      provider_id: provider.id,
      model_id: "custom-chat",
      context_window: 64000,
      params: { max_tokens: 3072, temperature: 0.25 },
    });
    expect((await service.resolveActiveModel()).maxTokens).toBe(3072);

    await service.updateModel(model.id, { params: { max_tokens: 2048, temperature: 0.9 } });
    expect(await service.resolveActiveModel()).toMatchObject({ maxTokens: 2048, temperature: 0.9 });
  });

  test("syncs max_output_tokens edits for the active model when params lack max_tokens", async () => {
    const settingsDir = path.join(tmpdir(), `biomed-${randomId()}-settings`);
    const service = await ModelSettingsService.create({ settingsDir, environment: {} });
    const provider = await service.createProvider({
      name: "Custom OpenAI",
      base_url: "https://models.example/v1",
      api_key: "sk-provider",
    });
    const model = await service.createModel({
      provider_id: provider.id,
      model_id: "custom-chat",
      context_window: 64000,
      max_output_tokens: 8192,
    });
    expect((await service.resolveActiveModel()).maxTokens).toBe(8192);

    await service.updateModel(model.id, { max_output_tokens: 2048 });
    expect((await service.resolveActiveModel()).maxTokens).toBe(2048);
  });

  test("does not sync parameter edits for inactive models", async () => {
    const settingsDir = path.join(tmpdir(), `biomed-${randomId()}-settings`);
    const service = await ModelSettingsService.create({ settingsDir, environment: {} });
    const provider = await service.createProvider({
      name: "Custom OpenAI",
      base_url: "https://models.example/v1",
      api_key: "sk-provider",
    });
    await service.createModel({
      provider_id: provider.id,
      model_id: "model-a",
      context_window: 64000,
      params: { max_tokens: 3072 },
    });
    const inactive = await service.createModel({
      provider_id: provider.id,
      model_id: "model-b",
      context_window: 64000,
      params: { max_tokens: 9999 },
    });

    await service.updateModel(inactive.id, { params: { max_tokens: 12345, temperature: 1.5 } });
    expect(await service.resolveActiveModel()).toMatchObject({ maxTokens: 3072, temperature: 0.7 });
  });

  test("falls back to the default max output when the activated model exposes none", async () => {
    const settingsDir = path.join(tmpdir(), `biomed-${randomId()}-settings`);
    const service = await ModelSettingsService.create({ settingsDir, environment: {} });
    const provider = await service.createProvider({
      name: "Custom OpenAI",
      base_url: "https://models.example/v1",
      api_key: "sk-provider",
    });
    await service.createModel({
      provider_id: provider.id,
      model_id: "model-a",
      context_window: 262144,
      params: { max_tokens: 32768 },
    });
    expect(service.getSettings().max_tokens).toBe(32768);

    const withoutLimit = await service.createModel({
      provider_id: provider.id,
      model_id: "model-b",
      context_window: 32000,
    });
    await service.activateModel(withoutLimit.id);
    expect(service.getSettings().max_tokens).toBe(8192);
    expect((await service.resolveActiveModel()).maxTokens).toBe(8192);
  });

  test("resets ghost connection settings when deleting the active provider", async () => {
    const settingsDir = path.join(tmpdir(), `biomed-${randomId()}-settings`);
    const service = await ModelSettingsService.create({ settingsDir, environment: {} });
    const provider = await service.createProvider({
      name: "Custom OpenAI",
      base_url: "https://models.example/v1",
      api_key: "sk-provider",
    });
    const model = await service.createModel({
      provider_id: provider.id,
      model_id: "custom-chat",
      context_window: 64000,
      params: { max_tokens: 3072 },
    });
    await service.activateModel(model.id);
    expect(service.getSettings()).toMatchObject({
      base_url: "https://models.example/v1",
      model_name: "custom-chat",
    });

    await service.deleteProvider(provider.id);
    expect(service.getSettings()).toMatchObject({
      base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model_name: "",
      context_window_source: "inferred",
      max_tokens: 8192,
      api_key_configured: false,
    });
    const stored = await storedSettings(settingsDir);
    expect(stored.provider_id).toBeNull();
    expect(stored.active_model_id).toBeNull();
  });

  test("resets ghost model settings when deleting the active model", async () => {
    const settingsDir = path.join(tmpdir(), `biomed-${randomId()}-settings`);
    const service = await ModelSettingsService.create({ settingsDir, environment: {} });
    const provider = await service.createProvider({
      name: "Custom OpenAI",
      base_url: "https://models.example/v1",
      api_key: "sk-provider",
    });
    const model = await service.createModel({
      provider_id: provider.id,
      model_id: "custom-chat",
      context_window: 64000,
      params: { max_tokens: 3072 },
    });
    await service.activateModel(model.id);
    expect(service.getSettings()).toMatchObject({ model_name: "custom-chat", max_tokens: 3072 });

    await service.deleteModel(model.id);
    expect(service.getSettings()).toMatchObject({
      base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model_name: "",
      context_window_source: "inferred",
      max_tokens: 8192,
    });
    const stored = await storedSettings(settingsDir);
    expect(stored.active_model_id).toBeNull();
  });

  test("rejects non-http(s) base_url values on settings and provider writes", async () => {
    const settingsDir = path.join(tmpdir(), `biomed-${randomId()}-settings`);
    const service = await ModelSettingsService.create({ settingsDir, environment: {} });
    const baseUrl = await serve(service);
    const put = async (payload: Record<string, unknown>): Promise<Response> =>
      fetch(`${baseUrl}/api/v1/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

    const before = service.getSettings();
    const notUrl = await put({ base_url: "not a url" });
    expect(notUrl.status).toBe(422);
    expect(String((await notUrl.json() as Record<string, unknown>).detail)).toContain("base_url");
    const ftp = await put({ base_url: "ftp://x" });
    expect(ftp.status).toBe(422);
    expect(service.getSettings()).toEqual(before);

    // localhost/IP 策略是 discover 层(publicProviderUrl)的职责;
    // 写入端只挡结构上明显不是 http(s) URL 的值。
    const loopback = await put({ base_url: "http://127.0.0.1:9999/v1" });
    expect(loopback.status).toBe(200);
    expect(service.getSettings().base_url).toBe("http://127.0.0.1:9999/v1");

    await expect(service.createProvider({
      name: "Bad Provider",
      base_url: "not a url",
      api_key: "sk-bad",
    })).rejects.toMatchObject({ status: 422 });
    await expect(service.createProvider({
      name: "Ftp Provider",
      base_url: "ftp://x",
    })).rejects.toMatchObject({ status: 422 });
    await expect(service.createProvider({
      name: "Loopback Provider",
      base_url: "http://127.0.0.1:9999/v1",
      api_key: "sk-loopback",
    })).resolves.toMatchObject({ base_url: "http://127.0.0.1:9999/v1" });

    const editable = await service.createProvider({
      name: "Editable Provider",
      base_url: "https://models.example/v1",
      api_key: "sk-editable",
    });
    await expect(service.updateProvider(editable.id, { base_url: "not a url" }))
      .rejects.toMatchObject({ status: 422 });
    expect(service.getProvider(editable.id).base_url).toBe("https://models.example/v1");
  });

  test("rejects compaction target ratios that do not stay below the trigger ratio", async () => {
    const settingsDir = path.join(tmpdir(), `biomed-${randomId()}-settings`);
    const service = await ModelSettingsService.create({ settingsDir, environment: {} });
    const baseUrl = await serve(service);
    const put = async (payload: Record<string, unknown>): Promise<Response> =>
      fetch(`${baseUrl}/api/v1/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

    const before = service.getSettings();
    const bothFields = await put({ compaction_trigger_ratio: 0.1, compaction_target_ratio: 0.9 });
    expect(bothFields.status).toBe(422);
    expect(String((await bothFields.json() as Record<string, unknown>).detail))
      .toContain("compaction_target_ratio");

    // 单独修改 target 也要对照磁盘上的 trigger 校验写入后的组合。
    const targetAlone = await put({ compaction_target_ratio: 0.9 });
    expect(targetAlone.status).toBe(422);
    expect(service.getSettings()).toEqual(before);

    const valid = await put({ compaction_trigger_ratio: 0.9, compaction_target_ratio: 0.55 });
    expect(valid.status).toBe(200);
  });

  test("rejects max_tokens that consume the reserved context window budget", async () => {
    const settingsDir = path.join(tmpdir(), `biomed-${randomId()}-settings`);
    const service = await ModelSettingsService.create({ settingsDir, environment: {} });
    const baseUrl = await serve(service);
    const put = async (payload: Record<string, unknown>): Promise<Response> =>
      fetch(`${baseUrl}/api/v1/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

    const before = service.getSettings();
    const explicitWindow = await put({ max_tokens: 200000, context_window: 100000 });
    expect(explicitWindow.status).toBe(422);
    expect(String((await explicitWindow.json() as Record<string, unknown>).detail)).toContain("max_tokens");
    expect(service.getSettings()).toEqual(before);

    // context_window 为 null 时按回退值 131072 计算。
    const inferredWindow = await put({ max_tokens: 131072 });
    expect(inferredWindow.status).toBe(422);

    const valid = await put({ max_tokens: 90000, context_window: 100000 });
    expect(valid.status).toBe(200);
  });

  test("validates model params against the provider parameter specs", async () => {
    const settingsDir = path.join(tmpdir(), `biomed-${randomId()}-settings`);
    const service = await ModelSettingsService.create({ settingsDir, environment: {} });
    const provider = await service.createProvider({
      name: "Custom OpenAI",
      base_url: "https://models.example/v1",
      api_key: "sk-provider",
    });
    const model = await service.createModel({
      provider_id: provider.id,
      model_id: "custom-chat",
      params: { temperature: 0.5 },
    });

    await expect(service.updateModel(model.id, { params: { temperature: 99 } }))
      .rejects.toMatchObject({ status: 422 });
    const stored = service.listModels().find((item) => String(item.id) === model.id);
    expect(stored).toMatchObject({ params: { temperature: 0.5 } });

    // 未知键保持现状语义放行，范围内的已知键正常更新。
    await expect(service.updateModel(model.id, { params: { custom_flag: "yes" } }))
      .resolves.toBeDefined();
    await expect(service.updateModel(model.id, { params: { temperature: 1.5 } }))
      .resolves.toBeDefined();
  });

  test("unrelated settings updates are not blocked by pre-existing invalid stored combinations", async () => {
    const settingsDir = path.join(tmpdir(), `biomed-${randomId()}-settings`);
    await mkdir(settingsDir, { recursive: true });
    await writeFile(path.join(settingsDir, "model-registry.json"), JSON.stringify({
      version: 1,
      settings: {
        provider_id: null,
        active_model_id: null,
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model_name: "qwen3.7-plus",
        max_tokens: 200000,
        context_window: 100000,
        safety_reserve_ratio: 0.05,
        compaction_trigger_ratio: 0.1,
        compaction_target_ratio: 0.9,
        advanced: {
          temperature: 0.7,
          top_p: 1,
          repetition_penalty: 1,
          enable_search: false,
          thinking_mode: false,
        },
        runtime_limits_version: 1,
      },
      providers: [],
      models: [],
    }));
    const service = await ModelSettingsService.create({ settingsDir, environment: {} });

    // 磁盘上的历史违规组合不锁死不相关字段的更新。
    await expect(service.updateSettings({ model_name: "other-model" })).resolves.toBeUndefined();
    expect(service.getSettings()).toMatchObject({ model_name: "other-model", max_tokens: 200000 });
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
      environment: { PI_API_KEY: "sk-direct-secret", PI_MODEL: "qwen3.8-flash" },
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
      context_window: null,
      max_output_tokens: null,
      suggested_max_tokens: null,
      capability_source: "api",
      api_available: true,
    })]);
  });

  test("enriches known discovery models from the local catalog", async () => {
    const settingsDir = path.join(tmpdir(), `biomed-${randomId()}-settings`);
    const fetcher = async (): Promise<Response> => new Response(
      JSON.stringify({ data: [
        { id: "qwen3.8-max" },
        { id: "deepseek-v4-pro-0813" },
      ] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const service = await ModelSettingsService.create({
      settingsDir,
      environment: {},
      fetcher,
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    const models = await service.discover(
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "",
      undefined,
      "dashscope",
    );

    expect(models).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "qwen3.8-max",
        context_window: 1000000,
        max_output_tokens: 131072,
        suggested_max_tokens: 64000,
        capability_source: "catalog",
      }),
      expect.objectContaining({
        id: "deepseek-v4-pro-0813",
        context_window: 1000000,
        max_output_tokens: 384000,
        capability_source: "catalog",
      }),
    ]));
  });

  test("refreshes persisted catalog metadata without touching user edits", async () => {
    const settingsDir = path.join(tmpdir(), `biomed-${randomId()}-settings`);
    await mkdir(settingsDir, { recursive: true });
    await writeFile(path.join(settingsDir, "model-auth.json"), JSON.stringify({
      version: 1,
      direct_api_key: "",
      provider_api_keys: { provider_sync: "sk-sync" },
    }));
    await writeFile(path.join(settingsDir, "model-registry.json"), JSON.stringify({
      version: 1,
      settings: {
        provider_id: "provider_sync",
        active_model_id: "model_sync",
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model_name: "qwen3.8-27b",
        max_tokens: 4096,
        context_window: 524288,
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
        id: "provider_sync",
        name: "DashScope Sync",
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        preset_id: "dashscope",
        description: "",
        enabled: true,
        created_at: "2026-08-24T00:00:00.000Z",
        updated_at: "2026-08-24T00:00:00.000Z",
      }],
      models: [
        {
          id: "model_sync",
          provider_id: "provider_sync",
          model_id: "qwen3.8-27b",
          name: "qwen3.8-27b",
          description: "API discovered model",
          context_window: 524288,
          max_output_tokens: 4096,
          suggested_max_tokens: 4096,
          capabilities: { text: true, image: false, video: false, audio: false },
          params: {},
          source: "api",
          active: true,
          created_at: "2026-08-24T00:00:00.000Z",
          updated_at: "2026-08-24T00:00:00.000Z",
        },
        {
          id: "model_manual",
          provider_id: "provider_sync",
          model_id: "qwen3.8-27b",
          name: "manual qwen3.8-27b",
          description: "",
          context_window: 512000,
          max_output_tokens: 4096,
          suggested_max_tokens: 4096,
          capabilities: { text: true, image: false, video: false, audio: false },
          params: {},
          source: "manual",
          active: false,
          created_at: "2026-08-24T00:00:00.000Z",
          updated_at: "2026-08-24T00:00:00.000Z",
        },
      ],
    }));

    const service = await ModelSettingsService.create({
      settingsDir,
      environment: {},
    });
    const models = service.listModels();

    expect(models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "model_sync", context_window: 1000000, metadata_source: "catalog" }),
      expect.objectContaining({ id: "model_manual", context_window: 512000, metadata_source: "user" }),
    ]));
    expect(service.getSettings()).toMatchObject({
      model_name: "qwen3.8-27b",
      context_window: 1000000,
      max_tokens: 64000,
    });
  });

  test("returns provider and model parameter specs with defaults", async () => {
    const settingsDir = path.join(tmpdir(), `biomed-${randomId()}-settings`);
    const service = await ModelSettingsService.create({ settingsDir, environment: {} });
    const baseUrl = await serve(service);
    const providerResponse = await fetch(`${baseUrl}/api/v1/model-registry/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Kimi",
        base_url: "https://api.moonshot.cn/v1",
        api_key: "sk-kimi",
        preset_id: "moonshot",
      }),
    });
    const provider = await providerResponse.json() as Record<string, unknown>;
    const specs = await (await fetch(
      `${baseUrl}/api/v1/model-registry/providers/${String(provider.id)}/param-specs`,
    )).json() as Array<Record<string, unknown>>;

    expect(specs).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "max_tokens", default: 32768 }),
      expect.objectContaining({ key: "reasoning_effort", default: "max" }),
    ]));

    const modelResponse = await fetch(`${baseUrl}/api/v1/model-registry/models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider_id: provider.id,
        model_id: "kimi-k3",
        source: "api",
      }),
    });
    const model = await modelResponse.json() as Record<string, unknown>;
    expect((model.param_specs as Array<Record<string, unknown>>))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ key: "reasoning_effort", default: "max" }),
        expect.objectContaining({ key: "tool_choice", default: "auto" }),
      ]));
  });

  test("merges the thinking toggle into reasoning_effort with an off default", async () => {
    const settingsDir = path.join(tmpdir(), `biomed-${randomId()}-settings`);
    const service = await ModelSettingsService.create({ settingsDir, environment: {} });
    const baseUrl = await serve(service);

    const createProvider = async (name: string, presetId?: string) => {
      const response = await fetch(`${baseUrl}/api/v1/model-registry/providers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          base_url: "https://models.example/v1",
          api_key: "sk-test",
          ...(presetId === undefined ? {} : { preset_id: presetId }),
        }),
      });
      return (await response.json()) as { id: string };
    };

    // DashScope profile and the generic fallback both expose the merged
    // control and no longer carry the separate enable_thinking toggle.
    const dashscope = await createProvider("DashScope Test", "dashscope");
    const fallback = await createProvider("Generic Test");
    for (const provider of [dashscope, fallback]) {
      const specs = await (await fetch(
        `${baseUrl}/api/v1/model-registry/providers/${provider.id}/param-specs`,
      )).json() as Array<Record<string, unknown>>;

      expect(specs).toEqual(expect.arrayContaining([
        expect.objectContaining({
          key: "reasoning_effort",
          default: "off",
          options: expect.arrayContaining([
            expect.objectContaining({ value: "off", label: "关闭" }),
          ]),
        }),
      ]));
      expect(specs.some((spec) => spec.key === "enable_thinking")).toBe(false);
    }
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
      environment: { PI_API_KEY: "sk-direct-secret", PI_MODEL: "qwen3.8-flash" },
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
  test("bootstraps a DashScope provider from DASHSCOPE_API_KEY without inventing a model", async () => {
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

    // Key-only bootstrap must NOT fabricate an active model: running on an
    // unchosen model silently bills the wrong account (2026-08-29 incident).
    const models = await (await fetch(`${baseUrl}/api/v1/model-registry/models`))
      .json() as unknown[];
    expect(models).toHaveLength(0);

    const settings = await (await fetch(`${baseUrl}/api/v1/settings`)).json() as Record<string, unknown>;
    expect(settings.model_name).toBe("");
    expect(settings.api_key_configured).toBe(true);
    expect(settings.run_ready).toBe(false);
    await expect(service.resolveActiveModel()).rejects.toThrow("model are required");
  });

  test("env bootstrap honors catalog context facts for known models", () => {
    const registry = defaultRegistry({});
    const auth: AuthState = { version: 1, direct_api_key: "", provider_api_keys: {} };
    // kimi-k3 in the local catalog: 1048576 window / 131072 output / 32768 suggested.
    bootstrapEnvironmentDefaults(registry, auth, {
      DASHSCOPE_API_KEY: "sk-dashscope-env",
      PI_MODEL: "kimi-k3",
    });
    expect(registry.models[0]).toMatchObject({
      model_id: "kimi-k3",
      context_window: 1_048_576,
      max_output_tokens: 131_072,
      suggested_max_tokens: 32_768,
      capabilities: { text: true, image: true, video: true, audio: false },
    });
    expect(registry.settings).toMatchObject({
      model_name: "kimi-k3",
      context_window: 1_048_576,
      max_tokens: 32_768,
    });
  });

  test("env bootstrap keeps the hardcoded fallback for models missing from the catalog", () => {
    const registry = defaultRegistry({});
    const auth: AuthState = { version: 1, direct_api_key: "", provider_api_keys: {} };
    bootstrapEnvironmentDefaults(registry, auth, {
      DASHSCOPE_API_KEY: "sk-dashscope-env",
      PI_MODEL: "totally-unknown-model",
    });
    expect(registry.models[0]).toMatchObject({
      model_id: "totally-unknown-model",
      context_window: 131_072,
      max_output_tokens: 8192,
      suggested_max_tokens: 8192,
    });
    expect(registry.settings).toMatchObject({
      context_window: 131_072,
      max_tokens: 8192,
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

  test("ships no default model name: unconfigured until the user selects one", async () => {
    const settingsDir = path.join(tmpdir(), `biomed-${randomId()}-settings`);
    const service = await ModelSettingsService.create({ settingsDir, environment: {} });
    const baseUrl = await serve(service);
    const settings = await (await fetch(`${baseUrl}/api/v1/settings`)).json() as Record<string, unknown>;
    expect(settings.model_name).toBe("");
    expect(settings.run_ready).toBe(false);
    expect(settings.run_block_reason).toBe("provider credentials are required");
  });
});

describe("model registry list pagination and search", () => {
  async function loadedRegistry(): Promise<{ service: ModelSettingsService; baseUrl: string }> {
    const settingsDir = path.join(tmpdir(), `biomed-${randomId()}-settings`);
    const service = await ModelSettingsService.create({ settingsDir, environment: {} });
    const baseUrl = await serve(service);
    const createProvider = async (name: string): Promise<string> => {
      const response = await fetch(`${baseUrl}/api/v1/model-registry/providers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          base_url: `https://${name.toLowerCase().replaceAll(" ", "-")}.example/v1`,
          api_key: `sk-${name.toLowerCase().replaceAll(" ", "-")}`,
        }),
      });
      return String((await response.json() as Record<string, unknown>).id);
    };
    const alpha = await createProvider("Alpha Labs");
    const beta = await createProvider("Beta Works");
    await fetch(`${baseUrl}/api/v1/model-registry/models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider_id: alpha, model_id: "alpha-chat" }),
    });
    await fetch(`${baseUrl}/api/v1/model-registry/models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider_id: alpha, model_id: "zeta-pro", description: "long reasoning" }),
    });
    await fetch(`${baseUrl}/api/v1/model-registry/models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider_id: beta, model_id: "beta-embed" }),
    });
    return { service, baseUrl };
  }

  test("paginates providers and models with stable totals and empty pages", async () => {
    const { baseUrl } = await loadedRegistry();
    const first = await (await fetch(`${baseUrl}/api/v1/model-registry/providers?page=1&size=2`))
      .json() as Record<string, unknown>;
    expect(Array.isArray(first.items)).toBe(true);
    expect(first.items as unknown[]).toHaveLength(2);
    expect(first.total).toBe(2);
    expect(first.page).toBe(1);
    expect(first.size).toBe(2);

    const second = await (await fetch(`${baseUrl}/api/v1/model-registry/providers?page=2&size=2`))
      .json() as Record<string, unknown>;
    expect(second.items as unknown[]).toHaveLength(0);
    expect(second.total).toBe(2);

    const empty = await (await fetch(`${baseUrl}/api/v1/model-registry/models?page=9&size=2`))
      .json() as Record<string, unknown>;
    expect(empty.items as unknown[]).toHaveLength(0);
    expect(empty.total).toBe(3);
  });

  test("filters providers and models by case-insensitive keyword", async () => {
    const { baseUrl } = await loadedRegistry();
    const providers = await (await fetch(`${baseUrl}/api/v1/model-registry/providers?q=alpha&page=1&size=10`))
      .json() as Record<string, unknown>;
    expect(providers.total).toBe(1);
    expect((providers.items as Array<Record<string, unknown>>)[0]).toMatchObject({ name: "Alpha Labs" });

    const byModelId = await (await fetch(`${baseUrl}/api/v1/model-registry/models?q=chat&page=1&size=10`))
      .json() as Record<string, unknown>;
    expect(byModelId.total).toBe(1);

    const byProviderName = await (await fetch(`${baseUrl}/api/v1/model-registry/models?q=labs&page=1&size=10`))
      .json() as Record<string, unknown>;
    expect(byProviderName.total).toBe(2);

    const byDescription = await (await fetch(`${baseUrl}/api/v1/model-registry/models?q=reasoning&page=1&size=10`))
      .json() as Record<string, unknown>;
    expect(byDescription.total).toBe(1);
  });

  test("rejects malformed pagination and search parameters", async () => {
    const { baseUrl } = await loadedRegistry();
    expect((await fetch(`${baseUrl}/api/v1/model-registry/providers?page=0`)).status).toBe(422);
    expect((await fetch(`${baseUrl}/api/v1/model-registry/models?page=1.5`)).status).toBe(422);
    expect((await fetch(`${baseUrl}/api/v1/model-registry/providers?size=abc`)).status).toBe(422);
    expect((await fetch(`${baseUrl}/api/v1/model-registry/models?size=101`)).status).toBe(422);
    expect((await fetch(`${baseUrl}/api/v1/model-registry/providers?q=a&size=0`)).status).toBe(422);
  });

  test("returns bare arrays without query params and envelopes once any param is present", async () => {
    const { baseUrl } = await loadedRegistry();
    const bare = await (await fetch(`${baseUrl}/api/v1/model-registry/providers`)).json() as unknown;
    expect(Array.isArray(bare)).toBe(true);

    const envelope = await (await fetch(`${baseUrl}/api/v1/model-registry/providers?q=`))
      .json() as Record<string, unknown>;
    expect(Array.isArray(envelope.items)).toBe(true);
    expect(envelope.total).toBe(2);
  });
});

function randomId(): string {
  return Math.random().toString(36).slice(2);
}

async function storedSettings(settingsDir: string): Promise<Record<string, unknown>> {
  const stored = JSON.parse(await readFile(path.join(settingsDir, "model-registry.json"), "utf8")) as {
    settings: Record<string, unknown>;
  };
  return stored.settings;
}
