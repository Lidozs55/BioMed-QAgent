import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    fetchSkills: vi.fn().mockResolvedValue([]),
    fetchSkill: vi.fn(),
    setSkillEnabled: vi.fn().mockResolvedValue(undefined),
    rollbackSkill: vi.fn().mockResolvedValue(undefined),
    deleteSkill: vi.fn().mockResolvedValue(undefined),
    validateSkill: vi.fn(),
    uploadSkill: vi.fn().mockResolvedValue(undefined),
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

    expect(await screen.findByText("DeepSeek")).toBeInTheDocument();
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
    const api = mockApi({
      fetchProviders: vi.fn().mockResolvedValue([]),
      fetchManagedModels: vi.fn().mockResolvedValue([]),
    });
    renderSettings(api);

    fireEvent.click(await screen.findByRole("button", { name: "添加供应商" }));
    fireEvent.click(screen.getByRole("button", { name: "DeepSeek" }));

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

    fireEvent.click(await screen.findByRole("button", { name: "添加模型" }));

    // Provider is auto-selected and the list is discovered automatically.
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

    fireEvent.click(await screen.findByRole("button", { name: "添加模型" }));
    const manualInput = await screen.findByLabelText("手动模型名称");
    fireEvent.change(manualInput, { target: { value: "custom-model" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));

    await waitFor(() => expect(api.createManagedModel).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.createManagedModel).mock.calls[0]?.[0]).toMatchObject({
      provider_id: "provider-1",
      model_id: "custom-model",
      source: "manual",
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
      expect(screen.getAllByText("deepseek-reasoner").length).toBeGreaterThan(0);
    });
  });

  it("saves advanced generation parameters", async () => {
    const api = mockApi();
    renderSettings(api);

    const outputTokens = await screen.findByLabelText("最大输出 Tokens");
    fireEvent.change(outputTokens, { target: { value: "16384" } });
    fireEvent.click(screen.getByRole("button", { name: "保存模型设置" }));

    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.saveSettings).mock.calls[0]?.[0]).toMatchObject({
      max_tokens: 16384,
    });
  });
});
