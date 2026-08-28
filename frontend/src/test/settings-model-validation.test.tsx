import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import { ModelDetailDialog } from "@/components/settings/model/ModelDetailDialog";
import { ModelImportSheet } from "@/components/settings/model/ModelImportSheet";
import type {
  ManagedModelInfo,
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
