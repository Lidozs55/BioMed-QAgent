import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RuntimeLimitsSettingsSection } from "@/components/settings/sections/RuntimeLimitsSettingsSection";
import { DEFAULT_RUNTIME_LIMITS, type ModelSettings, type SettingsAPIClient } from "@/api/types";

const SETTINGS: ModelSettings = {
  base_url: "https://example.com/v1",
  api_key: "",
  api_key_configured: false,
  model_name: "demo",
  max_tokens: 8192,
  context_window: 131072,
  context_window_source: "catalog",
  safety_reserve_ratio: 0.05,
  safety_reserve_tokens: 6554,
  compaction_trigger_ratio: 0.85,
  compaction_target_ratio: 0.6,
  available_input_tokens: 116326,
  advanced: {},
  run_block_reason: null,
  runtime_limits: DEFAULT_RUNTIME_LIMITS,
  vision_model_id: null,
  vision_model_name: null,
  vision_provider_name: null,
  vision_model_ready: false,
  vision_block_reason: null,
};

function api(saveSettings: SettingsAPIClient["saveSettings"]): SettingsAPIClient {
  return { saveSettings } as SettingsAPIClient;
}

describe("runtime limits settings", () => {
  it("saves a validated seconds-based command timeout", async () => {
    const saveSettings = vi.fn().mockResolvedValue({
      ...SETTINGS,
      runtime_limits: { ...DEFAULT_RUNTIME_LIMITS, command_timeout_seconds: 7200 },
    });
    const onUpdated = vi.fn();
    render(
      <RuntimeLimitsSettingsSection
        api={api(saveSettings)}
        settings={SETTINGS}
        onUpdated={onUpdated}
      />,
    );

    fireEvent.change(screen.getByLabelText("命令执行超时"), { target: { value: "7200" } });
    fireEvent.click(screen.getByRole("button", { name: "保存运行限制" }));

    await waitFor(() => expect(saveSettings).toHaveBeenCalledWith({
      runtime_limits: { ...DEFAULT_RUNTIME_LIMITS, command_timeout_seconds: 7200 },
    }));
    expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({
      runtime_limits: expect.objectContaining({ command_timeout_seconds: 7200 }),
    }));
  });

  it("rejects an out-of-range timeout before calling the API", async () => {
    const saveSettings = vi.fn();
    render(<RuntimeLimitsSettingsSection api={api(saveSettings)} settings={SETTINGS} />);

    fireEvent.change(screen.getByLabelText("命令执行超时"), { target: { value: "86401" } });
    fireEvent.click(screen.getByRole("button", { name: "保存运行限制" }));

    expect(await screen.findByText("请输入 1 到 86400 之间的整数")).toBeInTheDocument();
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("restores server-owned defaults", async () => {
    const saveSettings = vi.fn().mockResolvedValue(SETTINGS);
    render(<RuntimeLimitsSettingsSection api={api(saveSettings)} settings={SETTINGS} />);

    fireEvent.click(screen.getByRole("button", { name: "恢复推荐默认" }));
    await waitFor(() => expect(saveSettings).toHaveBeenCalledWith({ runtime_limits: null }));
  });
});
