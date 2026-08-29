import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { SettingsPanel } from "@/components/SettingsPanel";
import type { SettingsAPIClient } from "@/hooks/useAPI";

const SETTINGS = {
  base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  api_key: "sk-****",
  api_key_configured: true,
  model_name: "qwen-max",
  max_tokens: 4096,
  context_window: 32768,
  context_window_source: "catalog" as const,
  safety_reserve_ratio: 0.05,
  safety_reserve_tokens: 16384,
  compaction_trigger_ratio: 0.85,
  compaction_target_ratio: 0.6,
  available_input_tokens: 12288,
  advanced: {
    temperature: 0.7,
    top_p: 1.0,
    repetition_penalty: 1.0,
    enable_search: false,
    thinking_mode: false,
  },
};

const VENDORS = [
  {
    id: "ds",
    name: "DashScope",
    base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    description: "",
    recommended: true,
  },
];

function mockApi(overrides: Partial<SettingsAPIClient> = {}): SettingsAPIClient {
  const base: SettingsAPIClient = {
    fetchSettings: vi.fn().mockResolvedValue(SETTINGS),
    saveSettings: vi.fn().mockResolvedValue(SETTINGS),
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
    fetchVendors: vi.fn().mockResolvedValue(VENDORS),
    fetchModels: vi.fn().mockResolvedValue([]),
    fetchProviders: vi.fn().mockResolvedValue([]),
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
    fetchSkillIterationContext: vi.fn().mockResolvedValue({
      schema_version: "1.0", targets: [], history_tasks: [],
      defaults: { max_tasks: 12, max_messages_per_task: 20 }, privacy_notice: "notice",
    }),
    startSkillIteration: vi.fn(),
  };
  return { ...base, ...overrides };
}

describe("SettingsPanel current-model info", () => {
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

  it("shows current model information without editable controls", async () => {
    render(<SettingsPanel open onOpenChange={() => undefined} api={mockApi()} />);

    expect(await screen.findByText("qwen-max")).toBeInTheDocument();
    expect(screen.getByText("https://dashscope.aliyuncs.com/compatible-mode/v1")).toBeInTheDocument();
    expect(screen.getByText("32.8K")).toBeInTheDocument();
    expect(screen.getByText("4096")).toBeInTheDocument();
    expect(screen.getByText("Temperature")).toBeInTheDocument();

    // No editable controls: no context-window combobox, no number inputs, no save button.
    expect(screen.queryByRole("combobox", { name: "上下文窗口" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("最大输出 Tokens")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存模型设置" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存参数" })).not.toBeInTheDocument();
  });

  it("hides the current model panel when no model is selected", async () => {
    const api = mockApi({
      fetchSettings: vi.fn().mockResolvedValue({ ...SETTINGS, model_name: "" }),
    });
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);

    await screen.findByText("供应商管理");
    expect(screen.queryByText("当前模型")).not.toBeInTheDocument();
  });
});
