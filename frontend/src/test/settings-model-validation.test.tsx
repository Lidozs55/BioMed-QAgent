import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import { ModelDetailDialog } from "@/components/settings/model/ModelDetailDialog";
import { ModelImportSheet } from "@/components/settings/model/ModelImportSheet";
import { VisionModelSelector } from "@/components/settings/model/VisionModelSelector";
import type {
  ManagedModelInfo,
  ModelSettings,
  ParameterSpec,
  ProviderInfo,
  SettingsAPIClient,
} from "@/hooks/useAPI";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
  Toaster: () => null,
}));

const TEMPERATURE_SPEC: ParameterSpec = {
  key: "temperature",
  label: "Temperature",
  type: "number",
  min: 0,
  max: 2,
  default: 0.7,
};

function makeModel(overrides: Partial<ManagedModelInfo> = {}): ManagedModelInfo {
  return {
    id: "m1",
    provider_id: "p1",
    provider_name: "DashScope",
    provider_base_url: "https://example.com/v1",
    provider_api_key_configured: true,
    model_id: "qwen-max",
    name: "Qwen Max",
    description: "",
    context_window: 32768,
    max_output_tokens: 4096,
    suggested_max_tokens: null,
    capabilities: { text: true, image: false, video: false, audio: false },
    params: {},
    param_specs: [],
    source: "api",
    active: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const PROVIDER: ProviderInfo = {
  id: "p1",
  name: "DashScope",
  base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  api_key: "sk-****",
  api_key_configured: true,
  preset_id: null,
  description: "",
  enabled: true,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function mockApi(overrides: Partial<SettingsAPIClient> = {}): SettingsAPIClient {
  const base: SettingsAPIClient = {
    fetchSettings: vi.fn(),
    saveSettings: vi.fn(),
    fetchPersonalization: vi.fn(),
    savePersonalization: vi.fn(),
    fetchSkillIterationContext: vi.fn(),
    startSkillIteration: vi.fn(),
    fetchVendors: vi.fn().mockResolvedValue([]),
    fetchModels: vi.fn(),
    fetchProviders: vi.fn().mockResolvedValue([PROVIDER]),
    createProvider: vi.fn(),
    updateProvider: vi.fn(),
    deleteProvider: vi.fn(),
    discoverProviderModels: vi.fn().mockResolvedValue([]),
    fetchProviderParamSpecs: vi.fn().mockResolvedValue([]),
    fetchManagedModels: vi.fn().mockResolvedValue([]),
    fetchProvidersPage: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, size: 20 }),
    fetchManagedModelsPage: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, size: 20 }),
    createManagedModel: vi.fn(),
    updateManagedModel: vi.fn(),
    deleteManagedModel: vi.fn(),
    activateManagedModel: vi.fn(),
    fetchDatabases: vi.fn().mockResolvedValue([]),
    fetchDatabase: vi.fn(),
    setDatabaseEnabled: vi.fn().mockResolvedValue(undefined),
    createDatabase: vi.fn(),
    updateDatabase: vi.fn(),
    deleteDatabase: vi.fn(),
    fetchAgentPermissions: vi.fn().mockResolvedValue({ schema_version: 1, preset: "ask_when_needed", rules: [], persistent_exec_allow: false }),
    fetchAgentTempGrants: vi.fn().mockResolvedValue([]),
    revokeAgentTempGrant: vi.fn().mockResolvedValue(undefined),
        fetchHilApproval: vi.fn().mockResolvedValue({ schema_version: "1.0", default_mode: "human_review", review_modes: {} }),
    saveHilApproval: vi.fn(),
    setAgentPermissionsPreset: vi.fn(),
    setAgentPermissionsPersistentExec: vi.fn(),
    addAgentPermissionRule: vi.fn(),
    removeAgentPermissionRule: vi.fn(),
    fetchCacheDatasets: vi.fn().mockResolvedValue({ items: [] }),
    deleteCacheDataset: vi.fn().mockResolvedValue(undefined),
    clearCacheDatasets: vi.fn().mockResolvedValue(0),
  };
  return { ...base, ...overrides };
}

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

