import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SettingsPanel } from "@/components/SettingsPanel";
import type { SettingsAPIClient } from "@/hooks/useAPI";

function api(): SettingsAPIClient {
  return {
    fetchSettings: vi.fn().mockResolvedValue({
      base_url: "https://example.com/v1",
      api_key: "sk-secre...alue",
      api_key_configured: true,
      model_name: "demo-model",
      max_tokens: 4096,
      advanced: {},
    }),
    saveSettings: vi.fn().mockResolvedValue({}),
    fetchVendors: vi.fn().mockResolvedValue([]),
    fetchModels: vi.fn().mockResolvedValue([]),
    fetchDatabases: vi.fn().mockResolvedValue([{ id: "pubmed", name: "PubMed", category: "discovery", description: "Papers", origin: "builtin", version: "1", available: true, pipeline_supported: true }]),
    fetchSkills: vi.fn().mockResolvedValue([{ name: "pubmed", display_name: "PubMed", version: "1", category: "discovery", description: "Papers", origin: "package", supported_sources: ["pubmed"], operations: ["search"], enabled: true, user_selectable: true, pipeline_supported: true }]),
    fetchSkill: vi.fn().mockResolvedValue({ manifest: { name: "pubmed", display_name: "PubMed", version: "1", category: "discovery", description: "Papers", origin: "package", supported_sources: ["pubmed"], operations: ["search"], enabled: true, user_selectable: true, pipeline_supported: false }, current_version: "1", versions: ["1"], package_kind: "manifest", warning: null, available: true, load_error: null, declarative_manifest: { schema_version: "1.0", name: "pubmed", display_name: "PubMed", version: "1", category: "discovery", description: "Papers", supported_sources: ["pubmed"], user_selectable: true, pipeline_supported: false, operations: [{ name: "search", description: "Search", method: "POST", url: "https://api.example.com/search/{query}", query: { q: "{query}" }, headers: {}, body: { term: "{query}" } }] } }),
    setSkillEnabled: vi.fn().mockResolvedValue(undefined),
    rollbackSkill: vi.fn().mockResolvedValue(undefined),
    deleteSkill: vi.fn().mockResolvedValue(undefined),
    validateSkill: vi.fn(), uploadSkill: vi.fn(), createDatabase: vi.fn(), updateDatabase: vi.fn(), deleteDatabase: vi.fn(),
  } as unknown as SettingsAPIClient;
}

describe("SettingsPanel", () => {
  it("does not put the masked saved key into the editable secret and saves a replacement", async () => {
    const client = api();
    render(<SettingsPanel open onOpenChange={() => undefined} api={client} />);

    const secret = await screen.findByLabelText("API Key");
    expect(secret).toHaveValue("");
    expect(secret).toHaveAttribute("placeholder", expect.stringContaining("已配置"));
    fireEvent.change(secret, { target: { value: "new-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "保存模型设置" }));

    await waitFor(() => expect(client.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ api_key: "new-secret" })));
  });

  it("filters skills and refreshes after an enable action", async () => {
    const client = api();
    render(<SettingsPanel open onOpenChange={() => undefined} api={client} />);
    await screen.findByLabelText("API Key");
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }));
    const filter = await screen.findByPlaceholderText("筛选技能");
    fireEvent.change(filter, { target: { value: "missing" } });
    expect(screen.getByText("没有匹配的技能")).toBeInTheDocument();
    fireEvent.change(filter, { target: { value: "PubMed" } });
    fireEvent.click(screen.getByRole("button", { name: "停用 PubMed" }));
    await waitFor(() => expect(client.setSkillEnabled).toHaveBeenCalledWith("pubmed", false));
    expect(client.fetchSkills).toHaveBeenCalledTimes(2);
  });

  it("loads the full declarative manifest before editing a database", async () => {
    const client = api();
    render(<SettingsPanel open onOpenChange={() => undefined} api={client} />);
    await screen.findByLabelText("API Key");
    fireEvent.click(screen.getByRole("tab", { name: "Databases" }));
    fireEvent.click(await screen.findByRole("button", { name: "编辑 PubMed" }));

    expect(client.fetchSkill).toHaveBeenCalledWith("pubmed");
    expect(await screen.findByLabelText("Base URL")).toHaveValue("https://api.example.com/search/{query}");
    expect(screen.getByLabelText("Method")).toHaveValue("POST");
    expect(screen.getByLabelText("Query template")).toHaveValue('{"q":"{query}"}');
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Updated papers" } });
    fireEvent.click(screen.getByRole("button", { name: "保存数据库" }));
    await waitFor(() => expect(client.updateDatabase).toHaveBeenCalledWith(
      "pubmed",
      expect.objectContaining({
        description: "Updated papers",
        operation: expect.objectContaining({
          name: "search",
          method: "POST",
          url: "https://api.example.com/search/{query}",
        }),
      }),
    ));
    const submitted = vi.mocked(client.updateDatabase).mock.calls[0]?.[1];
    expect(submitted).not.toHaveProperty("operations");
    expect(submitted).not.toHaveProperty("supported_sources");
  });

  it("confirms package deletion and disables builtin database mutation", async () => {
    const client = api();
    client.fetchSkills = vi.fn().mockResolvedValue([
      { name: "builtin_db", display_name: "Builtin DB", version: "1", category: "discovery", description: "Builtin", origin: "builtin", supported_sources: ["builtin_db"], operations: ["search"], enabled: true, user_selectable: true, pipeline_supported: true, available: true, load_error: null },
      { name: "pubmed", display_name: "PubMed", version: "1", category: "discovery", description: "Papers", origin: "package", supported_sources: ["pubmed"], operations: ["search"], enabled: true, user_selectable: true, pipeline_supported: false, available: true, load_error: null },
    ]);
    render(<SettingsPanel open onOpenChange={() => undefined} api={client} />);
    await screen.findByLabelText("API Key");
    fireEvent.click(screen.getByRole("tab", { name: "Databases" }));
    expect(await screen.findByRole("button", { name: "停用 Builtin DB" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "删除 PubMed" }));
    expect(client.deleteDatabase).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(client.deleteDatabase).toHaveBeenCalledWith("pubmed"));
  });
});
