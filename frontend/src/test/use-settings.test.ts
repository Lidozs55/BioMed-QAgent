import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSettings } from "@/hooks/useSettings";

function jsonOk(body: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("useSettings", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads settings and vendors on mount", async () => {
    fetchSpy
      .mockReturnValueOnce(jsonOk({ base_url: "https://test.url", api_key: "sk-xxxx", model_name: "qwen-plus", max_tokens: 4096, temperature: 0.7, top_p: 1.0, repetition_penalty: 1.0, enable_search: false, thinking_mode: false }))
      .mockReturnValueOnce(jsonOk([{ id: "dashscope", name: "DashScope", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", description: "Default", recommended: true }]))
      .mockReturnValueOnce(jsonOk({ models: [{ id: "qwen-plus", name: "Qwen Plus" }], total_count: 1, api_source: null }));

    const { result } = renderHook(() => useSettings());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.settings?.base_url).toBe("https://test.url");
    expect(result.current.settings?.api_key).toBe("sk-xxxx");
    expect(fetchSpy).toHaveBeenNthCalledWith(1, "/api/v1/settings", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("does not include API key in GET model URL", async () => {
    fetchSpy
      .mockReturnValueOnce(jsonOk({ base_url: "https://test.url", api_key: "sk-xxxx", model_name: "qwen-plus", max_tokens: 4096, temperature: 0.7, top_p: 1.0, repetition_penalty: 1.0, enable_search: false, thinking_mode: false }))
      .mockReturnValueOnce(jsonOk([]))
      .mockReturnValueOnce(jsonOk({ models: [{ id: "qwen-plus", name: "Qwen Plus" }], total_count: 1, api_source: null }))
      .mockReturnValueOnce(jsonOk({ models: [{ id: "qwen-plus", name: "Qwen Plus" }], total_count: 1, api_source: null }));

    const { result } = renderHook(() => useSettings());

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.fetchModels();
    });

    // GET /api/v1/models should not contain any api_key parameter
    const modelsCall = fetchSpy.mock.calls.find(
      (call: unknown[]) => String(call[0]).includes("/api/v1/models"),
    );
    expect(modelsCall).toBeDefined();
    const url = String((modelsCall as [string])[0]);
    expect(url).not.toContain("api_key");
    expect(url).not.toContain("preview_api_key");
  });

  it("omits unchanged masked key from POST payload", async () => {
    const existingSettings = { base_url: "https://test.url", api_key: "sk-xxxx", model_name: "qwen-plus", max_tokens: 4096, temperature: 0.7, top_p: 1.0, repetition_penalty: 1.0, enable_search: false, thinking_mode: false };
    fetchSpy
      .mockReturnValueOnce(jsonOk(existingSettings))
      .mockReturnValueOnce(jsonOk([]))
      .mockReturnValueOnce(jsonOk({ models: [{ id: "qwen-plus", name: "Qwen Plus" }], total_count: 1, api_source: null }))
      .mockReturnValueOnce(jsonOk(existingSettings))
      .mockReturnValueOnce(jsonOk({ models: [{ id: "qwen-max", name: "Qwen Max" }], total_count: 1, api_source: null }));

    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // The existing api_key is "sk-xxxx" (masked), the user hasn't changed it.
    // When saving with only model_name changed, the POST should NOT include api_key.
    await act(async () => {
      await result.current.updateSettings({ model_name: "qwen-max" });
    });

    // Find the POST /api/v1/settings call
    const postCall = fetchSpy.mock.calls.find(
      (call: unknown[]) => String(call[0]) === "/api/v1/settings" && (call[1] as Record<string, unknown>)?.method === "POST",
    );
    expect(postCall).toBeDefined();
    const body = JSON.parse((postCall as [string, Record<string, unknown>])[1].body as string);
    expect(body.api_key).toBeUndefined();
    expect(body.model_name).toBe("qwen-max");
  });

  it("refreshModels calls key-free model URL", async () => {
    fetchSpy
      .mockReturnValueOnce(jsonOk({ base_url: "https://test.url", api_key: "sk-xxxx", model_name: "qwen-plus", max_tokens: 4096, temperature: 0.7, top_p: 1.0, repetition_penalty: 1.0, enable_search: false, thinking_mode: false }))
      .mockReturnValueOnce(jsonOk([]))
      .mockReturnValueOnce(jsonOk({ models: [{ id: "qwen-plus", name: "Qwen Plus" }], total_count: 1, api_source: null }))
      .mockReturnValueOnce(jsonOk({ models: [{ id: "qwen-plus", name: "Qwen Plus" }], total_count: 1, api_source: null }));

    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.refreshModels();
    });

    const refreshCall = fetchSpy.mock.calls.find(
      (call: unknown[]) => String(call[0]).includes("/api/v1/models"),
    );
    expect(refreshCall).toBeDefined();
    const url = String((refreshCall as [string])[0]);
    expect(url).toContain("use_current_settings=true");
    expect(url).not.toContain("api_key");
  });

  it("auto-refreshes models on mount when base_url and api_key are configured", async () => {
    const modelsResponse = { models: [{ id: "qwen-plus", name: "Qwen Plus" }], total_count: 1, api_source: null };
    fetchSpy
      .mockReturnValueOnce(jsonOk({ base_url: "https://test.url", api_key: "sk-xxxx", model_name: "qwen-plus", max_tokens: 4096, temperature: 0.7, top_p: 1.0, repetition_penalty: 1.0, enable_search: false, thinking_mode: false }))
      .mockReturnValueOnce(jsonOk([]))
      .mockReturnValueOnce(jsonOk(modelsResponse));

    const { result } = renderHook(() => useSettings());

    await waitFor(() => {
      expect(result.current.models.length).toBeGreaterThan(0);
    });

    expect(result.current.models[0].id).toBe("qwen-plus");
    // Verify the models call was to the refresh endpoint (key-free, use_current_settings=true)
    const modelsCall = fetchSpy.mock.calls.find(
      (call: unknown[]) => String(call[0]).includes("/api/v1/models"),
    );
    expect(modelsCall).toBeDefined();
    const url = String((modelsCall as [string])[0]);
    expect(url).toContain("use_current_settings=true");
    expect(url).not.toContain("api_key");
  });

  it("does not auto-refresh models when base_url is empty", async () => {
    fetchSpy
      .mockReturnValueOnce(jsonOk({ base_url: "", api_key: "sk-xxxx", model_name: "qwen-plus", max_tokens: 4096, temperature: 0.7, top_p: 1.0, repetition_penalty: 1.0, enable_search: false, thinking_mode: false }))
      .mockReturnValueOnce(jsonOk([]));

    const { result } = renderHook(() => useSettings());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.models).toEqual([]);
    const modelsCall = fetchSpy.mock.calls.find(
      (call: unknown[]) => String(call[0]).includes("/api/v1/models"),
    );
    expect(modelsCall).toBeUndefined();
  });

  it("does not auto-refresh models when api_key is empty", async () => {
    fetchSpy
      .mockReturnValueOnce(jsonOk({ base_url: "https://test.url", api_key: "", model_name: "qwen-plus", max_tokens: 4096, temperature: 0.7, top_p: 1.0, repetition_penalty: 1.0, enable_search: false, thinking_mode: false }))
      .mockReturnValueOnce(jsonOk([]));

    const { result } = renderHook(() => useSettings());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.models).toEqual([]);
    const modelsCall = fetchSpy.mock.calls.find(
      (call: unknown[]) => String(call[0]).includes("/api/v1/models"),
    );
    expect(modelsCall).toBeUndefined();
  });

  it("passes AbortSignal to fetch for model requests", async () => {
    fetchSpy
      .mockReturnValueOnce(jsonOk({ base_url: "https://test.url", api_key: "sk-xxxx", model_name: "qwen-plus", max_tokens: 4096, temperature: 0.7, top_p: 1.0, repetition_penalty: 1.0, enable_search: false, thinking_mode: false }))
      .mockReturnValueOnce(jsonOk([]))
      .mockReturnValueOnce(jsonOk({ models: [{ id: "qwen-plus", name: "Qwen Plus" }], total_count: 1, api_source: null }));

    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));

    fetchSpy.mockReset();
    fetchSpy.mockReturnValue(jsonOk({ models: [], total_count: 0, api_source: null }));

    await act(async () => {
      await result.current.fetchModels();
    });

    const modelCall = fetchSpy.mock.calls.find(
      (call: unknown[]) => String(call[0]).includes("/api/v1/models"),
    );
    expect(modelCall).toBeDefined();
    const options = (modelCall as [string, RequestInit])[1];
    expect(options).toBeDefined();
    expect(options!.signal).toBeInstanceOf(AbortSignal);
  });

  it("aborts previous fetchModels when called again", async () => {
    fetchSpy
      .mockReturnValueOnce(jsonOk({ base_url: "https://test.url", api_key: "sk-xxxx", model_name: "qwen-plus", max_tokens: 4096, temperature: 0.7, top_p: 1.0, repetition_penalty: 1.0, enable_search: false, thinking_mode: false }))
      .mockReturnValueOnce(jsonOk([]))
      .mockReturnValueOnce(jsonOk({ models: [{ id: "qwen-plus", name: "Qwen Plus" }], total_count: 1, api_source: null }));

    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));

    fetchSpy.mockReset();

    let signal1!: AbortSignal;
    let callCount = 0;
    fetchSpy.mockImplementation((_url: string, options?: RequestInit) => {
      callCount++;
      if (callCount === 1) {
        if (options?.signal) signal1 = options.signal as AbortSignal;
        return new Promise<Response>(() => {}); // never resolves
      }
      return jsonOk({ models: [{ id: "qwen-max", name: "Qwen Max" }], total_count: 1, api_source: null });
    });

    // Start first request (never resolves)
    act(() => { result.current.fetchModels(); });

    // Start second request (resolves)
    await act(async () => {
      await result.current.fetchModels();
    });

    // First signal should be aborted
    expect(signal1.aborted).toBe(true);
    expect(result.current.models[0]?.id).toBe("qwen-max");
  });

  it("sets error state when model request fails", async () => {
    fetchSpy
      .mockReturnValueOnce(jsonOk({ base_url: "https://test.url", api_key: "sk-xxxx", model_name: "qwen-plus", max_tokens: 4096, temperature: 0.7, top_p: 1.0, repetition_penalty: 1.0, enable_search: false, thinking_mode: false }))
      .mockReturnValueOnce(jsonOk([]))
      .mockReturnValueOnce(jsonOk({ models: [{ id: "qwen-plus", name: "Qwen Plus" }], total_count: 1, api_source: null }));

    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));

    fetchSpy.mockReset();
    fetchSpy.mockRejectedValue(new Error("Provider rejected"));

    await act(async () => {
      await result.current.fetchModels();
    });

    expect(result.current.error).toBe("Provider rejected");
  });

  it("preserves previous provider error when request is aborted", async () => {
    fetchSpy
      .mockReturnValueOnce(jsonOk({ base_url: "https://test.url", api_key: "sk-xxxx", model_name: "qwen-plus", max_tokens: 4096, temperature: 0.7, top_p: 1.0, repetition_penalty: 1.0, enable_search: false, thinking_mode: false }))
      .mockReturnValueOnce(jsonOk([]))
      .mockReturnValueOnce(jsonOk({ models: [{ id: "qwen-plus", name: "Qwen Plus" }], total_count: 1, api_source: null }));

    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));

    fetchSpy.mockReset();

    // First, cause a real provider error
    fetchSpy.mockRejectedValue(new Error("Provider rejected"));
    await act(async () => {
      await result.current.fetchModels();
    });
    expect(result.current.error).toBe("Provider rejected");

    // Now abort — AbortError should NOT overwrite the error
    fetchSpy.mockRejectedValue(new DOMException("Aborted", "AbortError"));
    await act(async () => {
      await result.current.fetchModels();
    });

    // Previous error is preserved
    expect(result.current.error).toBe("Provider rejected");
  });

  it("aborts model fetch on unmount", async () => {
    fetchSpy
      .mockReturnValueOnce(jsonOk({ base_url: "https://test.url", api_key: "sk-xxxx", model_name: "qwen-plus", max_tokens: 4096, temperature: 0.7, top_p: 1.0, repetition_penalty: 1.0, enable_search: false, thinking_mode: false }))
      .mockReturnValueOnce(jsonOk([]))
      .mockReturnValueOnce(jsonOk({ models: [{ id: "qwen-plus", name: "Qwen Plus" }], total_count: 1, api_source: null }));

    const { result, unmount } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));

    fetchSpy.mockReset();

    let capturedSignal!: AbortSignal;
    fetchSpy.mockImplementation((_url: string, options?: RequestInit) => {
      if (options?.signal) capturedSignal = options.signal as AbortSignal;
      return new Promise<Response>(() => {}); // never resolves
    });

    act(() => { result.current.fetchModels(); });

    unmount();

    expect(capturedSignal.aborted).toBe(true);
  });

  it("refreshModels also aborts previous model request", async () => {
    fetchSpy
      .mockReturnValueOnce(jsonOk({ base_url: "https://test.url", api_key: "sk-xxxx", model_name: "qwen-plus", max_tokens: 4096, temperature: 0.7, top_p: 1.0, repetition_penalty: 1.0, enable_search: false, thinking_mode: false }))
      .mockReturnValueOnce(jsonOk([]))
      .mockReturnValueOnce(jsonOk({ models: [{ id: "qwen-plus", name: "Qwen Plus" }], total_count: 1, api_source: null }));

    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));

    fetchSpy.mockReset();

    let signal1!: AbortSignal;
    let callCount = 0;
    fetchSpy.mockImplementation((_url: string, options?: RequestInit) => {
      callCount++;
      if (callCount === 1) {
        if (options?.signal) signal1 = options.signal as AbortSignal;
        return new Promise<Response>(() => {}); // never resolves
      }
      return jsonOk({ models: [{ id: "qwen-max", name: "Qwen Max" }], total_count: 1, api_source: null });
    });

    // Start fetchModels (never resolves)
    act(() => { result.current.fetchModels(); });

    // refreshModels should abort it
    await act(async () => {
      await result.current.refreshModels();
    });

    expect(signal1.aborted).toBe(true);
    expect(result.current.models[0]?.id).toBe("qwen-max");
  });

  it("refreshModels also passes AbortSignal to fetch", async () => {
    fetchSpy
      .mockReturnValueOnce(jsonOk({ base_url: "https://test.url", api_key: "sk-xxxx", model_name: "qwen-plus", max_tokens: 4096, temperature: 0.7, top_p: 1.0, repetition_penalty: 1.0, enable_search: false, thinking_mode: false }))
      .mockReturnValueOnce(jsonOk([]))
      .mockReturnValueOnce(jsonOk({ models: [{ id: "qwen-plus", name: "Qwen Plus" }], total_count: 1, api_source: null }));

    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));

    fetchSpy.mockReset();
    fetchSpy.mockReturnValue(jsonOk({ models: [], total_count: 0, api_source: null }));

    await act(async () => {
      await result.current.refreshModels();
    });

    const modelCall = fetchSpy.mock.calls.find(
      (call: unknown[]) => String(call[0]).includes("/api/v1/models"),
    );
    expect(modelCall).toBeDefined();
    const options = (modelCall as [string, RequestInit])[1];
    expect(options).toBeDefined();
    if (options === undefined) throw new Error("Expected model request options");
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });
});
