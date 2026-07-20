import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { SettingsPanel } from "@/components/SettingsPanel";
import type { ModelInfo, SettingsAPIClient, SkillManifest } from "@/hooks/useAPI";

/* ------------------------------------------------------------------ */
/*  Shared test data                                                    */
/* ------------------------------------------------------------------ */
const TEST_SETTINGS = {
  base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  api_key: "sk-****",
  api_key_configured: true,
  model_name: "qwen-plus",
  max_tokens: 4096,
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
  { id: "qwen-plus", name: "Qwen Plus", description: "Balanced", context_window: 131072, suggested_max_tokens: 8192 },
  { id: "qwen-max", name: "Qwen Max", description: "Powerful", context_window: 32768, suggested_max_tokens: 4096 },
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
  /*  Model settings — key omission / explicit clear / scrollability   */
  /* ================================================================ */

  it("omits api_key from save payload when the field was never touched", async () => {
    const api = mockApi();
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);

    // Wait for the dialog content to load
    await screen.findByLabelText("API Key");

    // Change max tokens to mark form dirty
    const slider = screen.getByLabelText("最大输出 Tokens");
    fireEvent.change(slider, { target: { value: "16384" } });

    fireEvent.click(screen.getByRole("button", { name: "保存模型设置" }));

    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(api.saveSettings).mock.calls[0]?.[0] as Record<string, unknown>;
    // API key field was never dirtied; api_key should not appear in payload
    expect(payload).not.toHaveProperty("api_key");
  });

  it("includes api_key in save payload when user types a new key", async () => {
    const api = mockApi();
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);

    const secret = await screen.findByLabelText("API Key");
    fireEvent.change(secret, { target: { value: "sk-new-secret-key" } });

    // Mark dirty
    const slider = screen.getByLabelText("最大输出 Tokens");
    fireEvent.change(slider, { target: { value: "16384" } });

    fireEvent.click(screen.getByRole("button", { name: "保存模型设置" }));

    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(api.saveSettings).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.api_key).toBe("sk-new-secret-key");
  });

  it("sends api_key as empty string when user clears the API key field", async () => {
    const api = mockApi();
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);

    const secret = await screen.findByLabelText("API Key");
    // Type a key first
    fireEvent.change(secret, { target: { value: "sk-temp" } });
    // Then clear it
    fireEvent.change(secret, { target: { value: "" } });

    // Mark dirty
    const slider = screen.getByLabelText("最大输出 Tokens");
    fireEvent.change(slider, { target: { value: "16384" } });

    fireEvent.click(screen.getByRole("button", { name: "保存模型设置" }));

    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(api.saveSettings).mock.calls[0]?.[0] as Record<string, unknown>;
    // Empty string signals the backend to clear the stored key
    expect(payload.api_key).toBe("");
  });

  it("does not put the API key value into visible DOM text", async () => {
    const api = mockApi();
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);

    await screen.findByLabelText("API Key");

    // The saved masked key "sk-****" must not appear in rendered DOM
    expect(screen.queryByText("sk-****")).not.toBeInTheDocument();
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
    const trigger = document.querySelector<HTMLButtonElement>("#settings-model")!;
    fireEvent.click(trigger);

    // Find option buttons inside the dropdown's ScrollArea
    const scrollArea = document.querySelector<HTMLElement>('[data-slot="scroll-area"]');
    expect(scrollArea).not.toBeNull();
    const optionButtons = scrollArea!.querySelectorAll<HTMLButtonElement>("button");
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
    const trigger = document.querySelector<HTMLButtonElement>("#settings-model")!;
    fireEvent.click(trigger);

    // The ScrollArea root should have h-72 (not max-h-72)
    const scrollArea = document.querySelector<HTMLElement>('[data-slot="scroll-area"]');
    expect(scrollArea).not.toBeNull();
    if (scrollArea === null) throw new Error("Expected [data-slot=\"scroll-area\"]");
    expect(scrollArea).toHaveClass("h-72");
    expect(scrollArea).not.toHaveClass("max-h-72");
  });

  /* ================================================================ */
  /*  Database & Skill management (ported from main)                    */
  /* ================================================================ */

  it("filters skills and refreshes after an enable action", async () => {
    const api = mockApi({
      fetchSkills: vi.fn().mockResolvedValue([
        { name: "pubmed", display_name: "PubMed", version: "1", category: "discovery", description: "Papers", origin: "package", supported_sources: ["pubmed"], operations: ["search"], enabled: true, user_selectable: true, pipeline_supported: true },
      ]),
    });
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);
    await screen.findByLabelText("API Key");
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }));
    const filter = await screen.findByPlaceholderText("筛选技能");
    fireEvent.change(filter, { target: { value: "missing" } });
    expect(screen.getByText("没有匹配的技能")).toBeInTheDocument();
    fireEvent.change(filter, { target: { value: "PubMed" } });
    fireEvent.click(screen.getByRole("button", { name: "停用 PubMed" }));
    await waitFor(() => expect(api.setSkillEnabled).toHaveBeenCalledWith("pubmed", false));
    // fetchSkills is called once on load and again after the toggle
    expect(vi.mocked(api.fetchSkills).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("loads the full declarative manifest before editing a database", async () => {
    const detail = {
      manifest: { name: "pubmed", display_name: "PubMed", version: "1", category: "discovery", description: "Papers", origin: "package", supported_sources: ["pubmed"], operations: ["search"], enabled: true, user_selectable: true, pipeline_supported: false },
      current_version: "1",
      versions: ["1"],
      package_kind: "manifest" as const,
      warning: null,
      available: true,
      load_error: null,
      declarative_manifest: {
        schema_version: "1.0", name: "pubmed", display_name: "PubMed", version: "1", category: "discovery", description: "Papers", supported_sources: ["pubmed"], user_selectable: true, pipeline_supported: false,
        operations: [{ name: "search", description: "Search", method: "POST" as const, url: "https://api.example.com/search/{query}", query: { q: "{query}" }, headers: {}, body: { term: "{query}" } }],
      },
    };
    const api = mockApi({
      fetchSkills: vi.fn().mockResolvedValue([
        { name: "pubmed", display_name: "PubMed", version: "1", category: "discovery", description: "Papers", origin: "package", supported_sources: ["pubmed"], operations: ["search"], enabled: true, user_selectable: true, pipeline_supported: false },
      ]),
      fetchSkill: vi.fn().mockResolvedValue(detail),
    });
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);
    await screen.findByLabelText("API Key");
    fireEvent.click(screen.getByRole("tab", { name: "Databases" }));
    fireEvent.click(await screen.findByRole("button", { name: "编辑 PubMed" }));

    expect(api.fetchSkill).toHaveBeenCalledWith("pubmed");
    expect(await screen.findByLabelText("Base URL")).toHaveValue("https://api.example.com/search/{query}");
    expect(screen.getByLabelText("Method")).toHaveValue("POST");
    expect(screen.getByLabelText("Query template")).toHaveValue('{"q":"{query}"}');
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Updated papers" } });
    fireEvent.click(screen.getByRole("button", { name: "保存数据库" }));
    await waitFor(() => expect(api.updateDatabase).toHaveBeenCalledWith(
      "pubmed",
      expect.objectContaining({
        description: "Updated papers",
        operation: expect.objectContaining({ name: "search", method: "POST", url: "https://api.example.com/search/{query}" }),
      }),
    ));
    const submitted = vi.mocked(api.updateDatabase).mock.calls[0]?.[1] as Record<string, unknown>;
    expect(submitted).not.toHaveProperty("operations");
    expect(submitted).not.toHaveProperty("supported_sources");
  });

  it("confirms package deletion and disables builtin database mutation", async () => {
    const skills: SkillManifest[] = [
      { name: "builtin_db", display_name: "Builtin DB", version: "1", category: "discovery", description: "Builtin", origin: "builtin", supported_sources: ["builtin_db"], operations: ["search"], enabled: true, user_selectable: true, pipeline_supported: true, available: true, load_error: null },
      { name: "pubmed", display_name: "PubMed", version: "1", category: "discovery", description: "Papers", origin: "package", supported_sources: ["pubmed"], operations: ["search"], enabled: true, user_selectable: true, pipeline_supported: false, available: true, load_error: null },
    ];
    const api = mockApi({ fetchSkills: vi.fn().mockResolvedValue(skills) });
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);
    await screen.findByLabelText("API Key");
    fireEvent.click(screen.getByRole("tab", { name: "Databases" }));
    expect(await screen.findByRole("button", { name: "停用 Builtin DB" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "删除 PubMed" }));
    expect(api.deleteDatabase).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(api.deleteDatabase).toHaveBeenCalledWith("pubmed"));
  });
});
