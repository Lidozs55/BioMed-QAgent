import { describe, expect, test } from "vitest";

import {
  APIError,
  parseManagedModelsEnvelope,
  parseManagedModelsPage,
  parseProvidersEnvelope,
  parseProvidersPage,
} from "../src/index.js";

function provider(): Record<string, unknown> {
  return {
    id: "provider_1",
    name: "Provider",
    base_url: "https://example.test/v1",
    api_key: "sk-****",
    api_key_configured: true,
    preset_id: null,
    description: "Test provider",
    enabled: true,
    created_at: "2026-08-22T00:00:00Z",
    updated_at: "2026-08-22T00:00:00Z",
  };
}

function model(): Record<string, unknown> {
  return {
    id: "model_1",
    provider_id: "provider_1",
    provider_name: "Provider",
    provider_base_url: "https://example.test/v1",
    provider_api_key_configured: true,
    model_id: "example-model",
    name: "Example Model",
    description: "Test model",
    context_window: 131_072,
    max_output_tokens: 8_192,
    suggested_max_tokens: null,
    capabilities: { text: true, image: false, video: false, audio: false },
    params: { temperature: 0.5 },
    param_specs: [{
      key: "temperature",
      label: "Temperature",
      type: "number",
      default: 0.5,
      min: 0,
      max: 2,
      required: false,
      advanced: true,
    }],
    source: "manual",
    active: true,
    created_at: "2026-08-22T00:00:00Z",
    updated_at: "2026-08-22T00:00:00Z",
  };
}

describe("model registry runtime parsers", () => {
  test("parses provider and managed-model list responses", () => {
    expect(parseProvidersEnvelope([provider()])).toEqual([provider()]);
    expect(parseManagedModelsEnvelope([model()])).toEqual([model()]);
  });

  test("rejects invalid enums and non-finite numeric fields", () => {
    expect(() => parseManagedModelsEnvelope([{ ...model(), source: "agent" }]))
      .toThrow(APIError);
    expect(() => parseManagedModelsEnvelope([{ ...model(), context_window: Number.NaN }]))
      .toThrow(APIError);
    expect(() => parseManagedModelsEnvelope([{
      ...model(),
      param_specs: [{ key: "x", label: "X", type: "executable" }],
    }])).toThrow(APIError);
  });

  test("rejects sparse arrays, accessors, proxies, and exotic prototypes without reads", () => {
    const sparse = new Array(1);
    expect(() => parseProvidersEnvelope(sparse)).toThrow(/Sparse array/);

    let reads = 0;
    const accessor = provider();
    Object.defineProperty(accessor, "id", {
      enumerable: true,
      get() {
        reads += 1;
        return "provider_1";
      },
    });
    expect(() => parseProvidersEnvelope([accessor])).toThrow(/Accessor property/);
    expect(reads).toBe(0);

    const proxy = new Proxy(provider(), {
      get() {
        reads += 1;
        return undefined;
      },
    });
    expect(() => parseProvidersEnvelope([proxy])).toThrow(/Proxy objects/);
    expect(reads).toBe(0);

    const exotic = Object.assign(Object.create({ inherited: true }), provider());
    expect(() => parseProvidersEnvelope([exotic])).toThrow(/prototype/);
  });

  test("parses paged provider and managed-model list responses", () => {
    const providersPage = parseProvidersPage({
      items: [provider()],
      total: 1,
      page: 1,
      size: 20,
    });
    expect(providersPage).toEqual({ items: [provider()], total: 1, page: 1, size: 20 });

    const modelsPage = parseManagedModelsPage({
      items: [model()],
      total: 1,
      page: 2,
      size: 10,
    });
    expect(modelsPage).toEqual({ items: [model()], total: 1, page: 2, size: 10 });
  });

  test("parses empty pages", () => {
    expect(parseProvidersPage({ items: [], total: 0, page: 1, size: 20 }))
      .toEqual({ items: [], total: 0, page: 1, size: 20 });
    expect(parseManagedModelsPage({ items: [], total: 0, page: 3, size: 5 }))
      .toEqual({ items: [], total: 0, page: 3, size: 5 });
  });

  test("rejects hostile paged envelopes without partial reads", () => {
    let reads = 0;
    const trap = (): unknown => {
      reads += 1;
      return undefined;
    };

    expect(() => parseProvidersPage({ items: [], total: "1", page: 1, size: 20 }))
      .toThrow(APIError);
    expect(() => parseProvidersPage({ items: [], total: -1, page: 1, size: 20 }))
      .toThrow(/non-negative safe integer/);
    expect(() => parseProvidersPage({ items: [], total: 0, page: 0, size: 20 }))
      .toThrow(/positive safe integer/);
    expect(() => parseProvidersPage({ items: [], total: 0, page: 1, size: 0 }))
      .toThrow(/positive safe integer/);
    expect(() => parseProvidersPage({ items: [], total: 0, page: 1.5, size: 20 }))
      .toThrow(APIError);
    expect(() => parseProvidersPage({ total: 0, page: 1, size: 20 }))
      .toThrow(/Expected array/);
    expect(() => parseProvidersPage({ items: {}, total: 0, page: 1, size: 20 }))
      .toThrow(/Expected array/);
    expect(() => parseManagedModelsPage({ items: [model()] }))
      .toThrow(APIError);

    const proxy = new Proxy({ items: [], total: 0, page: 1, size: 20 }, { get: trap });
    expect(() => parseProvidersPage(proxy)).toThrow(/Proxy objects/);
    expect(reads).toBe(0);
  });
});
