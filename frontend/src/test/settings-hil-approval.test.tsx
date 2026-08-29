import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { HilApprovalSettingsSection } from "@/components/settings/sections/HilApprovalSettingsSection";
import type { HILApprovalSettings, SettingsAPIClient } from "@/api/types";

const SETTINGS: HILApprovalSettings = {
  schema_version: "1.0",
  default_mode: "human_review",
  review_modes: {
    permission: "auto_approve",
    field_mapping: "llm_pre_review",
  },
};

function api(overrides: Partial<SettingsAPIClient> = {}): SettingsAPIClient {
  return {
    fetchHilApproval: vi.fn().mockResolvedValue(SETTINGS),
    saveHilApproval: vi.fn().mockResolvedValue(SETTINGS),
    ...overrides,
  } as SettingsAPIClient;
}

function clickMode(label: string, modeLabel: string): void {
  const group = screen.getByRole("group", { name: label });
  const buttons = Array.from(group.querySelectorAll("button"));
  const target = buttons.find((button) => button.textContent?.includes(modeLabel));
  if (!target) throw new Error(`mode ${modeLabel} not found in ${label}`);
  fireEvent.click(target);
}

describe("HIL approval settings section", () => {
  it("renders the three-tier assignment from the server", async () => {
    render(<HilApprovalSettingsSection api={api()} />);

    await waitFor(() => expect(screen.getByText("审批权限分配")).toBeInTheDocument());
    expect(screen.getByText("凭据 / 工具授权")).toBeInTheDocument();
    // The three publication-boundary scopes are pinned badges.
    expect(screen.getAllByText("始终人工审批")).toHaveLength(3);
  });

  it("saves a default-mode change", async () => {
    const saveHilApproval = vi.fn().mockResolvedValue({
      ...SETTINGS,
      default_mode: "llm_pre_review",
    });
    render(<HilApprovalSettingsSection api={api({ saveHilApproval })} />);

    await waitFor(() => expect(screen.getByText("审批权限分配")).toBeInTheDocument());
    clickMode("默认 HIL 审批档位", "大模型初审");

    await waitFor(() => expect(saveHilApproval).toHaveBeenCalledWith({ default_mode: "llm_pre_review" }));
  });

  it("saves a per-scope mode change", async () => {
    const saveHilApproval = vi.fn().mockResolvedValue(SETTINGS);
    render(<HilApprovalSettingsSection api={api({ saveHilApproval })} />);

    await waitFor(() => expect(screen.getByText("审批权限分配")).toBeInTheDocument());
    clickMode("字段映射审批档位", "人工审批");

    await waitFor(() =>
      expect(saveHilApproval).toHaveBeenCalledWith({ review_modes: { field_mapping: "human_review" } }),
    );
  });

  it("keeps human-mandatory scopes pinned to human review and non-interactive", async () => {
    render(<HilApprovalSettingsSection api={api()} />);

    await waitFor(() => expect(screen.getByText("审批权限分配")).toBeInTheDocument());
    const group = screen.getByRole("group", { name: "发布验收审批档位" });
    for (const button of Array.from(group.querySelectorAll("button"))) {
      expect(button).toBeDisabled();
      if (!button.textContent?.includes("人工审批")) continue;
      expect(button.getAttribute("aria-pressed")).toBe("true");
    }
    clickMode("发布验收审批档位", "不审批");
  });
});
