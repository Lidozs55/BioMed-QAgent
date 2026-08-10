import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { SettingsPanel } from "@/components/SettingsPanel";
import type { SettingsAPIClient } from "@/hooks/useAPI";
import { customFontId, useThemeStore } from "@/stores/themeStore";

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
    fetchVendors: vi.fn().mockResolvedValue(VENDORS),
    fetchModels: vi.fn().mockResolvedValue([]),
    fetchProviders: vi.fn().mockResolvedValue([]),
    createProvider: vi.fn(),
    updateProvider: vi.fn(),
    deleteProvider: vi.fn(),
    discoverProviderModels: vi.fn().mockResolvedValue([]),
    fetchManagedModels: vi.fn().mockResolvedValue([]),
    createManagedModel: vi.fn(),
    updateManagedModel: vi.fn(),
    deleteManagedModel: vi.fn(),
    activateManagedModel: vi.fn(),
    fetchSkills: vi.fn().mockResolvedValue([]),
    fetchSkill: vi.fn(),
    setSkillEnabled: vi.fn().mockResolvedValue(undefined),
    rollbackSkill: vi.fn(),
    deleteSkill: vi.fn(),
    validateSkill: vi.fn(),
    uploadSkill: vi.fn(),
    createDatabase: vi.fn(),
    updateDatabase: vi.fn(),
    deleteDatabase: vi.fn(),
  };
  return { ...base, ...overrides };
}

class MockFileReader {
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;

  readAsDataURL(): void {
    this.result = "data:font/ttf;base64,AAEAAA==";
    this.onload?.();
  }
}

describe("settings appearance font import", () => {
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
    vi.stubGlobal("FileReader", MockFileReader);
  });

  afterEach(() => {
    useThemeStore.setState({
      mode: "system",
      accent: "sky",
      font: "inter",
      customAccent: "",
      importedFonts: [],
    });
    document.getElementById("imported-font-faces")?.remove();
  });

  it("imports a local font, registers a font face, and makes it selectable", async () => {
    const api = mockApi();
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);
    await screen.findByText("供应商管理");
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "设置分类" })).getByRole("button", {
        name: "外观",
      }),
    );

    const fileInput = screen.getByLabelText<HTMLInputElement>("导入字体");
    const file = new File(["font-data"], "Demo Font.ttf", { type: "font/ttf" });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      const imported = useThemeStore.getState().importedFonts[0];
      expect(imported?.name).toBe("Demo Font");
      expect(imported?.format).toBe("truetype");
    });

    expect(document.getElementById("imported-font-faces")?.textContent).toContain("@font-face");

    const imported = useThemeStore.getState().importedFonts[0];
    useThemeStore.getState().setFont(customFontId(imported.id));
    await waitFor(() => {
      expect(screen.getAllByText("Demo Font").length).toBeGreaterThanOrEqual(2);
    });

    fireEvent.click(screen.getByRole("button", { name: "删除字体 Demo Font" }));
    await waitFor(() => {
      expect(useThemeStore.getState().importedFonts).toHaveLength(0);
      expect(useThemeStore.getState().font).toBe("inter");
    });
  });
});
