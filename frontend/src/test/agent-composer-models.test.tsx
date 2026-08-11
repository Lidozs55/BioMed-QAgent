import type { ComponentProps } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  AgentComposer,
} from "@/components/AgentComposer";
import { managedModelsToChoices } from "@/lib/modelChoices";
import type { ManagedModelInfo, ModelInfo } from "@/hooks/useAPI";

const REAL_MODELS: ModelInfo[] = [
  {
    id: "qwen-max",
    name: "Qwen Max",
    description: "旗舰模型",
    context_window: 131072,
    suggested_max_tokens: 8192,
    capabilities: { text: true, image: true, video: false, audio: false },
    recommended: true,
    api_available: true,
    capability_source: "catalog",
  },
  {
    id: "deepseek-v3",
    name: "DeepSeek V3",
    description: "推理模型",
    context_window: 65536,
    suggested_max_tokens: 4096,
    capabilities: { text: true, image: false, video: false, audio: false },
    recommended: false,
    api_available: true,
    capability_source: "api",
  },
];

const MANAGED_MODELS: ManagedModelInfo[] = [
  {
    id: "managed-1",
    provider_id: "provider-1",
    provider_name: "DashScope",
    provider_base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    provider_api_key_configured: true,
    model_id: "qwen3.7-flash",
    name: "Qwen3.7 Flash",
    description: "",
    context_window: 262144,
    max_output_tokens: 32768,
    suggested_max_tokens: 16384,
    capabilities: { text: true, image: false, video: false, audio: false },
    params: {},
    param_specs: [],
    source: "api",
    active: true,
    created_at: "2026-08-11T00:00:00+00:00",
    updated_at: "2026-08-11T00:00:00+00:00",
  },
  {
    id: "managed-2",
    provider_id: "provider-2",
    provider_name: "DeepSeek",
    provider_base_url: "https://api.deepseek.com/v1",
    provider_api_key_configured: true,
    model_id: "deepseek-chat",
    name: "DeepSeek Chat",
    description: "",
    context_window: 65536,
    max_output_tokens: 8192,
    suggested_max_tokens: 8192,
    capabilities: { text: true, image: false, video: false, audio: false },
    params: {},
    param_specs: [],
    source: "api",
    active: false,
    created_at: "2026-08-11T00:00:00+00:00",
    updated_at: "2026-08-11T00:00:00+00:00",
  },
];

function renderComposer(
  props: Partial<ComponentProps<typeof AgentComposer>> = {},
) {
  return render(
    <AgentComposer
      value=""
      onChange={() => undefined}
      onSubmit={() => undefined}
      onKeyDown={() => undefined}
      placeholder="输入研究目标..."
      ariaLabel="研究目标"
      {...props}
    />,
  );
}

async function openModelSelector() {
  const trigger = screen.getByRole("button", { name: "点击选择模型" });
  fireEvent.click(trigger);
  // base-ui portals the popup; wait for the search input to mount.
  await waitFor(() => {
    expect(
      screen.getByPlaceholderText("搜索模型..."),
    ).toBeInTheDocument();
  });
}

describe("managedModelsToChoices (configured model list)", () => {
  it("maps managed models into selector choices keyed by model_id", () => {
    const choices = managedModelsToChoices(MANAGED_MODELS);
    expect(choices).toHaveLength(2);
    expect(choices[0]).toMatchObject({
      id: "qwen3.7-flash",
      name: "Qwen3.7 Flash",
      description: "DashScope · qwen3.7-flash",
      context_window: 262144,
      suggested_max_tokens: 16384,
      recommended: true,
      api_available: true,
    });
    expect(choices[1].id).toBe("deepseek-chat");
    expect(choices[1].recommended).toBe(false);
  });
});

describe("AgentComposer model selector", () => {
  it("searches the configured models in the popover", async () => {
    renderComposer({ models: REAL_MODELS, hasApiKey: true });
    await openModelSelector();
    expect(screen.getByText("Qwen Max")).toBeInTheDocument();
    expect(screen.getByText("DeepSeek V3")).toBeInTheDocument();
  });

  it("shows an empty state with a settings link when no models are configured", async () => {
    renderComposer({ models: [], hasApiKey: true });
    await openModelSelector();
    expect(screen.getByText("暂无可用模型")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "设置" })).toBeInTheDocument();
  });

  it("shows the settings affordance without an API key", () => {
    renderComposer({ hasApiKey: false });
    expect(
      screen.getByRole("button", { name: /未配置 API Key/ }),
    ).toBeInTheDocument();
    // The legacy LEGACY_MODELS dropdown trigger is gone.
    expect(
      screen.queryByRole("button", { name: "切换主模型" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("主模型")).not.toBeInTheDocument();
  });
});
