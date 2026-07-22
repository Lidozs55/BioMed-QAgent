import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { SettingsPanel } from "@/components/SettingsPanel";
import type { SettingsAPIClient } from "@/hooks/useAPI";

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

const VALIDATION_RESULT = {
  valid: true,
  skill: { name: "test", display_name: "Test", version: "1", category: "search", description: "", origin: "package", supported_sources: [], operations: [], enabled: true, user_selectable: true, pipeline_supported: false },
  warning: null,
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
/*  Tests                                                             */
/* ------------------------------------------------------------------ */
describe("database creation submits through createDatabase", () => {
  beforeAll(() => { window.matchMedia = mediaMock; });

  it("fills and saves new database, calls createDatabase with manifest", async () => {
    const api = mockApi();
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);
    await screen.findByLabelText("API Key");
    fireEvent.click(screen.getByRole("tab", { name: "Databases" }));

    fireEvent.click(screen.getByRole("button", { name: /新建数据库/ }));

    // Use id-based queries for the database editor fields inside the nested dialog
    const nameInput = screen.getByLabelText("Name");
    fireEvent.change(nameInput, { target: { value: "test-db" } });
    const displayInput = screen.getByLabelText("Display name");
    fireEvent.change(displayInput, { target: { value: "Test DB" } });
    const urlInputs = screen.getAllByLabelText("Base URL");
    const dbUrlInput = urlInputs[urlInputs.length - 1]; // last one is the database dialog's
    fireEvent.change(dbUrlInput, { target: { value: "https://api.example.com/search" } });

    fireEvent.click(screen.getByRole("button", { name: "保存数据库" }));
    await waitFor(() => expect(api.createDatabase).toHaveBeenCalledTimes(1));
    const manifest = vi.mocked(api.createDatabase).mock.calls[0]?.[0];
    expect(manifest).toHaveProperty("name", "test-db");
    expect(manifest).toHaveProperty("display_name", "Test DB");
    expect(manifest).toHaveProperty("schema_version", "1.0");
  });

  it("database upload validates file then uploads through confirm", async () => {
    const api = mockApi({
      fetchSkills: vi.fn().mockResolvedValue([]),
      validateSkill: vi.fn().mockResolvedValue(VALIDATION_RESULT),
    });
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);
    await screen.findByLabelText("API Key");
    fireEvent.click(screen.getByRole("tab", { name: "Databases" }));

    const fileInput = screen.getByLabelText<HTMLInputElement>("上传数据库包");
    const file = new File(['{"name":"test"}'], "test.yaml", { type: "application/x-yaml" });
    fireEvent.change(fileInput, { target: { files: [file] } });
    await waitFor(() => expect(api.validateSkill).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText("确认安装")).toBeInTheDocument();
    // Click confirmation and assert uploadSkill called with the exact file
    fireEvent.click(screen.getByRole("button", { name: "确认安装" }));
    await waitFor(() => expect(api.uploadSkill).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.uploadSkill).mock.calls[0]?.[0]).toBe(file);
  });

  it("skill upload validates file then uploads through confirm", async () => {
    const api = mockApi({
      fetchSkills: vi.fn().mockResolvedValue([]),
      validateSkill: vi.fn().mockResolvedValue(VALIDATION_RESULT),
    });
    render(<SettingsPanel open onOpenChange={() => undefined} api={api} />);
    await screen.findByLabelText("API Key");
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }));

    const fileInput = screen.getByLabelText<HTMLInputElement>("上传技能");
    const file = new File(['{"name":"test-skill"}'], "skill.yaml", { type: "application/x-yaml" });
    fireEvent.change(fileInput, { target: { files: [file] } });
    await waitFor(() => expect(api.validateSkill).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeInTheDocument());
    expect(screen.getByText("确认安装")).toBeInTheDocument();
    // Click confirmation and assert uploadSkill called with the exact file
    fireEvent.click(screen.getByRole("button", { name: "确认安装" }));
    await waitFor(() => expect(api.uploadSkill).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.uploadSkill).mock.calls[0]?.[0]).toBe(file);
  });
});