describe("ModelDetailDialog max-tokens baseline", () => {
  it("does not resubmit max_output_tokens when nothing changed and params.max_tokens differs", async () => {
    // 初始不一致场景：params.max_tokens（运行时优先）与 max_output_tokens 不同。
    const model = makeModel({
      params: { max_tokens: 8192 },
      max_output_tokens: 4096,
    });
    const updateManagedModel = vi.fn().mockResolvedValue(model);
    const api = mockApi({ updateManagedModel });

    render(
      <ModelDetailDialog
        open
        onOpenChange={() => undefined}
        model={model}
        api={api}
        onSaved={() => undefined}
      />,
    );

    // 输入框以 params.max_tokens 为基准初始化。
    expect(screen.getByLabelText("最大输出 Tokens")).toHaveValue(8192);

    fireEvent.click(screen.getByRole("button", { name: "保存参数" }));
    await waitFor(() => {
      expect(updateManagedModel).toHaveBeenCalledTimes(1);
    });

    const patch = updateManagedModel.mock.calls[0][1];
    // 未实际改动：PUT 请求体不应把 max_output_tokens 改成别的值。
    expect(patch.max_output_tokens).toBeUndefined();
    expect(patch.params).toEqual({ max_tokens: 8192 });
  });

  it("submits max_output_tokens when the user actually changes the input", async () => {
    const model = makeModel({
      params: { max_tokens: 8192 },
      max_output_tokens: 4096,
    });
    const updateManagedModel = vi.fn().mockResolvedValue(model);
    const api = mockApi({ updateManagedModel });

    render(
      <ModelDetailDialog
        open
        onOpenChange={() => undefined}
        model={model}
        api={api}
        onSaved={() => undefined}
      />,
    );

    fireEvent.change(screen.getByLabelText("最大输出 Tokens"), {
      target: { value: "2048" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存参数" }));
    await waitFor(() => {
      expect(updateManagedModel).toHaveBeenCalledTimes(1);
    });

    const patch = updateManagedModel.mock.calls[0][1];
    expect(patch.max_output_tokens).toBe(2048);
    expect(patch.params).toEqual({ max_tokens: 2048 });
  });
});

describe("ModelDetailDialog modality editing", () => {
  it("submits capabilities when the user toggles a modality", async () => {
    const model = makeModel({
      capabilities: { text: true, image: false, video: false, audio: false },
    });
    const updateManagedModel = vi.fn().mockResolvedValue(model);
    const api = mockApi({ updateManagedModel });

    render(
      <ModelDetailDialog
        open
        onOpenChange={() => undefined}
        model={model}
        api={api}
        onSaved={() => undefined}
      />,
    );

    fireEvent.click(screen.getByLabelText("模态：图像"));
    fireEvent.click(screen.getByRole("button", { name: "保存参数" }));
    await waitFor(() => {
      expect(updateManagedModel).toHaveBeenCalledTimes(1);
    });

    expect(updateManagedModel.mock.calls[0][1].capabilities).toEqual({
      text: true,
      image: true,
      video: false,
      audio: false,
    });
  });

  it("does not resubmit capabilities when nothing changed", async () => {
    const model = makeModel({});
    const updateManagedModel = vi.fn().mockResolvedValue(model);
    const api = mockApi({ updateManagedModel });

    render(
      <ModelDetailDialog
        open
        onOpenChange={() => undefined}
        model={model}
        api={api}
        onSaved={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "保存参数" }));
    await waitFor(() => {
      expect(updateManagedModel).toHaveBeenCalledTimes(1);
    });

    expect(updateManagedModel.mock.calls[0][1].capabilities).toBeUndefined();
  });
});

describe("ModelImportSheet manual context window", () => {
  function renderSheet(api: SettingsAPIClient) {
    return render(
      <ModelImportSheet
        open
        onOpenChange={() => undefined}
        api={api}
        providers={[PROVIDER]}
        managedModels={[]}
        onSaved={() => undefined}
        initialProviderId="p1"
      />,
    );
  }

  async function openManualDialog() {
    fireEvent.click(await screen.findByRole("button", { name: "添加模型" }));
    await screen.findByText("手动添加模型");
    fireEvent.change(screen.getByLabelText("模型 ID *"), {
      target: { value: "test-model" },
    });
  }

  it("rejects an invalid context window with an error and no POST", async () => {
    const createManagedModel = vi.fn();
    const api = mockApi({ createManagedModel });

    renderSheet(api);
    await openManualDialog();

    fireEvent.change(screen.getByLabelText(/上下文窗口/), {
      target: { value: "-5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/正整数/);
    expect(createManagedModel).not.toHaveBeenCalled();
  });

  it("still creates the model when the context window is valid", async () => {
    const created = makeModel({ id: "m2", source: "manual" });
    const createManagedModel = vi.fn().mockResolvedValue(created);
    const api = mockApi({ createManagedModel });

    renderSheet(api);
    await openManualDialog();

    fireEvent.change(screen.getByLabelText(/上下文窗口/), {
      target: { value: "131072" },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));

    await waitFor(() => {
      expect(createManagedModel).toHaveBeenCalledTimes(1);
    });
    expect(createManagedModel.mock.calls[0][0].context_window).toBe(131072);
  });
});

describe("ParameterEditor range enforcement", () => {
  function renderDialog(model: ManagedModelInfo, api: SettingsAPIClient) {
    return render(
      <ModelDetailDialog
        open
        onOpenChange={() => undefined}
        model={model}
        api={api}
        onSaved={() => undefined}
      />,
    );
  }

  it("blocks save when a parameter value is outside the spec range", async () => {
    const model = makeModel({
      params: { temperature: 0.7 },
      param_specs: [TEMPERATURE_SPEC],
    });
    const updateManagedModel = vi.fn().mockResolvedValue(model);
    const api = mockApi({ updateManagedModel });

    renderDialog(model, api);

    fireEvent.change(screen.getByLabelText("Temperature"), {
      target: { value: "5" },
    });
    // 越界时显示错误提示。
    expect(await screen.findByRole("alert")).toHaveTextContent(/Temperature/);

    fireEvent.click(screen.getByRole("button", { name: "保存参数" }));
    // 保存被阻止：不发出 PUT，并显示越界错误。
    expect(updateManagedModel).not.toHaveBeenCalled();
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      expect.stringContaining("Temperature"),
    );
  });

  it("saves when the parameter value is back within the spec range", async () => {
    const model = makeModel({
      params: { temperature: 0.7 },
      param_specs: [TEMPERATURE_SPEC],
    });
    const updateManagedModel = vi.fn().mockResolvedValue(model);
    const api = mockApi({ updateManagedModel });

    renderDialog(model, api);

    fireEvent.change(screen.getByLabelText("Temperature"), {
      target: { value: "1.5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存参数" }));
    await waitFor(() => {
      expect(updateManagedModel).toHaveBeenCalledTimes(1);
    });
    expect(updateManagedModel.mock.calls[0][1].params).toMatchObject({
      temperature: 1.5,
    });
  });
});

describe("VisionModelSelector", () => {
  const SETTINGS: ModelSettings = {
    base_url: "https://api.deepseek.com/v1",
    api_key: "sk-****",
    api_key_configured: true,
    model_name: "deepseek-chat",
    max_tokens: 4096,
    context_window: 65536,
    context_window_source: "catalog",
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
    run_block_reason: null,
    runtime_limits: {
      command_timeout_seconds: 600,
      command_output_kib: 256,
      workspace_read_kib: 256,
      workspace_write_kib: 1024,
      workspace_search_file_mib: 16,
      workspace_search_max_files: 2000,
      http_timeout_seconds: 300,
      download_timeout_seconds: 3600,
      browser_timeout_seconds: 300,
      dataset_operation_timeout_seconds: 3600,
      database_timeout_seconds: 600,
      max_download_mib: 8192,
      gdc_max_files: 50,
      request_interval_ms: 500,
    },
    vision_model_id: null,
    vision_model_name: null,
    vision_provider_name: null,
    vision_model_ready: false,
    vision_block_reason: null,
  };

  const VISUAL_OK = makeModel({
    id: "vl-ready",
    model_id: "qwen3.5-vl-plus",
    name: "Qwen VL Plus",
    capabilities: { text: true, image: true, video: false, audio: false },
  });
  const VISUAL_NO_KEY = makeModel({
    id: "vl-nokey",
    provider_id: "p2",
    provider_name: "Keyless",
    provider_api_key_configured: false,
    model_id: "vl-nokey-model",
    name: "VL No Key",
    capabilities: { text: true, image: true, video: false, audio: false },
  });
  const TEXT_ONLY = makeModel({ id: "text-only", model_id: "deepseek-chat", name: "DeepSeek Chat" });
  const DISABLED_PROVIDER_VISUAL = makeModel({
    id: "vl-disabled",
    provider_id: "p-off",
    provider_name: "Disabled Co",
    model_id: "vl-off",
    name: "VL Disabled",
    capabilities: { text: true, image: true, video: false, audio: false },
  });
  const PROVIDERS: ProviderInfo[] = [
    PROVIDER,
    { ...PROVIDER, id: "p2", name: "Keyless", api_key_configured: false, api_key: "" },
    { ...PROVIDER, id: "p-off", name: "Disabled Co", enabled: false },
  ];

  function renderSelector(
    api: SettingsAPIClient,
    settings: ModelSettings = SETTINGS,
  ) {
    return render(
      <VisionModelSelector
        api={api}
        settings={settings}
        managedModels={[VISUAL_OK, VISUAL_NO_KEY, TEXT_ONLY, DISABLED_PROVIDER_VISUAL]}
        providers={PROVIDERS}
        onSaved={() => undefined}
      />,
    );
  }

  async function openOptions() {
    fireEvent.click(screen.getByRole("combobox", { name: "视觉抽取模型" }));
    return await screen.findAllByRole("option");
  }

  it("lists only image-capable models from enabled providers with credential readiness", async () => {
    renderSelector(mockApi());
    const options = await openOptions();
    const labels = options.map((option) => option.textContent ?? "");

    expect(labels.some((label) => label.includes("Qwen VL Plus"))).toBe(true);
    expect(labels.some((label) => label.includes("VL No Key"))).toBe(true);
    expect(labels.some((label) => label.includes("DeepSeek Chat"))).toBe(false);
    expect(labels.some((label) => label.includes("VL Disabled"))).toBe(false);
    // Credential readiness is surfaced per option.
    expect(labels.find((label) => label.includes("Qwen VL Plus"))).toContain("密钥已配置");
    expect(labels.find((label) => label.includes("VL No Key"))).toContain("未配置密钥");
  });

  it("shows the selected model's display name in the closed trigger", () => {
    renderSelector(
      mockApi(),
      { ...SETTINGS, vision_model_id: "vl-ready" },
    );
    const trigger = screen.getByRole("combobox", { name: "视觉抽取模型" });
    expect(trigger).toHaveTextContent("Qwen VL Plus");
    expect(trigger).not.toHaveTextContent("vl-ready");
  });

  it("saves only the visual role when a model is chosen", async () => {
    const saveSettings = vi.fn().mockResolvedValue({
      ...SETTINGS,
      vision_model_id: "vl-ready",
      vision_model_name: "Qwen VL Plus",
      vision_provider_name: "DashScope",
      vision_model_ready: true,
      vision_block_reason: null,
    });
    const view = renderSelector(mockApi({ saveSettings }));

    const options = await openOptions();
    const ready = options.find((option) => (option.textContent ?? "").includes("Qwen VL Plus"));
    expect(ready).toBeDefined();
    fireEvent.pointerDown(ready as HTMLElement);
    fireEvent.click(ready as HTMLElement);

    await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(1));
    expect(saveSettings.mock.calls[0][0]).toEqual({ vision_model_id: "vl-ready" });

    // The parent applies the saved settings; readiness becomes visible.
    view.rerender(
      <VisionModelSelector
        api={mockApi({ saveSettings })}
        settings={{
          ...SETTINGS,
          vision_model_id: "vl-ready",
          vision_model_name: "Qwen VL Plus",
          vision_provider_name: "DashScope",
          vision_model_ready: true,
          vision_block_reason: null,
        }}
        managedModels={[VISUAL_OK, VISUAL_NO_KEY, TEXT_ONLY, DISABLED_PROVIDER_VISUAL]}
        providers={PROVIDERS}
        onSaved={() => undefined}
      />,
    );
    expect(screen.getByText(/视觉抽取就绪/)).toBeInTheDocument();
  });

  it("clears the assignment by saving null", async () => {
    const saveSettings = vi.fn().mockResolvedValue({ ...SETTINGS, vision_model_id: null });
    renderSelector(
      mockApi({ saveSettings }),
      { ...SETTINGS, vision_model_id: "vl-ready", vision_model_name: "Qwen VL Plus", vision_provider_name: "DashScope", vision_model_ready: true, vision_block_reason: null },
    );

    const options = await openOptions();
    const none = options.find((option) => (option.textContent ?? "").includes("未选择"));
    expect(none).toBeDefined();
    fireEvent.pointerDown(none as HTMLElement);
    fireEvent.click(none as HTMLElement);

    await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(1));
    expect(saveSettings.mock.calls[0][0]).toEqual({ vision_model_id: null });
  });

  it("surfaces the server-side blocker and explains the extraction path", () => {
    renderSelector(
      mockApi(),
      { ...SETTINGS, vision_block_reason: "供应商「Keyless」尚未配置 API Key，视觉抽取不可用。" },
    );
    expect(screen.getByText(/尚未配置 API Key/)).toBeInTheDocument();
    // Uploaded images go through the extraction tool, not the main chat model.
    expect(screen.getByText(/视觉抽取工具处理/)).toBeInTheDocument();
  });
});
