import type { ComponentProps } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  AgentComposer,
} from "@/components/AgentComposer";
import {
  hasConfiguredModelApiKey,
  managedModelsToChoices,
  resolveActiveModelId,
} from "@/lib/modelChoices";
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
  const trigger = screen.getByRole("combobox", {
    name: "点击选择模型",
  });
  fireEvent.click(trigger);
  // base-ui portals the popup; wait for the search input to mount.
  await waitFor(() => {
    expect(
      screen.getByPlaceholderText("搜索模型..."),
    ).toBeInTheDocument();
  });
}

describe("managedModelsToChoices (configured model list)", () => {
  it("maps managed models into selector choices keyed by the unique managed id", () => {
    const choices = managedModelsToChoices(MANAGED_MODELS);
    expect(choices).toHaveLength(2);
    expect(choices[0]).toMatchObject({
      id: "managed-1",
      name: "Qwen3.7 Flash",
      description: "DashScope · qwen3.7-flash",
      context_window: 262144,
      suggested_max_tokens: 16384,
      recommended: true,
      api_available: true,
    });
    expect(choices[1].id).toBe("managed-2");
    expect(choices[1].recommended).toBe(false);
  });

  it("keeps selector ids unique when providers reuse the same model_id", () => {
    const duplicates: ManagedModelInfo[] = [
      {
        ...MANAGED_MODELS[0],
        id: "managed-a",
        provider_id: "provider-a",
        provider_name: "Provider A",
        model_id: "shared-model",
      },
      {
        ...MANAGED_MODELS[1],
        id: "managed-b",
        provider_id: "provider-b",
        provider_name: "Provider B",
        model_id: "shared-model",
      },
    ];
    const choices = managedModelsToChoices(duplicates);

    expect(choices.map((choice) => choice.id)).toEqual(["managed-a", "managed-b"]);
    expect(new Set(choices.map((choice) => choice.id)).size).toBe(2);
  });
});

describe("active model selection helpers", () => {
  it("prefers an active managed model over a stale settings.model_name", () => {
    expect(resolveActiveModelId(
      { model_name: "qwen-plus", api_key_configured: false },
      [{ ...MANAGED_MODELS[0], active: true }],
    )).toBe("managed-1");
  });

  it("does not present a stale default without credentials or an active model", () => {
    expect(resolveActiveModelId(
      { model_name: "qwen-plus", api_key_configured: false },
      [{ ...MANAGED_MODELS[1], active: false }],
    )).toBe("");
  });

  it("keeps a legacy direct model when no managed model is active but a key exists", () => {
    expect(resolveActiveModelId(
      { model_name: "legacy-model", api_key_configured: true },
      [],
    )).toBe("legacy-model");
  });

  it("reports an API key when settings or any managed choice has one", () => {
    expect(hasConfiguredModelApiKey(
      { api_key_configured: true },
      [],
    )).toBe(true);
    expect(hasConfiguredModelApiKey(
      { api_key_configured: false },
      [{ ...REAL_MODELS[0], api_available: true }],
    )).toBe(true);
    expect(hasConfiguredModelApiKey(
      { api_key_configured: false },
      [{ ...REAL_MODELS[0], api_available: false }],
    )).toBe(false);
  });
});

describe("AgentComposer model selector", () => {
  it("searches the configured models in the popover", async () => {
    renderComposer({ models: REAL_MODELS, hasApiKey: true });
    await openModelSelector();
    expect(screen.getByText("Qwen Max")).toBeInTheDocument();
    expect(screen.getByText("DeepSeek V3")).toBeInTheDocument();
  });

  it("filters by name and id (case-insensitive) and reports the selection", async () => {
    const onModelChange = vi.fn();
    renderComposer({
      models: REAL_MODELS,
      hasApiKey: true,
      onModelChange,
    });
    await openModelSelector();
    const search = screen.getByPlaceholderText("搜索模型...");

    // Filter by name substring.
    fireEvent.change(search, { target: { value: "deepseek" } });
    await waitFor(() => {
      expect(screen.getByText("DeepSeek V3")).toBeInTheDocument();
      expect(screen.queryByText("Qwen Max")).not.toBeInTheDocument();
    });

    // Filter by id substring (case-insensitive), then select the item.
    fireEvent.change(search, { target: { value: "QWEN-MAX" } });
    await waitFor(() => {
      expect(screen.getByText("Qwen Max")).toBeInTheDocument();
      expect(screen.queryByText("DeepSeek V3")).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Qwen Max"));
    await waitFor(() => {
      expect(onModelChange).toHaveBeenCalledWith("qwen-max");
    });
    // The popup closes after selection.
    await waitFor(() => {
      expect(
        screen.queryByPlaceholderText("搜索模型..."),
      ).not.toBeInTheDocument();
    });
  });

  it("shows a no-match empty state while searching", async () => {
    renderComposer({ models: REAL_MODELS, hasApiKey: true });
    await openModelSelector();
    fireEvent.change(screen.getByPlaceholderText("搜索模型..."), {
      target: { value: "no-such-model" },
    });
    await waitFor(() => {
      expect(
        screen.getByText((content) =>
          content.replace(/\u2060/g, "") === "没有匹配的模型",
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText("Qwen Max")).not.toBeInTheDocument();
    });
  });

  it("shows an empty state with a settings link when no models are configured", async () => {
    const onOpenSettings = vi.fn();
    renderComposer({
      models: [],
      hasApiKey: true,
      onOpenSettings,
    });
    await openModelSelector();
    expect(
      screen.getByText((content) =>
        content.replace(/\u2060/g, "") === "暂无可用模型",
      ),
    ).toBeInTheDocument();
    const settings = screen.getByRole("button", { name: "设置" });
    expect(settings).toBeInTheDocument();
    // The footer entry navigates to settings and closes the selector.
    fireEvent.click(settings);
    await waitFor(() => {
      expect(onOpenSettings).toHaveBeenCalledTimes(1);
      expect(
        screen.queryByPlaceholderText("搜索模型..."),
      ).not.toBeInTheDocument();
    });
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

  it("does not render an unknown raw model id when the selected id is stale", () => {
    renderComposer({
      models: managedModelsToChoices([
        { ...MANAGED_MODELS[0], active: true },
      ]),
      hasApiKey: true,
      selectedModelId: "qwen-plus",
    });

    expect(screen.queryByText("qwen-plus")).not.toBeInTheDocument();
    expect(screen.getByText("选择模型")).toBeVisible();
  });
});
