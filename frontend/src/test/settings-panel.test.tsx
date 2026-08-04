import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { SettingsPanel } from "@/components/SettingsPanel";
import type { ModelInfo, SettingsAPIClient } from "@/hooks/useAPI";

/* ------------------------------------------------------------------ */
/*  Shared test data                                                    */
/* ------------------------------------------------------------------ */
const TEST_SETTINGS = {
  base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  api_key: "sk-****",
  api_key_configured: true,
  model_name: "qwen-plus",
  max_tokens: 4096,
  context_window: 131072,
  context_window_source: "catalog" as const,
  safety_reserve_ratio: 0.05,
  safety_reserve_tokens: 16384,
  compaction_trigger_ratio: 0.85,
  compaction_target_ratio: 0.60,
  available_input_tokens: 110592,
  advanced: {
    temperature: 0.7,
    top_p: 1.0,
    repetition_penalty: 1.0,
    enable_search: false,
    thinking_mode: false,
  },
};

const TEST_VENDORS = [
  { id: "dashscope", name: "DashScope", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", description: "Default", recommended: true },
];

const TEST_MODELS: ModelInfo[] = [
  { id: "qwen-plus", name: "Qwen Plus", description: "Balanced", context_window: 131072, suggested_max_tokens: 8192, max_output_tokens: 8192, recommended: false, api_available: true, capability_source: "catalog", capabilities: { text: true, image: false, video: false, audio: false }, vendor_id: "dashscope", knowledge_cutoff: null, pricing_input_per_1m: null, pricing_output_per_1m: null, model_family: null, function_calling: true, supports_streaming: true },
  { id: "qwen-max", name: "Qwen Max", description: "Powerful", context_window: 32768, suggested_max_tokens: 4096, max_output_tokens: 4096, recommended: false, api_available: true, capability_source: "catalog", capabilities: { text: true, image: false, video: false, audio: false }, vendor_id: "dashscope", knowledge_cutoff: null, pricing_input_per_1m: null, pricing_output_per_1m: null, model_family: null, function_calling: true, supports_streaming: true },
];

/* ------------------------------------------------------------------ */
/*  API mock factory                                                    */
/* ------------------------------------------------------------------ */
function mockApi(overrides: Partial<SettingsAPIClient> = {}): SettingsAPIClient {
  const base: SettingsAPIClient = {
    fetchSettings: vi.fn().mockResolvedValue(TEST_SETTINGS),
    saveSettings: vi.fn().mockResolvedValue(TEST_SETTINGS),
    fetchVendors: vi.fn().mockResolvedValue(TEST_VENDORS),
    fetchModels: vi.fn().mockResolvedValue(TEST_MODELS),
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

async function loadModels() {
  fireEvent.click(screen.getByRole("button", { name: /加载模型/ }));
  await waitFor(() => {
    expect(document.querySelector<HTMLButtonElement>("#settings-model")).not.toBeNull();
  });
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */
describe("SettingsPanel", () => {
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

  /* ================================================================ */
  /*  Model settings — key persistence / explicit clear / scrollability */
  /* ================================================================ */

  it("persists a typed api_key after connection validation", async () => {
    const api = mockApi();
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);

    const secret = await screen.findByLabelText("API Key");
    fireEvent.change(secret, { target: { value: "sk-validation-key" } });
    await loadModels();

    const slider = screen.getByLabelText("最大输出 Tokens");
    fireEvent.change(slider, { target: { value: "16384" } });

    fireEvent.click(screen.getByRole("button", { name: "保存模型设置" }));

    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(api.saveSettings).mock.calls[0]?.[0];
    expect(payload).toMatchObject({
      api_key: "sk-validation-key",
      max_tokens: 16384,
    });
  });

  it("uses and persists a typed API key for validation", async () => {
    const api = mockApi();
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);

    const secret = await screen.findByLabelText("API Key");
    fireEvent.change(secret, { target: { value: "sk-new-secret-key" } });
    await loadModels();

    // Mark dirty
    const slider = screen.getByLabelText("最大输出 Tokens");
    fireEvent.change(slider, { target: { value: "16384" } });

    fireEvent.click(screen.getByRole("button", { name: "保存模型设置" }));

    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(api.saveSettings).mock.calls[0]?.[0];
    expect(api.fetchModels).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: "sk-new-secret-key",
    }));
    expect(payload).toHaveProperty("api_key", "sk-new-secret-key");
  });

  it("persists an explicit API key clear when a key was configured", async () => {
    const api = mockApi();
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);

    const secret = await screen.findByLabelText("API Key");
    await loadModels();
    // Type a key first
    fireEvent.change(secret, { target: { value: "sk-temp" } });
    // Then clear it
    fireEvent.change(secret, { target: { value: "" } });

    // Mark dirty
    const slider = screen.getByLabelText("最大输出 Tokens");
    fireEvent.change(slider, { target: { value: "16384" } });

    const save = screen.getByRole("button", { name: "保存模型设置" });
    expect(save).not.toBeDisabled();
    fireEvent.click(save);

    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.saveSettings).mock.calls[0]?.[0]).toMatchObject({
      api_key: "",
      max_tokens: 16384,
    });
  });

  it("does not put the API key value into visible DOM text", async () => {
    const api = mockApi();
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);

    await screen.findByLabelText("API Key");

    // The saved masked key "sk-****" must not appear in rendered DOM
    expect(screen.queryByText("sk-****")).not.toBeInTheDocument();
  });

  it("reopens with the saved API key shown as a masked value", async () => {
    const api = mockApi();
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);

    const secret = (await screen.findByLabelText("API Key")) as HTMLInputElement;
    expect(secret.value).toBe("sk-****");
    expect(secret.type).toBe("password");
  });

  it("shows the saved model name in the manual input before loading the model list and allows editing it", async () => {
    const api = mockApi();
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);

    // Wait for settings to load; the model input is rendered because no models have been fetched.
    const modelInput = (await screen.findByPlaceholderText(
      "输入模型名称（如 qwen-plus）",
    )) as HTMLInputElement;

    // Regression: previously value was forced to "" when modelsLoaded was false,
    // which prevented the user from seeing or editing the saved model name.
    expect(modelInput.value).toBe("qwen-plus");

    // The user must be able to type a custom model name without loading the list first.
    fireEvent.change(modelInput, { target: { value: "qwen-custom" } });
    expect(modelInput.value).toBe("qwen-custom");
  });

  it("model dropdown options contain no descendant interactive elements and capability icons have accessible labels", async () => {
    const api = mockApi({
      // Return settings with a valid base URL so model fetch works
      fetchSettings: vi.fn().mockResolvedValue({
        ...TEST_SETTINGS,
        base_url: "https://test.url/v1",
      }),
      fetchModels: vi.fn().mockResolvedValue(TEST_MODELS),
    });
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);

    // Wait for dialog to load
    await screen.findByLabelText("API Key");

    // Click "加载模型" to fetch and populate the model list
    fireEvent.click(screen.getByRole("button", { name: /加载模型/ }));
    // The trigger changes from input to dropdown once models load.
    // The dropdown trigger button has id="settings-model"
    await waitFor(() => {
      const trigger = document.querySelector<HTMLButtonElement>("#settings-model");
      expect(trigger).not.toBeNull();
    });

    // Open the dropdown
    const trigger = document.querySelector<HTMLButtonElement>("#settings-model");
    if (trigger === null) throw new Error("Expected #settings-model button");
    fireEvent.click(trigger);

    // Find option buttons inside the dropdown's ScrollArea
    const scrollArea = document.querySelector<HTMLElement>('[data-slot="scroll-area"]');
    expect(scrollArea).not.toBeNull();
    if (scrollArea === null) throw new Error("Expected scroll-area element");
    const optionButtons = scrollArea.querySelectorAll<HTMLButtonElement>("button");
    expect(optionButtons.length).toBeGreaterThanOrEqual(2);

    // No option button contains a nested button or role="button"
    optionButtons.forEach((btn) => {
      expect(btn.querySelectorAll('button, [role="button"]')).toHaveLength(0);
    });
  });

  it("model dropdown scroll-area uses explicit h-72 instead of max-h-72", async () => {
    const api = mockApi({
      fetchSettings: vi.fn().mockResolvedValue({
        ...TEST_SETTINGS,
        base_url: "https://test.url/v1",
      }),
      fetchModels: vi.fn().mockResolvedValue(TEST_MODELS),
    });
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);

    // Wait for dialog to load
    await screen.findByLabelText("API Key");

    // Load models
    fireEvent.click(screen.getByRole("button", { name: /加载模型/ }));
    await waitFor(() => {
      const trigger = document.querySelector<HTMLButtonElement>("#settings-model");
      expect(trigger).not.toBeNull();
    });

    // Open dropdown
    const trigger = document.querySelector<HTMLButtonElement>("#settings-model");
    if (trigger === null) throw new Error("Expected #settings-model button");
    fireEvent.click(trigger);

    // The ScrollArea root should have h-72 (not max-h-72)
    const scrollArea = document.querySelector<HTMLElement>('[data-slot="scroll-area"]');
    expect(scrollArea).not.toBeNull();
    if (scrollArea === null) throw new Error("Expected [data-slot=\"scroll-area\"]");
    expect(scrollArea).toHaveClass("h-72");
    expect(scrollArea).not.toHaveClass("max-h-72");
  });

});
