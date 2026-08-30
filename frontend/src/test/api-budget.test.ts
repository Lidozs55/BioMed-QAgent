import { describe, expect, it, vi } from "vitest";

import { createAPIClient, type FetchLike } from "@/hooks/useAPI";
import { APIError, normalizeErrorDetail } from "@/api/errors";
import type { ModelSettings } from "@/api/types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Extract the request body string from a FetchLike call argument using `Reflect.get` (no assertion). */
function requestBody(fetcher: ReturnType<typeof vi.fn<FetchLike>>, callIndex: number): string {
  const init = fetcher.mock.calls[callIndex]?.[1];
  if (!init || typeof init !== "object") return "";
  if (!("body" in init)) return "";
  const b = Reflect.get(init, "body");
  return typeof b === "string" ? b : "";
}

describe("API settings/catalog management contracts", () => {
  it("routes settings/vendors/models/skills to correct URLs with correct bodies", async () => {
    const fetcher = vi.fn<FetchLike>()
      .mockResolvedValueOnce(jsonResponse({
        base_url: "", api_key: "", api_key_configured: false,
        model_name: "", max_tokens: 8192,
        context_window: 32768, context_window_source: "catalog",
        safety_reserve_ratio: 0.05, safety_reserve_tokens: 16384,
        compaction_trigger_ratio: 0.85, compaction_target_ratio: 0.60,
        available_input_tokens: 4096, vision_model_ready: false, advanced: {},
      }))
      .mockResolvedValueOnce(jsonResponse({ vendors: [] }))
      .mockResolvedValueOnce(jsonResponse({ models: [], total_count: 0 }))
      .mockResolvedValueOnce(jsonResponse({ databases: [] }));
    const api = createAPIClient({ fetcher });
    await api.fetchSettings();
    await api.fetchVendors();
    await api.fetchModels({ baseUrl: "https://preview.test/v1", apiKey: "secret" });
    await api.fetchDatabases();
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/settings", "/api/v1/vendors", "/api/v1/models",
      "/api/v1/databases",
    ]);
    expect(fetcher.mock.calls[2]?.[1]).toEqual({
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preview_base_url: "https://preview.test/v1", preview_api_key: "secret" }),
    });
  });
});

describe("API budget field contracts", () => {
  it("accepts unavailable unknown-model capacity from the settings server", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({
      base_url: "https://example.com/v1", api_key: "", api_key_configured: false,
      model_name: "provider-only", max_tokens: 4096, context_window: 0, context_window_source: "unknown",
      safety_reserve_ratio: 0.05, safety_reserve_tokens: 0,
      compaction_trigger_ratio: 0.85, compaction_target_ratio: 0.60,
      available_input_tokens: 0, vision_model_ready: false, advanced: {},
    }));
    const settings = await createAPIClient({ fetcher }).fetchSettings();
    expect(settings.context_window_source).toBe("unknown");
    expect(settings.context_window).toBe(0);
    expect(settings.safety_reserve_tokens).toBe(0);
    expect(settings.available_input_tokens).toBe(0);
  });

  it("exposes budget fields from fetchSettings", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({
      base_url: "https://example.com/v1", api_key: "sk-a...z", api_key_configured: true,
      model_name: "demo", max_tokens: 4096, context_window: 32768, context_window_source: "catalog",
      safety_reserve_ratio: 0.05, safety_reserve_tokens: 16384,
      compaction_trigger_ratio: 0.85, compaction_target_ratio: 0.60,
      available_input_tokens: 4096, vision_model_ready: false, advanced: {},
    }));
    const api = createAPIClient({ fetcher });
    const settings: ModelSettings = await api.fetchSettings();
    expect(settings.context_window).toBe(32768);
    expect(settings.context_window_source).toBe("catalog");
    expect(settings.safety_reserve_ratio).toBe(0.05);
    expect(settings.safety_reserve_tokens).toBe(16384);
    expect(settings.compaction_trigger_ratio).toBe(0.85);
    expect(settings.compaction_target_ratio).toBe(0.60);
    expect(settings.available_input_tokens).toBe(4096);
  });

  it("sends only dirty budget fields in PUT body", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({
      base_url: "https://example.com/v1", api_key: "sk-a...z", api_key_configured: true,
      model_name: "demo", max_tokens: 4096, context_window: 32768, context_window_source: "catalog",
      safety_reserve_ratio: 0.05, safety_reserve_tokens: 16384,
      compaction_trigger_ratio: 0.85, compaction_target_ratio: 0.60,
      available_input_tokens: 4096, vision_model_ready: false, advanced: {},
    }));
    const api = createAPIClient({ fetcher });
    await api.saveSettings({ safety_reserve_ratio: 0.10 });
    const callBody = JSON.parse(requestBody(fetcher, 0));
    expect(callBody).toEqual({ safety_reserve_ratio: 0.10 });
  });

  it("supports context_window: null in PUT body", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({
      base_url: "https://example.com/v1", api_key: "sk-a...z", api_key_configured: true,
      model_name: "demo", max_tokens: 4096, context_window: 32768, context_window_source: "catalog",
      safety_reserve_ratio: 0.05, safety_reserve_tokens: 16384,
      compaction_trigger_ratio: 0.85, compaction_target_ratio: 0.60,
      available_input_tokens: 4096, vision_model_ready: false, advanced: {},
    }));
    const api = createAPIClient({ fetcher });
    await api.saveSettings({ context_window: null });
    const callBody = JSON.parse(requestBody(fetcher, 0));
    expect(callBody).toEqual({ context_window: null });
  });
});

describe("normalizeErrorDetail", () => {
  it("returns string detail unchanged", () => {
    expect(normalizeErrorDetail(400, "bad request")).toBe("bad request");
  });

  it("joins structured FastAPI 422 detail array", () => {
    const detail = [
      { loc: ["body", "safety_reserve_ratio"], msg: "ensure this value is less than or equal to 0.25", type: "value_error" },
      { loc: ["body", "max_tokens"], msg: "ensure this value is greater than 0", type: "value_error" },
    ];
    expect(normalizeErrorDetail(422, detail)).toBe("ensure this value is less than or equal to 0.25; ensure this value is greater than 0");
  });

  it("uses generic message for unknown detail shapes", () => {
    expect(normalizeErrorDetail(500, { foo: "bar" })).toBe("API request failed (500)");
  });

  it("uses generic message for non-array non-string detail", () => {
    expect(normalizeErrorDetail(422, 42)).toBe("API request failed (422)");
  });
});

describe("APIError", () => {
  it("normalizes structured FastAPI detail", () => {
    const err = new APIError(422, [{ loc: ["body", "x"], msg: "field required", type: "value_error" }]);
    expect(err.message).toBe("field required");
    expect(err.status).toBe(422);
  });

  it("uses string detail directly", () => {
    const err = new APIError(400, "bad request");
    expect(err.message).toBe("bad request");
    expect(err.status).toBe(400);
  });
});
