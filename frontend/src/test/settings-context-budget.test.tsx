import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsPanel } from "@/components/SettingsPanel";
import { createAPIClient } from "@/hooks/useAPI";
import type { FetchLike, ModelInfo, SettingsAPIClient } from "@/hooks/useAPI";

/* Silence toast.success for scenario 7 no-success assertion */
beforeEach(() => { vi.restoreAllMocks(); });

/* ------------------------------------------------------------------ */
/*  Fixtures                                                          */
/* ------------------------------------------------------------------ */
const SETTINGS_USER_OVERRIDE = {
  base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  api_key: "sk-****", api_key_configured: true,
  model_name: "qwen-max", max_tokens: 4096,
  context_window: 65536, context_window_source: "user" as const,
  safety_reserve_ratio: 0.05, safety_reserve_tokens: 16384,
  compaction_trigger_ratio: 0.85, compaction_target_ratio: 0.60,
  available_input_tokens: 45056,
  advanced: { temperature: 0.7, top_p: 1.0, repetition_penalty: 1.0, enable_search: false, thinking_mode: false },
};

const SETTINGS_CATALOG_32K = {
  base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  api_key: "sk-****", api_key_configured: true,
  model_name: "qwen-max", max_tokens: 4096,
  context_window: 32768, context_window_source: "catalog" as const,
  safety_reserve_ratio: 0.05, safety_reserve_tokens: 16384,
  compaction_trigger_ratio: 0.85, compaction_target_ratio: 0.60,
  available_input_tokens: 12288,
  advanced: { temperature: 0.7, top_p: 1.0, repetition_penalty: 1.0, enable_search: false, thinking_mode: false },
};

