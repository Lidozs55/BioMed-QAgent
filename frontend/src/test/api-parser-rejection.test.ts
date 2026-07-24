import { describe, expect, it, vi } from "vitest";

import { createAPIClient, type FetchLike } from "@/hooks/useAPI";
import { APIError } from "@/hooks/settingsContracts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/* ------------------------------------------------------------------ */
/*  Malformed response shape rejection                                 */
/* ------------------------------------------------------------------ */
describe("malformed settings response rejection", () => {
  it("rejects empty object {} for fetchSettings", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({}));
    const api = createAPIClient({ fetcher });
    await expect(api.fetchSettings()).rejects.toThrow(APIError);
  });

  it("rejects settings with wrong-typed context_window (string)", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({
      base_url: "", api_key: "", api_key_configured: true, model_name: "", max_tokens: 1,
      context_window: "large", context_window_source: "catalog",
      safety_reserve_ratio: 0.05, safety_reserve_tokens: 16384,
      compaction_trigger_ratio: 0.85, compaction_target_ratio: 0.60,
      available_input_tokens: 1, advanced: {},
    }));
    const api = createAPIClient({ fetcher });
    await expect(api.fetchSettings()).rejects.toThrow(APIError);
  });

  it("rejects settings with missing context_window_source", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({
      base_url: "", api_key: "", api_key_configured: true, model_name: "", max_tokens: 1,
      context_window: 32768,
      safety_reserve_ratio: 0.05, safety_reserve_tokens: 16384,
      compaction_trigger_ratio: 0.85, compaction_target_ratio: 0.60,
      available_input_tokens: 1, advanced: {},
    }));
    const api = createAPIClient({ fetcher });
    await expect(api.fetchSettings()).rejects.toThrow(APIError);
  });

  it("rejects settings with invalid source value", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({
      base_url: "", api_key: "", api_key_configured: true, model_name: "", max_tokens: 1,
      context_window: 32768, context_window_source: "invalid",
      safety_reserve_ratio: 0.05, safety_reserve_tokens: 16384,
      compaction_trigger_ratio: 0.85, compaction_target_ratio: 0.60,
      available_input_tokens: 1, advanced: {},
    }));
    const api = createAPIClient({ fetcher });
    await expect(api.fetchSettings()).rejects.toThrow(APIError);
  });

  it("accepts unavailable unknown-model capacity from the settings server", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({
      base_url: "", api_key: "", api_key_configured: true, model_name: "", max_tokens: 1,
      context_window: 0, context_window_source: "unknown",
      safety_reserve_ratio: 0.05, safety_reserve_tokens: 0,
      compaction_trigger_ratio: 0.85, compaction_target_ratio: 0.60,
      available_input_tokens: 0, advanced: {},
    }));
    const api = createAPIClient({ fetcher });
    await expect(api.fetchSettings()).resolves.toMatchObject({
      context_window: 0,
      context_window_source: "unknown",
      safety_reserve_tokens: 0,
      available_input_tokens: 0,
    });
  });

  it("rejects unknown source paired with guessed capacity", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({
      base_url: "", api_key: "", api_key_configured: true, model_name: "", max_tokens: 1,
      context_window: 32768, context_window_source: "unknown",
      safety_reserve_ratio: 0.05, safety_reserve_tokens: 16384,
      compaction_trigger_ratio: 0.85, compaction_target_ratio: 0.60,
      available_input_tokens: 16383, advanced: {},
    }));
    await expect(createAPIClient({ fetcher }).fetchSettings()).rejects.toThrow(APIError);
  });

  it("rejects vendors response with string instead of array", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ vendors: "bad" }));
    const api = createAPIClient({ fetcher });
    await expect(api.fetchVendors()).rejects.toThrow(APIError);
  });

  it("rejects vendors response with missing vendors key", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({}));
    const api = createAPIClient({ fetcher });
    await expect(api.fetchVendors()).rejects.toThrow(APIError);
  });

  it("rejects models response with object instead of array", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ models: {} }));
    const api = createAPIClient({ fetcher });
    await expect(api.fetchModels({ baseUrl: "https://test.com/v1" })).rejects.toThrow(APIError);
  });

  it("rejects valid-shaped settings with missing advanced object", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({
      base_url: "", api_key: "", api_key_configured: true, model_name: "", max_tokens: 1,
      context_window: 32768, context_window_source: "catalog",
      safety_reserve_ratio: 0.05, safety_reserve_tokens: 16384,
      compaction_trigger_ratio: 0.85, compaction_target_ratio: 0.60,
      available_input_tokens: 1,
    }));
    const api = createAPIClient({ fetcher });
    await expect(api.fetchSettings()).rejects.toThrow(APIError);
  });
});

