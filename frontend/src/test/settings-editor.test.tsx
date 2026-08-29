import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { SettingsPanel } from "@/components/SettingsPanel";
import type { SettingsAPIClient } from "@/hooks/useAPI";
import { usePreferencesStore } from "@/stores/preferencesStore";
import { useThemeStore } from "@/stores/themeStore";

const SAVED_SETTINGS = {
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
    fetchSettings: vi.fn().mockResolvedValue(SAVED_SETTINGS),
    saveSettings: vi.fn().mockResolvedValue(SAVED_SETTINGS),
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

describe("settings editor section", () => {
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

  afterEach(() => {
    usePreferencesStore.setState({
      showContextUsage: true,
      sendShortcut: "enter",
      followUpMode: "queue",
      translucentSidebar: false,
      contrast: 50,
      pointerCursor: true,
      reducedMotion: "system",
      uiFontSize: 16,
      lightColors: { background: "", foreground: "" },
      darkColors: { background: "", foreground: "" },
    });
    useThemeStore.setState({
      mode: "system",
      accent: "sky",
      font: "inter",
      customAccent: "",
      importedFonts: [],
    });
  });

  it("toggles the context usage indicator and changes the send shortcut", async () => {
    const api = mockApi();
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);
    await screen.findByText("供应商管理");

    fireEvent.click(
      within(screen.getByRole("navigation", { name: "设置分类" })).getByRole("button", {
        name: "编辑器",
      }),
    );

    expect(await screen.findByText("发送快捷键")).toBeInTheDocument();
    const usageToggle = screen.getByRole("switch", {
      name: "显示上下文窗口使用情况",
    });
    fireEvent.click(usageToggle);
    expect(usePreferencesStore.getState().showContextUsage).toBe(false);

    fireEvent.click(screen.getByRole("combobox", { name: "发送快捷键" }));
    const option = await screen.findByRole("option", { name: /Ctrl\+Enter 发送/ });
    fireEvent.pointerDown(option);
    fireEvent.click(option);
    await waitFor(() => {
      expect(usePreferencesStore.getState().sendShortcut).toBe("ctrl-enter");
    });
  });

  it("switches the follow-up handling mode", async () => {
    const api = mockApi();
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);
    await screen.findByText("供应商管理");

    fireEvent.click(
      within(screen.getByRole("navigation", { name: "设置分类" })).getByRole("button", {
        name: "编辑器",
      }),
    );

    expect(await screen.findByText("跟进处理方式")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "调整方向" }));
    expect(usePreferencesStore.getState().followUpMode).toBe("steer");
  });
});