const VENDORS = [{ id: "ds", name: "DashScope", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", description: "", recommended: true }];

const CATALOG: ModelInfo[] = [
  { id: "qwen-plus", name: "Qwen Plus", description: "", context_window: 131072, suggested_max_tokens: 8192, recommended: false, api_available: true, capability_source: "catalog", capabilities: { text: true, image: false, video: false, audio: false } },
  { id: "qwen-max", name: "Qwen Max", description: "", context_window: 32768, suggested_max_tokens: 4096, recommended: false, api_available: true, capability_source: "catalog", capabilities: { text: true, image: false, video: false, audio: false } },
];

const API_ONLY: ModelInfo[] = [
  { id: "api-v0", name: "API Model", description: "", context_window: 0, suggested_max_tokens: 4096, recommended: false, api_available: true, capability_source: "api", capabilities: { text: true, image: false, video: false, audio: false } },
];

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */
function mockApi(overrides: Partial<SettingsAPIClient> = {}): SettingsAPIClient {
  const base: SettingsAPIClient = {
    fetchSettings: vi.fn().mockResolvedValue(SETTINGS_CATALOG_32K),
    saveSettings: vi.fn().mockResolvedValue(SETTINGS_CATALOG_32K),
    fetchVendors: vi.fn().mockResolvedValue(VENDORS),
    fetchModels: vi.fn().mockResolvedValue(CATALOG),
    fetchSkills: vi.fn().mockResolvedValue([]),
    fetchSkill: vi.fn(), setSkillEnabled: vi.fn().mockResolvedValue(undefined),
    rollbackSkill: vi.fn(), deleteSkill: vi.fn(),
    validateSkill: vi.fn(), uploadSkill: vi.fn(),
    createDatabase: vi.fn(), updateDatabase: vi.fn(), deleteDatabase: vi.fn(),
  };
  return { ...base, ...overrides };
}

/** Wait for model list to finish loading, then click the trigger by id */
async function openModelDropdown() {
  // Wait for the trigger button (id="settings-model") to appear
  await waitFor(() => {
    const el = document.querySelector<HTMLButtonElement>("#settings-model");
    expect(el).not.toBeNull();
    expect(el?.textContent).toMatch(/选择模型|Qwen/);
  });
  const el = document.querySelector<HTMLButtonElement>("#settings-model");
  if (el) fireEvent.click(el);
}

/** Find a model option button within the dropdown by text match */
function modelOption(text: string): HTMLButtonElement | null {
  const opts = document.querySelectorAll<HTMLButtonElement>('[data-slot="scroll-area"] button');
  return Array.from(opts).find((b) => b.textContent?.includes(text)) ?? null;
}

const mediaMock = vi.fn().mockImplementation((q: string) => ({
  matches: false, media: q, onchange: null,
  addEventListener: vi.fn(), removeEventListener: vi.fn(),
  addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
}));

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */
describe("SettingsPanel context budget — full integration", () => {
  beforeAll(() => { window.matchMedia = mediaMock; });

  /* ---- RFC1: stale user override → API-only → disabled save → override → exact payload ---- */
  it("API-only selection from user-override state clears stale override, disables save, requires fresh override", async () => {
    const api = mockApi({
      fetchSettings: vi.fn().mockResolvedValue(SETTINGS_USER_OVERRIDE),
      fetchModels: vi.fn().mockResolvedValue(API_ONLY),
      saveSettings: vi.fn().mockResolvedValue({ ...SETTINGS_USER_OVERRIDE, model_name: "api-v0", context_window: 65536, context_window_source: "user", available_input_tokens: 45056 }),
    });
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);
    await screen.findByLabelText("API Key");

    fireEvent.click(screen.getByRole("button", { name: /加载模型/ }));
    await openModelDropdown();
    await waitFor(() => expect(modelOption("API Model")).not.toBeNull());
    const apiOpt = modelOption("API Model");
    if (apiOpt) fireEvent.click(apiOpt);

    // Source is unknown (not inherited user/catalog from stale override)
    await waitFor(() => expect(screen.getByText("unknown")).toBeInTheDocument());
    // Save is disabled AND not called until override entered
    expect(screen.getByRole("button", { name: "保存模型设置" })).toBeDisabled();
    expect(api.saveSettings).not.toHaveBeenCalled();

    // Enter override
    fireEvent.change(screen.getByLabelText("Context Window Override"), { target: { value: "65536" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "保存模型设置" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "保存模型设置" }));
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(api.saveSettings).mock.calls[0]?.[0];
    expect(payload).toEqual({ model_name: "api-v0", context_window: 65536 });
  });

  /* ---- Scenario 1: catalog selection with prior user override ---- */
  it("selects qwen-plus from user-override — clears override, exact 131072, source catalog, sends model_name + context_window:null", async () => {
    const api = mockApi({
      fetchSettings: vi.fn().mockResolvedValue(SETTINGS_USER_OVERRIDE),
      saveSettings: vi.fn().mockResolvedValue({ ...SETTINGS_USER_OVERRIDE, model_name: "qwen-plus", context_window: 131072, context_window_source: "catalog", available_input_tokens: 110592 }),
    });
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);
    await screen.findByLabelText("API Key");
    fireEvent.click(screen.getByRole("button", { name: /加载模型/ }));
    await openModelDropdown();
    await waitFor(() => expect(modelOption("Qwen Plus")).not.toBeNull());
    const qpOpt = modelOption("Qwen Plus");
    if (qpOpt) fireEvent.click(qpOpt);

    await waitFor(() => expect(screen.getByText("131,072 tokens")).toBeInTheDocument());
    expect(screen.getByText("catalog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存模型设置" }));
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(api.saveSettings).mock.calls[0]?.[0];
    expect(payload).toEqual({ model_name: "qwen-plus", context_window: null });
  });

  /* ---- Scenario 2: exact 32768 catalog values ---- */
  it("exact 32768 catalog — reserve 16384, available 12288, max output max = 16383", async () => {
    render(<SettingsPanel open onOpenChange={() => undefined} api={mockApi()} />);
    await screen.findByLabelText("API Key");
    expect(screen.getByText("32,768 tokens")).toBeInTheDocument();
    expect(screen.getByText("16,384 tokens")).toBeInTheDocument();
    expect(screen.getByText("12,288 tokens")).toBeInTheDocument();
    const maxInput = screen.getByLabelText<HTMLInputElement>("最大输出 Tokens");
    expect(maxInput.max).toBe("16383");
  });

  /* ---- Scenario 6: one-ratio-only dirty payload ---- */
  it("changing only safetyReserveRatio sends exactly { safety_reserve_ratio }", async () => {
    const api = mockApi();
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);
    await screen.findByLabelText("API Key");
    fireEvent.change(screen.getByLabelText("Safety Reserve Ratio"), { target: { value: "0.10" } });
    fireEvent.click(screen.getByRole("button", { name: "保存模型设置" }));
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.saveSettings).mock.calls[0]?.[0]).toEqual({ safety_reserve_ratio: 0.10 });
  });

  /* ---- Scenario 5: multiple invalid states disable save and mark controls ---- */
  it("invalid safety ratio, target>=trigger, max output=0 each disable save and set aria-invalid", async () => {
    render(<SettingsPanel open onOpenChange={() => undefined} api={mockApi()} />);
    await screen.findByLabelText("API Key");
    const saveBtn = screen.getByRole("button", { name: "保存模型设置" });

    // (a) Safety > 0.25
    const safetyInput = screen.getByLabelText("Safety Reserve Ratio");
    fireEvent.change(safetyInput, { target: { value: "0.50" } });
    await waitFor(() => assert(safetyInput.getAttribute("aria-invalid") === "true", "safety aria-invalid"));
    expect(saveBtn).toBeDisabled();
    fireEvent.change(safetyInput, { target: { value: "0.05" } });
    await waitFor(() => expect(safetyInput).not.toHaveAttribute("aria-invalid"));

    // (b) Target >= trigger
    const triggerInput = screen.getByLabelText("Compaction Trigger");
    const targetInput = screen.getByLabelText("Compaction Target");
    fireEvent.change(targetInput, { target: { value: "0.90" } });
    fireEvent.change(triggerInput, { target: { value: "0.85" } });
    await waitFor(() => expect(triggerInput).toHaveAttribute("aria-invalid", "true"));
    expect(targetInput).toHaveAttribute("aria-invalid", "true");
    expect(saveBtn).toBeDisabled();
    fireEvent.change(targetInput, { target: { value: "0.60" } });
    fireEvent.change(triggerInput, { target: { value: "0.85" } });
    await waitFor(() => expect(triggerInput).not.toHaveAttribute("aria-invalid"));

    // (c) Max output = 0
    const maxInput = screen.getByLabelText("最大输出 Tokens");
    fireEvent.change(maxInput, { target: { value: "0" } });
    await waitFor(() => expect(maxInput).toHaveAttribute("aria-invalid", "true"));
    expect(saveBtn).toBeDisabled();
  });

  /* ---- Scenario 7: structured API rejection through real HTTP boundary ---- */
  it("rejected API save retains draft/confirmed and shows alert with detail, no success", async () => {
    const savedSettings = SETTINGS_CATALOG_32K;
    const settingsJson = JSON.stringify(savedSettings);
    const skillsJson = JSON.stringify({ skills: [] });
    const vendorsJson = JSON.stringify({ vendors: VENDORS });
    const modelsJson = JSON.stringify({ models: CATALOG });
    const fetcher = vi.fn<FetchLike>().mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (urlStr.includes("/settings") && (!init || init.method !== "PUT")) {
        return new Response(settingsJson, { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (init?.method === "PUT" && urlStr.includes("/settings")) {
        return new Response(JSON.stringify({
          detail: [{ loc: ["body", "safety_reserve_ratio"], msg: "ensure this value is less than or equal to 0.25", type: "value_error" }],
        }), { status: 422, headers: { "Content-Type": "application/json" } });
      }
      if (urlStr.includes("/skills")) return new Response(skillsJson, { status: 200, headers: { "Content-Type": "application/json" } });
      if (urlStr.includes("/vendors")) return new Response(vendorsJson, { status: 200, headers: { "Content-Type": "application/json" } });
      if (urlStr.includes("/models")) return new Response(modelsJson, { status: 200, headers: { "Content-Type": "application/json" } });
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const api = createAPIClient({ fetcher });
    const { toast } = await import("sonner");
    const successSpy = vi.spyOn(toast, "success");
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);
    await screen.findByLabelText("API Key");
    const triggerInput = screen.getByLabelText("Compaction Trigger");
    fireEvent.change(triggerInput, { target: { value: "0.90" } });
    fireEvent.click(screen.getByRole("button", { name: "保存模型设置" }));
    // Alert appears with normalized detail from the 422 response
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("ensure this value is less than or equal to 0.25"));
    // Draft retained
    expect(triggerInput).toHaveValue(0.9);
    // Confirmed summary unchanged — still shows original catalog 32,768 tokens
    expect(screen.getByText("32,768 tokens")).toBeInTheDocument();
    // Success toast was not called (no success branch)
    expect(successSpy).not.toHaveBeenCalled();
  });

  /* ---- F1a: saved source=user, clear override → dirty with context_window: null ---- */
  it("saved user override cleared → dirty, sends context_window: null (source-intent transition)", async () => {
    const saved = {
      base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      api_key: "sk-****", api_key_configured: true,
      model_name: "qwen-max", max_tokens: 4096,
      context_window: 65536, context_window_source: "user" as const,
      safety_reserve_ratio: 0.05, safety_reserve_tokens: 16384,
      compaction_trigger_ratio: 0.85, compaction_target_ratio: 0.60,
      available_input_tokens: 45056,
      advanced: { temperature: 0.7, top_p: 1.0, repetition_penalty: 1.0, enable_search: false, thinking_mode: false },
    };
    const api = mockApi({ fetchSettings: vi.fn().mockResolvedValue(saved) });
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);
    await screen.findByLabelText("API Key");
    // Override field should be filled with 65536 (from saved user override)
    const overrideInput = screen.getByLabelText("Context Window Override");
    expect(overrideInput).toHaveValue(65536);
    // Clear override
    fireEvent.change(overrideInput, { target: { value: "" } });
    // Save should now be enabled (dirty due to source intent)
    await waitFor(() => expect(screen.getByRole("button", { name: "保存模型设置" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "保存模型设置" }));
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(api.saveSettings).mock.calls[0]?.[0];
    expect(payload).toHaveProperty("context_window", null);
  });

  /* ---- F1b: saved source=catalog, enter override equal to catalog → dirty with context_window: number ---- */
  it("saved catalog 32768, enter override 32768 → dirty, sends context_window: 32768 (source-intent transition)", async () => {
    const api = mockApi();
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);
    await screen.findByLabelText("API Key");
    const overrideInput = screen.getByLabelText("Context Window Override");
    // Override field should be blank (saved source is catalog)
    expect(overrideInput).toHaveValue(null);
    // Enter override equal to catalog value
    fireEvent.change(overrideInput, { target: { value: "32768" } });
    // Save should now be enabled (dirty due to source intent transition)
    await waitFor(() => expect(screen.getByRole("button", { name: "保存模型设置" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "保存模型设置" }));
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(api.saveSettings).mock.calls[0]?.[0];
    expect(payload).toHaveProperty("context_window", 32768);
  });

  /* ---- Scenario 8: numeric input type and narrow one-column structure ---- */
  it("max output is type=number, budget controls stack vertically on narrow viewport", async () => {
    window.matchMedia = vi.fn().mockImplementation((q: string) => ({
      matches: q.includes("min-width") === false, // narrow viewport
      media: q, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    }));
    render(<SettingsPanel open onOpenChange={() => undefined} api={mockApi()} />);
    await screen.findByLabelText("API Key");
    const el = screen.getByLabelText("最大输出 Tokens");
    expect(el).toHaveAttribute("type", "number");
    expect(el).not.toHaveAttribute("type", "range");

    // Budget controls are inside field-set elements — "Context Configuration" first, then "Advanced Budget Ratios"
    const contextLegend = screen.getByText("Context Configuration");
    const advancedLegend = screen.getByText("Advanced Budget Ratios");
    expect(contextLegend.compareDocumentPosition(advancedLegend)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
});

function assert(condition: boolean, msg: string): asserts condition is true {
  if (!condition) throw new Error(msg);
}
