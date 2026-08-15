import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { SettingsPanel } from "@/components/SettingsPanel";
import type {
  DiscoveredModelInfo,
  ManagedModelInfo,
  ProviderInfo,
  SettingsAPIClient,
} from "@/hooks/useAPI";

const TEST_SETTINGS = {
  base_url: "https://api.deepseek.com/v1",
  api_key: "sk-****",
  api_key_configured: true,
  model_name: "deepseek-chat",
  max_tokens: 4096,
  context_window: 65536,
  context_window_source: "catalog" as const,
  safety_reserve_ratio: 0.05,
  safety_reserve_tokens: 8192,
  compaction_trigger_ratio: 0.85,
  compaction_target_ratio: 0.6,
  available_input_tokens: 49152,
  advanced: {
    temperature: 0.7,
    top_p: 1.0,
    repetition_penalty: 1.0,
    enable_search: false,
    thinking_mode: false,
  },
};

const TEST_VENDORS = [
  {
    id: "deepseek",
    name: "DeepSeek",
    base_url: "https://api.deepseek.com/v1",
    description: "",
    recommended: false,
  },
];

const TEST_PROVIDERS: ProviderInfo[] = [
  {
    id: "provider-1",
    name: "DeepSeek",
    base_url: "https://api.deepseek.com/v1",
    api_key: "sk-****",
    api_key_configured: true,
    preset_id: "deepseek",
    description: "",
    enabled: true,
    created_at: "2026-08-10T00:00:00+00:00",
    updated_at: "2026-08-10T00:00:00+00:00",
  },
];

const SPECS = [
  {
    key: "temperature",
    label: "Temperature",
    type: "number" as const,
    default: 0.7,
    min: 0,
    max: 2,
  },
  {
    key: "max_tokens",
    label: "最大输出 Tokens",
    type: "integer" as const,
    default: 8192,
    min: 1,
    max: 262144,
  },
];

const DISCOVERED: DiscoveredModelInfo[] = [
  {
    id: "deepseek-chat",
    name: "DeepSeek Chat",
    description: "",
    context_window: 65536,
    suggested_max_tokens: 8192,
    max_output_tokens: 8192,
    capabilities: { text: true, image: false, video: false, audio: false },
    recommended: false,
    param_specs: SPECS,
    capability_source: "api",
  },
];

const TEST_MODELS: ManagedModelInfo[] = [
  {
    id: "model-1",
    provider_id: "provider-1",
    provider_name: "DeepSeek",
    provider_base_url: "https://api.deepseek.com/v1",
    provider_api_key_configured: true,
    model_id: "deepseek-reasoner",
    name: "DeepSeek Reasoner",
    description: "",
    context_window: 65536,
    max_output_tokens: 8192,
    suggested_max_tokens: 8192,
    capabilities: { text: true, image: false, video: false, audio: false },
    params: { temperature: 0.5 },
    param_specs: SPECS,
    source: "api",
    active: false,
    created_at: "2026-08-10T00:00:00+00:00",
    updated_at: "2026-08-10T00:00:00+00:00",
  },
];

function mockApi(overrides: Partial<SettingsAPIClient> = {}): SettingsAPIClient {
  const base: SettingsAPIClient = {
    fetchSettings: vi.fn().mockResolvedValue(TEST_SETTINGS),
    saveSettings: vi.fn().mockResolvedValue(TEST_SETTINGS),
    fetchPersonalization: vi.fn().mockResolvedValue({
      custom_instructions: "",
      personality: "pragmatic",
      personality_label: "务实",
    }),
    savePersonalization: vi.fn().mockResolvedValue({
      custom_instructions: "",
      personality: "pragmatic",
      personality_label: "务实",
    }),
    fetchVendors: vi.fn().mockResolvedValue(TEST_VENDORS),
    fetchModels: vi.fn().mockResolvedValue([]),
    fetchProviders: vi.fn().mockResolvedValue(TEST_PROVIDERS),
    createProvider: vi.fn().mockImplementation((input) =>
      Promise.resolve({
        id: "provider-new",
        name: input.name,
        base_url: input.base_url,
        api_key: input.api_key ?? "",
        api_key_configured: Boolean(input.api_key),
        preset_id: input.preset_id ?? null,
        description: input.description ?? "",
        enabled: true,
        created_at: "2026-08-10T00:00:00+00:00",
        updated_at: "2026-08-10T00:00:00+00:00",
      }),
    ),
    updateProvider: vi.fn(),
    deleteProvider: vi.fn().mockResolvedValue(undefined),
    discoverProviderModels: vi.fn().mockResolvedValue(DISCOVERED),
    fetchProviderParamSpecs: vi.fn().mockResolvedValue(SPECS),
    fetchManagedModels: vi.fn().mockResolvedValue(TEST_MODELS),
    createManagedModel: vi.fn().mockImplementation((input) =>
      Promise.resolve({
        ...TEST_MODELS[0],
        id: "model-imported",
        provider_id: input.provider_id,
        model_id: input.model_id,
        name: input.name ?? input.model_id,
        params: input.params ?? {},
        param_specs: SPECS,
        source: input.source ?? "manual",
      }),
    ),
    updateManagedModel: vi.fn().mockImplementation((id, patch) =>
      Promise.resolve({
        ...TEST_MODELS[0],
        id,
        params: patch.params ?? TEST_MODELS[0].params,
      }),
    ),
    deleteManagedModel: vi.fn().mockResolvedValue(undefined),
    activateManagedModel: vi.fn().mockResolvedValue({
      ...TEST_SETTINGS,
      model_name: "deepseek-chat",
    }),
    fetchDatabases: vi.fn().mockResolvedValue([]),
    fetchDatabase: vi.fn(),
    setDatabaseEnabled: vi.fn().mockResolvedValue(undefined),
    createDatabase: vi.fn().mockResolvedValue(undefined),
    updateDatabase: vi.fn().mockResolvedValue(undefined),
    deleteDatabase: vi.fn().mockResolvedValue(undefined),
  };
  return { ...base, ...overrides };
}