/* ------------------------------------------------------------------ */
/*  Malformed optional field rejection                                 */
/* ------------------------------------------------------------------ */
describe("malformed optional field rejection", () => {
  it("rejects settings with wrong-typed advanced.temperature (string)", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({
      base_url: "", api_key: "sk-...", api_key_configured: true, model_name: "", max_tokens: 1,
      context_window: 32768, context_window_source: "catalog",
      safety_reserve_ratio: 0.05, safety_reserve_tokens: 16384,
      compaction_trigger_ratio: 0.85, compaction_target_ratio: 0.60,
      available_input_tokens: 4096,
      advanced: { temperature: "hot" },
    }));
    const api = createAPIClient({ fetcher });
    await expect(api.fetchSettings()).rejects.toThrow(APIError);
  });

  it("rejects settings with wrong-typed advanced.enable_search (number)", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({
      base_url: "", api_key: "sk-...", api_key_configured: true, model_name: "", max_tokens: 1,
      context_window: 32768, context_window_source: "catalog",
      safety_reserve_ratio: 0.05, safety_reserve_tokens: 16384,
      compaction_trigger_ratio: 0.85, compaction_target_ratio: 0.60,
      available_input_tokens: 4096,
      advanced: { enable_search: 1 },
    }));
    const api = createAPIClient({ fetcher });
    await expect(api.fetchSettings()).rejects.toThrow(APIError);
  });

  it("rejects vendor entry with wrong recommended type (string)", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({
      vendors: [{ id: "v1", name: "V1", base_url: "https://x.com", description: "", recommended: "yes" }],
    }));
    const api = createAPIClient({ fetcher });
    await expect(api.fetchVendors()).rejects.toThrow(APIError);
  });

  it("rejects model entry with wrong context_window type (string)", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({
      models: [{ id: "m1", name: "M1", description: "", context_window: "32k", suggested_max_tokens: 4096, recommended: false, api_available: true, capability_source: "catalog", capabilities: { text: true, image: false, video: false, audio: false } }],
    }));
    const api = createAPIClient({ fetcher });
    await expect(api.fetchModels({ baseUrl: "https://test.com/v1" })).rejects.toThrow(APIError);
  });

  it("rejects model entry with wrong recommended (number not boolean)", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({
      models: [{ id: "m1", name: "M1", description: "", context_window: 32768, suggested_max_tokens: 4096, recommended: 1, api_available: true, capability_source: "catalog", capabilities: { text: true, image: false, video: false, audio: false } }],
    }));
    const api = createAPIClient({ fetcher });
    await expect(api.fetchModels({ baseUrl: "https://test.com/v1" })).rejects.toThrow(APIError);
  });

  it("rejects model with malformed capabilities (string not object)", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({
      models: [{ id: "m1", name: "M1", description: "", context_window: 32768, suggested_max_tokens: 4096, recommended: false, api_available: true, capability_source: "catalog", capabilities: "yes" }],
    }));
    const api = createAPIClient({ fetcher });
    await expect(api.fetchModels({ baseUrl: "https://test.com/v1" })).rejects.toThrow(APIError);
  });

  it("rejects model with null capabilities", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({
      models: [{ id: "m1", name: "M1", description: "", context_window: 32768, suggested_max_tokens: 4096, recommended: false, api_available: true, capability_source: "catalog", capabilities: null }],
    }));
    const api = createAPIClient({ fetcher });
    await expect(api.fetchModels({ baseUrl: "https://test.com/v1" })).rejects.toThrow(APIError);
  });

  it("rejects model with wrong-typed capability flag (string not boolean)", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({
      models: [{ id: "m1", name: "M1", description: "", context_window: 32768, suggested_max_tokens: 4096, recommended: false, api_available: true, capability_source: "catalog", capabilities: { text: "yes", image: true, video: false, audio: false } }],
    }));
    const api = createAPIClient({ fetcher });
    await expect(api.fetchModels({ baseUrl: "https://test.com/v1" })).rejects.toThrow(APIError);
  });

  it("rejects model with missing recommended (required by backend contract)", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({
      models: [{ id: "m1", name: "M1", description: "", context_window: 32768, suggested_max_tokens: 4096, api_available: true, capability_source: "catalog", capabilities: { text: true, image: false, video: false, audio: false } }],
    }));
    const api = createAPIClient({ fetcher });
    await expect(api.fetchModels({ baseUrl: "https://test.com/v1" })).rejects.toThrow(APIError);
  });

  it("rejects model with invalid capability_source ('other')", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({
      models: [{ id: "m1", name: "M1", description: "", context_window: 32768, suggested_max_tokens: 4096, recommended: false, api_available: true, capability_source: "other", capabilities: { text: true, image: false, video: false, audio: false } }],
    }));
    const api = createAPIClient({ fetcher });
    await expect(api.fetchModels({ baseUrl: "https://test.com/v1" })).rejects.toThrow(APIError);
  });
});

