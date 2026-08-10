import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

describe("SettingsPanel current-model context budget", () => {
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

  it("uses a fixed output-token range without the legacy context override form", async () => {
    render(<SettingsPanel open onOpenChange={() => undefined} api={mockApi()} />);

    const outputTokens = await screen.findByLabelText("最大输出 Tokens");
    expect(outputTokens).toHaveAttribute("type", "number");
    expect(outputTokens).toHaveAttribute("min", "512");
    expect(outputTokens).toHaveAttribute("max", "131072");
    expect(screen.queryByLabelText("Context Window Override")).not.toBeInTheDocument();
  });

  it("selects a context window preset from a dropdown", async () => {
    const api = mockApi();
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);

    fireEvent.click(await screen.findByRole("combobox", { name: "上下文窗口" }));
    const option = await screen.findByRole("option", { name: "128K" });
    fireEvent.pointerDown(option, { pointerType: "mouse", button: 0, buttons: 1 });
    fireEvent.click(option, { pointerType: "mouse" });

    await waitFor(() =>
      expect(api.saveSettings).toHaveBeenCalledWith({ context_window: 131072 }),
    );
  });

  it("persists changes from the output-token field", async () => {
    const api = mockApi();
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);

    fireEvent.change(await screen.findByLabelText("最大输出 Tokens"), {
      target: { value: "16384" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存模型设置" }));

    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.saveSettings).mock.calls[0]?.[0]).toEqual({
      max_tokens: 16384,
    });
  });

  it("persists generation parameter changes together", async () => {
    const api = mockApi();
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);

    fireEvent.change(await screen.findByLabelText("Temperature"), {
      target: { value: "0.9" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存模型设置" }));

    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.saveSettings).mock.calls[0]?.[0]).toEqual({
      temperature: 0.9,
    });
  });
});
