import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { SettingsPanel } from "@/components/SettingsPanel";
import type { DatabaseItem, SettingsAPIClient } from "@/hooks/useAPI";

/* ------------------------------------------------------------------ */
/*  Fixtures                                                          */
/* ------------------------------------------------------------------ */
const SAVED_SETTINGS = {
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
    createManagedModel: vi.fn(),
    updateManagedModel: vi.fn(),
    deleteManagedModel: vi.fn(),
    activateManagedModel: vi.fn(),
    fetchDatabases: vi.fn().mockResolvedValue([]),
    fetchDatabase: vi.fn(), setDatabaseEnabled: vi.fn().mockResolvedValue(undefined),
    createDatabase: vi.fn(), updateDatabase: vi.fn(), deleteDatabase: vi.fn(),
  };
  return { ...base, ...overrides };
}

const mediaMock = vi.fn().mockImplementation((q: string) => ({
  matches: false, media: q, onchange: null,
  addEventListener: vi.fn(), removeEventListener: vi.fn(),
  addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
}));

/* ------------------------------------------------------------------ */
/*  Tests — database drafting and field-level validation                */
/* ------------------------------------------------------------------ */
describe("database draft validation", () => {
  beforeAll(() => { window.matchMedia = mediaMock; });

  it("lists databases and refreshes after an enable toggle", async () => {
    const api = mockApi({
      fetchDatabases: vi.fn().mockResolvedValue([
        { id: "pubmed", name: "PubMed", category: "discovery", description: "Papers", origin: "builtin", version: "1", pipeline_supported: true, enabled: true, capability: "pipeline_supported" },
      ]),
    });
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);
    await screen.findByText("供应商管理");
    fireEvent.click(within(screen.getByRole("navigation", { name: "设置分类" })).getByRole("button", { name: "数据库" }));
    const toggle = await screen.findByRole("switch", { name: "停用 PubMed" });
    fireEvent.click(toggle);
    await waitFor(() => expect(api.setDatabaseEnabled).toHaveBeenCalledWith("pubmed", false));
    expect(vi.mocked(api.fetchDatabases).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("loads the full declarative manifest before editing a database", async () => {
    const detail = {
      id: "pubmed", name: "PubMed", category: "discovery", description: "Papers",
      available: true, enabled: true, origin: "package" as const, version: "1",
      pipeline_supported: false, capability: "research_only",
      declarative_manifest: {
        schema_version: "1.0", name: "pubmed", display_name: "PubMed", version: "1", category: "discovery", description: "Papers", supported_sources: ["pubmed"], user_selectable: true, pipeline_supported: false,
        operations: [{ name: "search", description: "Search", method: "POST" as const, url: "https://api.example.com/search/{query}", query: { q: "{query}" }, headers: {}, body: { term: "{query}" } }],
      },
    };
    const api = mockApi({
      fetchDatabases: vi.fn().mockResolvedValue([
        { id: "pubmed", name: "PubMed", category: "discovery", description: "Papers", origin: "package", version: "1", pipeline_supported: false, enabled: true, capability: "research_only" },
      ]),
      fetchDatabase: vi.fn().mockResolvedValue(detail),
    });
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);
    await screen.findByText("供应商管理");
    fireEvent.click(within(screen.getByRole("navigation", { name: "设置分类" })).getByRole("button", { name: "数据库" }));
    fireEvent.click(await screen.findByRole("button", { name: "编辑 PubMed" }));

    expect(api.fetchDatabase).toHaveBeenCalledWith("pubmed");
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
    const submitted = vi.mocked(api.updateDatabase).mock.calls[0]?.[1];
    expect(submitted).not.toHaveProperty("operations");
    expect(submitted).not.toHaveProperty("supported_sources");
  });

  it("confirms package deletion and toggles builtin databases", async () => {
    const databases: DatabaseItem[] = [
      { id: "builtin_db", name: "Builtin DB", category: "discovery", description: "Builtin", origin: "builtin", version: "1", pipeline_supported: true, enabled: true, capability: "pipeline_supported" },
      { id: "pubmed", name: "PubMed", category: "discovery", description: "Papers", origin: "package", version: "1", pipeline_supported: false, enabled: true, capability: "research_only" },
    ];
    const api = mockApi({ fetchDatabases: vi.fn().mockResolvedValue(databases) });
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);
    await screen.findByText("供应商管理");
    fireEvent.click(within(screen.getByRole("navigation", { name: "设置分类" })).getByRole("button", { name: "数据库" }));
    const builtinSwitch = await screen.findByRole("switch", { name: "停用 Builtin DB" });
    expect(builtinSwitch).not.toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: "删除 PubMed" }));
    expect(api.deleteDatabase).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(api.deleteDatabase).toHaveBeenCalledWith("pubmed"));
  });

  /* ---- Raw string preservation ---- */
  it("new database method input stores raw string without coercion", async () => {
    const api = mockApi();
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);
    await screen.findByText("供应商管理");
    fireEvent.click(within(screen.getByRole("navigation", { name: "设置分类" })).getByRole("button", { name: "数据库" }));
    fireEvent.click(screen.getByRole("button", { name: /新建数据库/ }));
    const methodInput = screen.getByLabelText("Method");
    fireEvent.change(methodInput, { target: { value: "P" } });
    expect(methodInput).toHaveValue("P");
    fireEvent.change(methodInput, { target: { value: "PU" } });
    expect(methodInput).toHaveValue("PU");
    fireEvent.change(methodInput, { target: { value: "PUT" } });
    expect(methodInput).toHaveValue("PUT");
  });

  it.each([
    ["Method", ""],
    ["Method", "INVALID"],
    ["Query template", "{bad"],
    ["Query template", '"string"'],
    ["Query template", "[1, 2, 3]"],
    ["Body template", "{bad"],
    ["Headers template", "[1,2]"],
    ["Body template", ""],
  ])("preserves invalid %s drafts and blocks persistence at save time", async (label, value) => {
    const api = mockApi();
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);
    await screen.findByText("供应商管理");
    fireEvent.click(within(screen.getByRole("navigation", { name: "设置分类" })).getByRole("button", { name: "数据库" }));
    fireEvent.click(screen.getByRole("button", { name: /新建数据库/ }));

    const input = screen.getByLabelText(label);
    fireEvent.change(input, { target: { value } });
    expect(input).toHaveValue(value);

    fireEvent.click(screen.getByRole("button", { name: "保存数据库" }));
    await waitFor(() => expect(api.createDatabase).not.toHaveBeenCalled());
    expect(api.createDatabase).not.toHaveBeenCalled();
  });
});
