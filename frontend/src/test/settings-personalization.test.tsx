import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { SettingsPanel } from "@/components/SettingsPanel";
import type {
  PersonalizationSettings,
  SettingsAPIClient,
} from "@/hooks/useAPI";
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

const DEFAULT_PERSONALIZATION: PersonalizationSettings = {
  custom_instructions: "",
  personality: "pragmatic",
  personality_label: "务实",
};

function mockApi(overrides: Partial<SettingsAPIClient> = {}): SettingsAPIClient {
  const base: SettingsAPIClient = {
    fetchSettings: vi.fn().mockResolvedValue(SAVED_SETTINGS),
    saveSettings: vi.fn().mockResolvedValue(SAVED_SETTINGS),
    fetchPersonalization: vi.fn().mockResolvedValue(DEFAULT_PERSONALIZATION),
    savePersonalization: vi.fn().mockResolvedValue(DEFAULT_PERSONALIZATION),
    fetchVendors: vi.fn().mockResolvedValue(VENDORS),
    fetchModels: vi.fn().mockResolvedValue([]),
    fetchProviders: vi.fn().mockResolvedValue([]),
    createProvider: vi.fn(),
    updateProvider: vi.fn(),
    deleteProvider: vi.fn(),
    discoverProviderModels: vi.fn().mockResolvedValue([]),
    fetchProviderParamSpecs: vi.fn().mockResolvedValue([]),
    fetchManagedModels: vi.fn().mockResolvedValue([]),
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
  };
  return { ...base, ...overrides };
}

async function openPersonalization(): Promise<void> {
  fireEvent.click(
    within(screen.getByRole("navigation", { name: "设置分类" })).getByRole("button", {
      name: "个性化",
    }),
  );
  await screen.findByRole("textbox", { name: "自定义指令" });
}

describe("settings personalization section", () => {
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
    useThemeStore.setState({
      mode: "system",
      accent: "sky",
      font: "inter",
      customAccent: "",
      importedFonts: [],
    });
  });

  it("loads existing custom instructions and saves changes", async () => {
    const save = vi.fn().mockResolvedValue({
      ...DEFAULT_PERSONALIZATION,
      custom_instructions: "先查 GEO，再补 Xena。",
    });
    const api = mockApi({
      fetchPersonalization: vi.fn().mockResolvedValue({
        ...DEFAULT_PERSONALIZATION,
        custom_instructions: "先查 GEO。",
      }),
      savePersonalization: save,
    });
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);
    await screen.findByText("供应商管理");
    await openPersonalization();

    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "自定义指令",
    });
    expect(textarea).toHaveValue("先查 GEO。");

    fireEvent.change(textarea, { target: { value: "先查 GEO，再补 Xena。" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(save).toHaveBeenCalledWith({
        custom_instructions: "先查 GEO，再补 Xena。",
      });
    });
  });

  it("persists the selected personality immediately", async () => {
    const save = vi.fn().mockResolvedValue({
      ...DEFAULT_PERSONALIZATION,
      personality: "rigorous",
      personality_label: "严谨",
    });
    const api = mockApi({ savePersonalization: save });
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);
    await screen.findByText("供应商管理");
    await openPersonalization();

    fireEvent.click(screen.getByRole("combobox", { name: "回复语气" }));
    const option = await screen.findByRole("option", { name: /严谨/ });
    fireEvent.pointerDown(option);
    fireEvent.click(option);

    await waitFor(() => {
      expect(save).toHaveBeenCalledWith({ personality: "rigorous" });
    });
  });
});