function renderSettings(api: SettingsAPIClient = mockApi()) {
  render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);
}

describe("SettingsPanel model registry", () => {
  beforeAll(() => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  it("shows configured providers from the backend", async () => {
    const api = mockApi();
    renderSettings(api);

    expect((await screen.findAllByText("DeepSeek")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("https://api.deepseek.com/v1").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "添加供应商" })).toBeInTheDocument();
  });

  it("disables add-model until a provider exists", async () => {
    const api = mockApi({
      fetchProviders: vi.fn().mockResolvedValue([]),
      fetchManagedModels: vi.fn().mockResolvedValue([]),
    });
    renderSettings(api);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "添加模型" })).toBeDisabled();
    });
    expect(screen.getByText("添加第一个供应商后即可添加模型。")).toBeInTheDocument();
  });

  it("quick-fills a preset and creates a provider", async () => {
    let providers: ProviderInfo[] = [];
    const api = mockApi({
      fetchProviders: vi.fn().mockImplementation(async () => providers),
      fetchManagedModels: vi.fn().mockResolvedValue([]),
      createProvider: vi.fn().mockImplementation(async (input) => {
        const created: ProviderInfo = {
          id: "provider-new",
          name: input.name,
          base_url: input.base_url,
          api_key: input.api_key ?? "",
          api_key_configured: Boolean(input.api_key),
          preset_id: input.preset_id ?? null,
          description: "",
          enabled: true,
          created_at: "2026-08-10T00:00:00+00:00",
          updated_at: "2026-08-10T00:00:00+00:00",
        };
        providers = [created];
        return created;
      }),
    });
    renderSettings(api);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "添加模型" })).toBeDisabled();
    });
    fireEvent.click(await screen.findByRole("button", { name: "添加供应商" }));
    // preset 按钮来自异步 vendors fetch，必须等待（并行负载下同步查询会竞态）
    fireEvent.click(await screen.findByRole("button", { name: "DeepSeek" }));

    const baseUrl = screen.getByLabelText("Base URL") as HTMLInputElement;
    expect(baseUrl.value).toBe("https://api.deepseek.com/v1");
    fireEvent.change(screen.getByLabelText("供应商名称（代号）"), {
      target: { value: "我的 DeepSeek" },
    });
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "sk-test-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(api.createProvider).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.createProvider).mock.calls[0]?.[0]).toMatchObject({
      name: "我的 DeepSeek",
      base_url: "https://api.deepseek.com/v1",
      preset_id: "deepseek",
      api_key: "sk-test-key",
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "添加模型" })).not.toBeDisabled();
    });
  });

  it("hides the current model panel when no model is selected", async () => {
    const api = mockApi({
      fetchSettings: vi.fn().mockResolvedValue({
        ...TEST_SETTINGS,
        model_name: "",
      }),
    });
    renderSettings(api);

    await screen.findByText("供应商管理");
    expect(screen.queryByText("当前模型")).not.toBeInTheDocument();
  });

  it("hides the current model panel when only a default model name exists without credentials", async () => {
    const api = mockApi({
      fetchSettings: vi.fn().mockResolvedValue({
        ...TEST_SETTINGS,
        model_name: "qwen-plus",
        api_key: "",
        api_key_configured: false,
      }),
      fetchManagedModels: vi.fn().mockResolvedValue([]),
    });
    renderSettings(api);

    await screen.findByText("供应商管理");
    expect(screen.queryByText("当前模型")).not.toBeInTheDocument();
  });

  it("shows active model information without parameter editing controls", async () => {
    const api = mockApi({
      fetchManagedModels: vi.fn().mockResolvedValue([
        {
          ...TEST_MODELS[0],
          model_id: "deepseek-chat",
          name: "DeepSeek Chat",
          active: true,
          params: { temperature: 0.7, max_tokens: 8192 },
          param_specs: SPECS,
        },
      ]),
    });
    renderSettings(api);

    expect((await screen.findAllByText("DeepSeek Chat")).length).toBeGreaterThan(0);
    expect(screen.getByText("Temperature")).toBeInTheDocument();
    expect(screen.getByText("0.7")).toBeInTheDocument();
    expect(screen.getByText("8192")).toBeInTheDocument();
    expect(screen.queryByLabelText("Temperature")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存参数" })).not.toBeInTheDocument();
  });

  it("imports a model from the provider list and saves its parameters", async () => {
    let managed: ManagedModelInfo[] = [];
    const imported: ManagedModelInfo = {
      ...TEST_MODELS[0],
      id: "model-imported",
      model_id: "deepseek-chat",
      name: "DeepSeek Chat",
      params: { temperature: 0.7, max_tokens: 8192 },
      source: "api",
    };
    const api = mockApi({
      fetchManagedModels: vi.fn().mockImplementation(async () => managed),
    createManagedModel: vi.fn().mockImplementation(async () => {
        managed = [imported];
        return imported;
      }),
    });
    renderSettings(api);

    const addModel = await screen.findByRole("button", { name: "添加模型" });
    await waitFor(() => expect(addModel).not.toBeDisabled());
    fireEvent.click(addModel);

    // Provider is auto-selected and the list is discovered automatically.
    await screen.findByText("DeepSeek Chat");
    // API 发现且不在目录里的模型，上下文显示“未知”而不是猜测数字。
    expect(screen.getAllByText("未知").length).toBeGreaterThan(0);
    const importButton = await screen.findByRole("button", { name: "导入" });
    fireEvent.click(importButton);

    await waitFor(() => expect(api.createManagedModel).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.createManagedModel).mock.calls[0]?.[0]).toMatchObject({
      provider_id: "provider-1",
      model_id: "deepseek-chat",
      source: "api",
    });

    // The imported model now appears in the maintained list and can be saved.
    await waitFor(() => expect(api.fetchManagedModels).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "保存参数" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存参数" }));
    await waitFor(() => expect(api.updateManagedModel).toHaveBeenCalledTimes(1));
  });

  it("adds a model manually with source manual", async () => {
    const api = mockApi({
      fetchManagedModels: vi.fn().mockResolvedValue([]),
    });
    renderSettings(api);

    const addModel = await screen.findByRole("button", { name: "添加模型" });
    await waitFor(() => expect(addModel).not.toBeDisabled());
    fireEvent.click(addModel);
    await screen.findByText("DeepSeek Chat");

    // Manual add now lives behind the top-right button in the sheet header.
    const sheetDialog = await screen.findByRole("dialog", { name: "添加 / 管理模型" });
    fireEvent.click(
      within(sheetDialog).getByRole("button", { name: "添加模型" }),
    );
    const manualId = await screen.findByLabelText("模型 ID *");
    fireEvent.change(manualId, { target: { value: "custom-model" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));

    await waitFor(() => expect(api.createManagedModel).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.createManagedModel).mock.calls[0]?.[0]).toMatchObject({
      provider_id: "provider-1",
      model_id: "custom-model",
      source: "manual",
    });
  });

  it("edits model config via JSON view, restores defaults, and keeps it in sync", async () => {
    const api = mockApi({
      fetchManagedModels: vi.fn().mockResolvedValue([
        {
          ...TEST_MODELS[0],
          model_id: "deepseek-chat",
          name: "DeepSeek Chat",
          params: { temperature: 0.7, max_tokens: 8192 },
          param_specs: SPECS,
        },
      ]),
    });
    renderSettings(api);

    const addModel = await screen.findByRole("button", { name: "添加模型" });
    await waitFor(() => expect(addModel).not.toBeDisabled());
    fireEvent.click(addModel);
    await screen.findAllByText("DeepSeek Chat");

    // Select the model in the right column (left list + right row both match).
    const modelRows = await screen.findAllByRole("button", { name: /DeepSeek Chat/ });
    fireEvent.click(modelRows[1]);

    // The detail toggle in the header collapses and re-opens the detail area.
    fireEvent.click(screen.getByRole("button", { name: "收起详情" }));
    expect(screen.queryByRole("button", { name: "配置 JSON" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "详情" }));

    fireEvent.click(screen.getByRole("button", { name: "配置 JSON" }));

    const jsonArea = screen.getByRole("textbox", {
      name: "配置 JSON",
    }) as HTMLTextAreaElement;
    expect(jsonArea.value).toContain('"temperature"');

    fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));
    expect(jsonArea.value).toContain('"temperature": 0.7');

    fireEvent.change(jsonArea, {
      target: { value: '{\n  "temperature": 0.9\n}' },
    });
    fireEvent.click(screen.getByRole("button", { name: "格式化" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(screen.getByLabelText("Temperature")).toHaveValue(0.9);
    fireEvent.click(screen.getByRole("button", { name: "保存参数" }));
    await waitFor(() => expect(api.updateManagedModel).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.updateManagedModel).mock.calls[0]?.[1]).toMatchObject({
      params: { temperature: 0.9 },
    });
  });

  it("activates a maintained model and updates the current model panel", async () => {
    const api = mockApi({
      fetchManagedModels: vi
        .fn()
        .mockResolvedValueOnce(TEST_MODELS)
        .mockResolvedValue([{ ...TEST_MODELS[0], active: true }]),
      activateManagedModel: vi.fn().mockResolvedValue({
        ...TEST_SETTINGS,
        model_name: "deepseek-reasoner",
      }),
    });
    renderSettings(api);

    const activate = await screen.findByRole("button", { name: "设为当前" });
    fireEvent.click(activate);

    await waitFor(() => expect(api.activateManagedModel).toHaveBeenCalledWith("model-1"));
    await waitFor(() => {
      expect(screen.getAllByText(/deepseek-reasoner/).length).toBeGreaterThan(0);
    });
  });

  it("edits a maintained model inline without opening the add-model dialog", async () => {
    const api = mockApi();
    renderSettings(api);

    const modelRow = (await screen.findByText("DeepSeek Reasoner")).closest("li");
    expect(modelRow).not.toBeNull();
    fireEvent.click(within(modelRow as HTMLElement).getByRole("button", { name: "编辑" }));
    expect(screen.getByRole("button", { name: "保存参数" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "配置 JSON" })).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "添加 / 管理模型" }),
    ).not.toBeInTheDocument();
    // 来源标签显示供应商名称，而不是 “API 导入”。
    expect(screen.queryByText("API 导入")).not.toBeInTheDocument();
    expect(screen.getAllByText("DeepSeek").length).toBeGreaterThan(0);
  });

  it("shows a manual-config badge for manually added models", async () => {
    const api = mockApi({
      fetchManagedModels: vi
        .fn()
        .mockResolvedValue([{ ...TEST_MODELS[0], source: "manual" }]),
    });
    renderSettings(api);
    expect(await screen.findByText("手动配置")).toBeInTheDocument();
  });

  it("imports selected models via the checkbox in the provider list", async () => {
    let managed: ManagedModelInfo[] = [];
    const api = mockApi({
      fetchManagedModels: vi.fn().mockImplementation(async () => managed),
      createManagedModel: vi.fn().mockImplementation(async (input) => {
        const created: ManagedModelInfo = {
          ...TEST_MODELS[0],
          id: "model-batch",
          provider_id: input.provider_id,
          model_id: input.model_id,
          name: input.name ?? input.model_id,
          source: "api",
        };
        managed = [created];
        return created;
      }),
    });
    renderSettings(api);

    const addModel = await screen.findByRole("button", { name: "添加模型" });
    await waitFor(() => expect(addModel).not.toBeDisabled());
    fireEvent.click(addModel);

    await screen.findByText("DeepSeek Chat");
    // 行级复选框默认隐藏，勾选“复选”后才显示。
    expect(
      screen.queryByRole("checkbox", { name: "选择 DeepSeek Chat" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "复选" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 DeepSeek Chat" }));
    fireEvent.click(screen.getByRole("button", { name: "导入所选 (1)" }));

    await waitFor(() => expect(api.createManagedModel).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.createManagedModel).mock.calls[0]?.[0]).toMatchObject({
      provider_id: "provider-1",
      model_id: "deepseek-chat",
      source: "api",
    });
  });

});