/* ------------------------------------------------------------------ */
/*  Valid masked-key and optional field preservation                    */
/* ------------------------------------------------------------------ */
describe("valid response preservation", () => {
  it("accepts valid settings with masked API key and optional advanced fields absent", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({
      base_url: "https://example.com/v1", api_key: "sk-****", api_key_configured: true,
      model_name: "demo", max_tokens: 4096,
      context_window: 32768, context_window_source: "catalog",
      safety_reserve_ratio: 0.05, safety_reserve_tokens: 16384,
      compaction_trigger_ratio: 0.85, compaction_target_ratio: 0.60,
      available_input_tokens: 4096,
      advanced: {},
    }));
    const api = createAPIClient({ fetcher });
    const settings = await api.fetchSettings();
    expect(settings.api_key).toBe("sk-****");
    expect(settings.api_key_configured).toBe(true);
    expect(settings.advanced.temperature).toBeUndefined();
    expect(settings.advanced.enable_search).toBeUndefined();
  });

  it("accepts valid vendor with all fields preserved", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({
      vendors: [{ id: "v1", name: "V1", base_url: "https://x.com", description: "desc", recommended: true }],
    }));
    const api = createAPIClient({ fetcher });
    const vendors = await api.fetchVendors();
    expect(vendors).toHaveLength(1);
    expect(vendors[0].id).toBe("v1");
    expect(vendors[0].recommended).toBe(true);
  });

  it("accepts valid model with all required fields and capabilities preserved", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({
      models: [{
        id: "m1", name: "M1", description: "desc", context_window: 131072, suggested_max_tokens: 8192,
        recommended: true, api_available: false, capability_source: "catalog",
        capabilities: { text: true, image: false, video: true, audio: false },
      }],
    }));
    const api = createAPIClient({ fetcher });
    const models = await api.fetchModels({ baseUrl: "https://test.com/v1" });
    expect(models).toHaveLength(1);
    expect(models[0].recommended).toBe(true);
    expect(models[0].api_available).toBe(false);
    expect(models[0].capability_source).toBe("catalog");
    expect(models[0].capabilities).toEqual({ text: true, image: false, video: true, audio: false });
  });
});
