import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { SettingsPanel } from "@/components/SettingsPanel";
import type { ModelInfo, SettingsAPIClient } from "@/hooks/useAPI";

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
  compaction_target_ratio: 0.60,
  available_input_tokens: 12288,
  advanced: {
    temperature: 0.7,
    top_p: 1.0,
    repetition_penalty: 1.0,
    enable_search: false,
    thinking_mode: false,
  },
};

const VENDORS = [{
  id: "ds",
  name: "DashScope",
  base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  description: "",
  recommended: true,
}];

const CATALOG: ModelInfo[] = [
  {
    id: "qwen-plus",
    name: "Qwen Plus",
    description: "",
    context_window: 131072,
    suggested_max_tokens: 8192,
    recommended: false,
    api_available: true,
    capability_source: "catalog",
    capabilities: { text: true, image: false, video: false, audio: false },
    max_output_tokens: 8192,
    vendor_id: null,
    knowledge_cutoff: null,
    pricing_input_per_1m: null,
    pricing_output_per_1m: null,
    model_family: null,
    function_calling: true,
    supports_streaming: true,
  },
  {
    id: "qwen-max",
    name: "Qwen Max",
    description: "",
    context_window: 32768,
    suggested_max_tokens: 4096,
    recommended: false,
    api_available: true,
    capability_source: "catalog",
    capabilities: { text: true, image: false, video: false, audio: false },
    max_output_tokens: 8192,
    vendor_id: null,
    knowledge_cutoff: null,
    pricing_input_per_1m: null,
    pricing_output_per_1m: null,
    model_family: null,
    function_calling: true,
    supports_streaming: true,
  },
  {
    id: "api-v0",
    name: "API Model",
    description: "",
    context_window: 0,
    suggested_max_tokens: 4096,
    recommended: false,
    api_available: true,
    capability_source: "api",
    capabilities: { text: true, image: false, video: false, audio: false },
    max_output_tokens: 8192,
    vendor_id: null,
    knowledge_cutoff: null,
    pricing_input_per_1m: null,
    pricing_output_per_1m: null,
    model_family: null,
    function_calling: true,
    supports_streaming: true,
  },
];

function mockApi(overrides: Partial<SettingsAPIClient> = {}): SettingsAPIClient {
  const base: SettingsAPIClient = {
    fetchSettings: vi.fn().mockResolvedValue(SETTINGS),
    saveSettings: vi.fn().mockResolvedValue(SETTINGS),
    fetchVendors: vi.fn().mockResolvedValue(VENDORS),
    fetchModels: vi.fn().mockResolvedValue(CATALOG),
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

async function loadModels() {
  fireEvent.click(screen.getByRole("button", { name: /加载模型/ }));
  await waitFor(() => {
    expect(document.querySelector<HTMLButtonElement>("#settings-model")).not.toBeNull();
  });
}

async function loadModelsAndSelect(modelName: string) {
  await loadModels();
  const trigger = document.querySelector<HTMLButtonElement>("#settings-model");
  if (trigger === null) throw new Error("Expected model selector");
  fireEvent.click(trigger);
  const option = await screen.findByRole("button", { name: new RegExp(modelName) });
  fireEvent.click(option);
}

describe("SettingsPanel model selector", () => {
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
    await screen.findByLabelText("API Key");

    const outputTokens = screen.getByLabelText("最大输出 Tokens");
    expect(outputTokens).toHaveAttribute("type", "number");
    expect(outputTokens).toHaveAttribute("min", "512");
    expect(outputTokens).toHaveAttribute("max", "131072");
    expect(screen.queryByLabelText("Context Window Override")).not.toBeInTheDocument();
  });

  it("selects a context window preset from a dropdown", async () => {
    const api = mockApi();
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);
    await screen.findByLabelText("API Key");

    fireEvent.click(screen.getByRole("combobox", { name: "上下文窗口" }));
    const option = await screen.findByRole("option", { name: "128K" });
    // Base UI commits real mouse selections only after a matching pointer-down.
    fireEvent.pointerDown(option, { pointerType: "mouse", button: 0, buttons: 1 });
    fireEvent.click(option, { pointerType: "mouse" });

    await waitFor(() =>
      expect(api.saveSettings).toHaveBeenCalledWith({ context_window: 131072 }),
    );
  });

  it("selects an API-discovered model and persists its model name and key", async () => {
    const api = mockApi();
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);
    const secret = await screen.findByLabelText("API Key");
    fireEvent.change(secret, { target: { value: "sk-validation-key" } });

    await loadModelsAndSelect("API Model");
    fireEvent.click(screen.getByRole("button", { name: "保存模型设置" }));

    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.saveSettings).mock.calls[0]?.[0]).toEqual({
      api_key: "sk-validation-key",
      model_name: "api-v0",
    });
  });

  it("selects a catalog model and records its context window", async () => {
    const api = mockApi();
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);
    const secret = await screen.findByLabelText("API Key");
    fireEvent.change(secret, { target: { value: "sk-validation-key" } });

    await loadModelsAndSelect("Qwen Plus");
    fireEvent.click(screen.getByRole("button", { name: "保存模型设置" }));

    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.saveSettings).mock.calls[0]?.[0]).toEqual({
      model_name: "qwen-plus",
      context_window: 131072,
    });
    expect(vi.mocked(api.saveSettings).mock.calls[1]?.[0]).toEqual({
      api_key: "sk-validation-key",
      model_name: "qwen-plus",
    });
  });

  it("persists changes from the output-token slider", async () => {
    const api = mockApi();
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);
    await screen.findByLabelText("API Key");
    await loadModels();
    fireEvent.change(screen.getByLabelText("最大输出 Tokens"), {
      target: { value: "16384" },
    });

    fireEvent.click(screen.getByRole("button", { name: "保存模型设置" }));

    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.saveSettings).mock.calls[0]?.[0]).toEqual({
      max_tokens: 16384,
    });
  });

  it("requires a fresh API key and surfaces connection validation failures", async () => {
    const api = mockApi({
      fetchModels: vi.fn()
        .mockResolvedValueOnce(CATALOG)
        .mockRejectedValue(new Error("invalid credentials")),
    });
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);
    const secret = await screen.findByLabelText("API Key");
    fireEvent.click(screen.getByRole("button", { name: /加载模型/ }));
    await waitFor(() => {
      expect(document.querySelector<HTMLButtonElement>("#settings-model")).not.toBeNull();
    });
    fireEvent.change(screen.getByLabelText("最大输出 Tokens"), {
      target: { value: "16384" },
    });
    const save = screen.getByRole("button", { name: "保存模型设置" });
    expect(save).not.toBeDisabled();

    fireEvent.change(secret, { target: { value: "bad-key" } });
    expect(save).not.toBeDisabled();
    fireEvent.click(save);

    await waitFor(() => {
      expect(
        screen.getByText(
          "API 密钥验证失败，请检查密钥是否正确或与 Base URL 是否匹配",
        ),
      ).toBeInTheDocument();
    });
    expect(api.saveSettings).not.toHaveBeenCalled();
  });
});
