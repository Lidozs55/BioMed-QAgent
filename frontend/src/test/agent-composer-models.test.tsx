import type { ComponentProps } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  AgentComposer,
} from "@/components/AgentComposer";
import { OFFLINE_MODEL_FALLBACK, resolveModelChoices } from "@/lib/modelChoices";
import type { ModelInfo } from "@/hooks/useAPI";

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

describe("resolveModelChoices (model endpoint / offline fallback)", () => {
  it("returns the endpoint models when present", () => {
    expect(resolveModelChoices(REAL_MODELS, true)).toEqual({
      choices: REAL_MODELS,
      offline: false,
    });
  });

  it("falls back to the small offline list when the endpoint is unreachable", () => {
    expect(resolveModelChoices([], true)).toEqual({
      choices: OFFLINE_MODEL_FALLBACK,
      offline: true,
    });
    expect(OFFLINE_MODEL_FALLBACK.length).toBeLessThanOrEqual(4);
  });

  it("returns an empty list without an API key", () => {
    expect(resolveModelChoices([], false)).toEqual({
      choices: [],
      offline: false,
    });
  });
});

describe("AgentComposer model selector", () => {
  it("searches the real endpoint models in the popover", async () => {
    renderComposer({ models: REAL_MODELS, hasApiKey: true });
    await openModelSelector();
    expect(screen.getByText("Qwen Max")).toBeInTheDocument();
    expect(screen.getByText("DeepSeek V3")).toBeInTheDocument();
  });

  it("keeps the search box usable with offline fallbacks when the endpoint returns nothing", async () => {
    renderComposer({ models: [], hasApiKey: true });
    await openModelSelector();
    expect(screen.getByText("Qwen Plus")).toBeInTheDocument();
    expect(screen.getByText("离线备选")).toBeInTheDocument();
  });

  it("shows the settings affordance instead of a legacy hardcoded dropdown without an API key", () => {
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
