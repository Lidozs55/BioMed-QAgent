import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { SettingsPanel } from "@/components/SettingsPanel";
import type { SettingsAPIClient, SkillManifest } from "@/hooks/useAPI";

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
    fetchVendors: vi.fn().mockResolvedValue(VENDORS),
    fetchModels: vi.fn().mockResolvedValue([]),
    fetchSkills: vi.fn().mockResolvedValue([]),
    fetchSkill: vi.fn(), setSkillEnabled: vi.fn().mockResolvedValue(undefined),
    rollbackSkill: vi.fn(), deleteSkill: vi.fn(),
    validateSkill: vi.fn(), uploadSkill: vi.fn(),
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
    const submitted = vi.mocked(api.updateDatabase).mock.calls[0]?.[1];
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

  /* ---- Raw string preservation ---- */
  it("new database method input stores raw string without coercion", async () => {
    const api = mockApi();
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);
    await screen.findByLabelText("API Key");
    fireEvent.click(screen.getByRole("tab", { name: "Databases" }));
    fireEvent.click(screen.getByRole("button", { name: /新建数据库/ }));
    const methodInput = screen.getByLabelText("Method");
    fireEvent.change(methodInput, { target: { value: "P" } });
    expect(methodInput).toHaveValue("P");
    fireEvent.change(methodInput, { target: { value: "PU" } });
    expect(methodInput).toHaveValue("PU");
    fireEvent.change(methodInput, { target: { value: "PUT" } });
    expect(methodInput).toHaveValue("PUT");
  });

  /* ---- Adjacent field validation errors ---- */
  it("blank method shows FieldError and save is disabled", async () => {
    const api = mockApi();
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);
    await screen.findByLabelText("API Key");
    fireEvent.click(screen.getByRole("tab", { name: "Databases" }));
    fireEvent.click(screen.getByRole("button", { name: /新建数据库/ }));
    const methodInput = screen.getByLabelText("Method");
    fireEvent.change(methodInput, { target: { value: "" } });
    expect(screen.getByText("HTTP method is required")).toBeInTheDocument();
    expect(methodInput).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "保存数据库" })).toBeDisabled();
  });

  it("invalid method shows FieldError and save is disabled", async () => {
    const api = mockApi();
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);
    await screen.findByLabelText("API Key");
    fireEvent.click(screen.getByRole("tab", { name: "Databases" }));
    fireEvent.click(screen.getByRole("button", { name: /新建数据库/ }));
    const methodInput = screen.getByLabelText("Method");
    fireEvent.change(methodInput, { target: { value: "INVALID" } });
    expect(screen.getByText(/Invalid method/)).toBeInTheDocument();
    expect(methodInput).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "保存数据库" })).toBeDisabled();
  });

  it("invalid query JSON shows FieldError and save is disabled", async () => {
    const api = mockApi();
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);
    await screen.findByLabelText("API Key");
    fireEvent.click(screen.getByRole("tab", { name: "Databases" }));
    fireEvent.click(screen.getByRole("button", { name: /新建数据库/ }));
    const queryInput = screen.getByLabelText("Query template");
    fireEvent.change(queryInput, { target: { value: "{bad" } });
    expect(screen.getByText("Invalid JSON syntax")).toBeInTheDocument();
    expect(queryInput).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "保存数据库" })).toBeDisabled();
  });

  it("non-object query JSON shows FieldError and save is disabled", async () => {
    const api = mockApi();
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);
    await screen.findByLabelText("API Key");
    fireEvent.click(screen.getByRole("tab", { name: "Databases" }));
    fireEvent.click(screen.getByRole("button", { name: /新建数据库/ }));
    const queryInput = screen.getByLabelText("Query template");
    fireEvent.change(queryInput, { target: { value: '"string"' } });
    expect(screen.getByText(/Must be a JSON object/)).toBeInTheDocument();
    expect(queryInput).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "保存数据库" })).toBeDisabled();
  });

  it("array query JSON shows FieldError and save is disabled", async () => {
    const api = mockApi();
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);
    await screen.findByLabelText("API Key");
    fireEvent.click(screen.getByRole("tab", { name: "Databases" }));
    fireEvent.click(screen.getByRole("button", { name: /新建数据库/ }));
    const queryInput = screen.getByLabelText("Query template");
    fireEvent.change(queryInput, { target: { value: "[1, 2, 3]" } });
    expect(screen.getByText(/Must be a JSON object/)).toBeInTheDocument();
    expect(queryInput).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "保存数据库" })).toBeDisabled();
  });

  it("invalid body JSON shows FieldError and save is disabled", async () => {
    const api = mockApi();
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);
    await screen.findByLabelText("API Key");
    fireEvent.click(screen.getByRole("tab", { name: "Databases" }));
    fireEvent.click(screen.getByRole("button", { name: /新建数据库/ }));
    const bodyInput = screen.getByLabelText("Body template");
    fireEvent.change(bodyInput, { target: { value: "{bad" } });
    expect(screen.getByText("Invalid JSON syntax")).toBeInTheDocument();
    expect(bodyInput).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "保存数据库" })).toBeDisabled();
  });

  it("invalid headers JSON shows FieldError and save is disabled", async () => {
    const api = mockApi();
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);
    await screen.findByLabelText("API Key");
    fireEvent.click(screen.getByRole("tab", { name: "Databases" }));
    fireEvent.click(screen.getByRole("button", { name: /新建数据库/ }));
    const headersInput = screen.getByLabelText("Headers template");
    fireEvent.change(headersInput, { target: { value: "[1,2]" } });
    expect(screen.getByText(/Must be a JSON object/)).toBeInTheDocument();
    expect(headersInput).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "保存数据库" })).toBeDisabled();
  });

  /* ---- F2 blank body fix: not silently coerced to null ---- */
  it("blank body shows FieldError and save is disabled", async () => {
    const api = mockApi();
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);
    await screen.findByLabelText("API Key");
    fireEvent.click(screen.getByRole("tab", { name: "Databases" }));
    fireEvent.click(screen.getByRole("button", { name: /新建数据库/ }));
    const bodyInput = screen.getByLabelText("Body template");
    // Clear the default "null" to blank
    fireEvent.change(bodyInput, { target: { value: "" } });
    expect(screen.getByText(/Body is required/)).toBeInTheDocument();
    expect(bodyInput).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "保存数据库" })).toBeDisabled();
    // Raw draft preserved (not replaced with "null")
    expect(bodyInput).toHaveValue("");
    // API not called
    expect(api.createDatabase).not.toHaveBeenCalled();
  });
});
