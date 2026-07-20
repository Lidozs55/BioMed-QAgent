import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { SettingsPanel } from "@/components/SettingsPanel";
import type { ModelInfo, VendorInfo } from "@/hooks/useSettings";

const MASKED_SETTINGS = {
  base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  api_key: "sk-****",
  model_name: "qwen-plus",
  max_tokens: 4096,
  advanced: { temperature: 0.7, top_p: 1.0, repetition_penalty: 1.0, enable_search: false, thinking_mode: false },
};

const VENDORS: VendorInfo[] = [
  { id: "dashscope", name: "DashScope", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", description: "Default", recommended: true },
];

const MODELS: ModelInfo[] = [
  { id: "qwen-plus", name: "Qwen Plus", description: "Balanced", context_window: 131072, suggested_max_tokens: 8192, capabilities: { text: true, image: false, video: false, audio: false }, recommended: true, api_available: true, capability_source: "api" },
  { id: "qwen-max", name: "Qwen Max", description: "Powerful", context_window: 32768, suggested_max_tokens: 4096, capabilities: { text: true, image: true, video: false, audio: false }, recommended: false, api_available: true, capability_source: "api" },
];

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

  it("renders loading state", () => {
    render(
      <SettingsPanel
        settings={null}
        models={[]}
        vendors={[]}
        loading={true}
        saving={false}
        modelsLoading={false}
        error={null}
        onSave={vi.fn()}
        onClose={vi.fn()}
        onFetchModels={vi.fn()}
      />,
    );
    expect(screen.getByText("加载设置中…")).toBeVisible();
  });

  it("omits masked key from save payload when unchanged", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <SettingsPanel
        settings={MASKED_SETTINGS}
        models={MODELS}
        vendors={VENDORS}
        loading={false}
        saving={false}
        modelsLoading={false}
        error={null}
        onSave={onSave}
        onClose={vi.fn()}
        onFetchModels={vi.fn()}
      />,
    );

    // Change max tokens to mark form dirty and enable save
    const slider = screen.getByLabelText("最大输出 Tokens");
    fireEvent.change(slider, { target: { value: "16384" } });

    // Click save
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const payload = onSave.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.api_key).toBeUndefined();
  });

  it("saves new API key when user types a different value", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <SettingsPanel
        settings={MASKED_SETTINGS}
        models={MODELS}
        vendors={VENDORS}
        loading={false}
        saving={false}
        modelsLoading={false}
        error={null}
        onSave={onSave}
        onClose={vi.fn()}
        onFetchModels={vi.fn()}
      />,
    );

    // The api_key input shows the masked key. Type a new value.
    const apiKeyInput = screen.getByLabelText("API Key");
    fireEvent.change(apiKeyInput, { target: { value: "sk-new-secret-key" } });

    // Change model to also mark dirty
    const slider = screen.getByLabelText("最大输出 Tokens");
    fireEvent.change(slider, { target: { value: "16384" } });

    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const payload = onSave.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.api_key).toBe("sk-new-secret-key");
  });

  it("does not include API key in any rendered DOM text", () => {
    render(
      <SettingsPanel
        settings={MASKED_SETTINGS}
        models={MODELS}
        vendors={VENDORS}
        loading={false}
        saving={false}
        modelsLoading={false}
        error={null}
        onSave={vi.fn()}
        onClose={vi.fn()}
        onFetchModels={vi.fn()}
      />,
    );

    // The actual API key value should never appear in the rendered DOM
    expect(screen.queryByText("sk-****")).not.toBeInTheDocument();
  });

  it("model option buttons contain no descendant buttons and capability icons have accessible labels", () => {
    const { container } = render(
      <SettingsPanel
        settings={MASKED_SETTINGS}
        models={MODELS}
        vendors={VENDORS}
        loading={false}
        saving={false}
        modelsLoading={false}
        error={null}
        onSave={vi.fn()}
        onClose={vi.fn()}
        onFetchModels={vi.fn()}
      />,
    );

    // Open the model dropdown
    const trigger = container.querySelector<HTMLButtonElement>("#settings-model");
    expect(trigger).not.toBeNull();
    expect(trigger).toBeInTheDocument();
    if (trigger === null) throw new Error("Expected #settings-model");
    fireEvent.click(trigger);

    // Model option buttons inside the dropdown ScrollArea
    const optionButtons = container.querySelectorAll<HTMLButtonElement>(
      '[data-slot="scroll-area"] button',
    );
    expect(optionButtons.length).toBeGreaterThanOrEqual(2);

    // No nested interactive elements inside any option button
    optionButtons.forEach((btn) => {
      expect(btn.querySelectorAll('button, [role="button"]')).toHaveLength(0);
    });

    // The Qwen Max option has image capability icon with accessible label
    const qwenMax = Array.from(optionButtons).find(
      (b) => b.textContent?.includes("Qwen Max"),
    );
    expect(qwenMax).toBeDefined();
    expect(qwenMax).not.toBeNull();
    if (qwenMax === undefined) throw new Error("Expected Qwen Max option");

    const imgLabel = qwenMax.querySelector('[aria-label="支持图像"]');
    expect(imgLabel).toBeInTheDocument();
    expect(imgLabel).toHaveAttribute("title", "支持图像");
  });

  it("model dropdown scroll-area uses explicit h-72 height for scroll to work", () => {
    const manyModels: ModelInfo[] = Array.from({ length: 229 }, (_, i) => ({
      id: `model-${i + 1}`,
      name: `Long Model Name ${i + 1}`,
      description: `Overflow test model number ${i + 1}`,
      context_window: 131072,
      suggested_max_tokens: 8192,
      capabilities: { text: true, image: false, video: false, audio: false },
      recommended: false,
      api_available: true,
      capability_source: "api",
    }));
    const { container } = render(
      <SettingsPanel
        settings={MASKED_SETTINGS}
        models={manyModels}
        vendors={VENDORS}
        loading={false}
        saving={false}
        modelsLoading={false}
        error={null}
        onSave={vi.fn()}
        onClose={vi.fn()}
        onFetchModels={vi.fn()}
      />,
    );

    // Open the model dropdown
    const trigger = container.querySelector<HTMLButtonElement>("#settings-model");
    expect(trigger).not.toBeNull();
    if (trigger === null) throw new Error("Expected #settings-model");
    fireEvent.click(trigger);

    // Find the ScrollArea inside the dropdown popover
    const popover = container.querySelector(".bg-popover");
    expect(popover).not.toBeNull();
    if (popover === null) throw new Error("Expected .bg-popover");
    const scrollArea = popover.querySelector<HTMLElement>('[data-slot="scroll-area"]');
    expect(scrollArea).not.toBeNull();
    if (scrollArea === null) throw new Error("Expected [data-slot=\"scroll-area\"]");

    // Base UI ScrollArea Viewport is size-full (height:100%),
    // so Root must have an explicit fixed height for scrolling to work.
    expect(scrollArea).toHaveClass("h-72");
    expect(scrollArea).not.toHaveClass("max-h-72");
  });
});
