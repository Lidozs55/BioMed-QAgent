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
    fetchSkill: vi.fn().mockResolvedValue({ manifest: {}, current_version: "1", versions: ["1"], package_kind: "manifest", warning: null, available: true, load_error: null }),
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
});
