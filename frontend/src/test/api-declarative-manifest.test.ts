import { describe, expect, it } from "vitest";
import { assertDeclarativeManifest } from "@/lib/apiDeclarativeParsers";
import { APIError } from "@/api/errors";

/* ---- declarative manifest field preservation ---- */
describe("assertDeclarativeManifest field preservation", () => {
  it("parses schema_version from response", () => {
    const m = assertDeclarativeManifest({
      schema_version: "1.0", name: "s1", display_name: "S1", version: "1",
      category: "discovery", description: "desc", supported_sources: [],
      operations: [{ name: "search", description: "Search", method: "POST", url: "https://x.com/api", query: {}, headers: {}, body: null, timeout_seconds: 30, extract: null, auth: null }],
      user_selectable: true, pipeline_supported: false, enabled: true, requirements: [],
    }, "d");
    expect(m?.schema_version).toBe("1.0");
  });

  it("rejects missing schema_version", () => {
    expect(() => assertDeclarativeManifest({
      name: "s1", display_name: "S1", version: "1",
      category: "discovery", description: "desc", supported_sources: [],
      operations: [{ name: "search", description: "Search", method: "POST", url: "https://x.com/api" }],
      user_selectable: true, pipeline_supported: false,
    }, "d")).toThrow(APIError);
  });

  it("parses pipeline_supported from response", () => {
    const m = assertDeclarativeManifest({
      schema_version: "1.0", name: "s1", display_name: "S1", version: "1",
      category: "discovery", description: "desc", supported_sources: [],
      operations: [{ name: "search", description: "Search", method: "POST", url: "https://x.com/api", query: {}, headers: {}, body: null, timeout_seconds: 30, extract: null, auth: null }],
      user_selectable: true, pipeline_supported: false, enabled: true, requirements: [],
    }, "d");
    expect(m?.pipeline_supported).toBe(false);
  });

  it("preserves operation query/headers/body/timeout_seconds/extract", () => {
    const m = assertDeclarativeManifest({
      schema_version: "1.0", name: "s1", display_name: "S1", version: "1",
      category: "discovery", description: "desc", supported_sources: [],
      operations: [{ name: "search", description: "Search", method: "POST", url: "https://x.com/api", query: { q: "test" }, headers: { "X-Api": "key" }, body: { input: "x" }, timeout_seconds: 60, extract: "data.results", auth: null }],
      user_selectable: true, pipeline_supported: false, enabled: true, requirements: [],
    }, "d");
    expect(m?.operations[0].query).toEqual({ q: "test" });
    expect(m?.operations[0].headers).toEqual({ "X-Api": "key" });
    expect(m?.operations[0].body).toEqual({ input: "x" });
    expect(m?.operations[0].timeout_seconds).toBe(60);
    expect(m?.operations[0].extract).toBe("data.results");
  });

  it("preserves enabled field", () => {
    const m = assertDeclarativeManifest({
      schema_version: "1.0", name: "s1", display_name: "S1", version: "1",
      category: "discovery", description: "desc", supported_sources: [],
      operations: [{ name: "search", description: "Search", method: "POST", url: "https://x.com/api", query: {}, headers: {}, body: null, timeout_seconds: 30, extract: null, auth: null }],
      user_selectable: true, pipeline_supported: false, enabled: false, requirements: [],
    }, "d");
    expect(m?.enabled).toBe(false);
  });

  it("preserves operation auth field", () => {
    const m = assertDeclarativeManifest({
      schema_version: "1.0", name: "s1", display_name: "S1", version: "1",
      category: "discovery", description: "desc", supported_sources: [],
      operations: [{ name: "search", description: "Search", method: "POST", url: "https://x.com/api", query: {}, headers: {}, body: null, timeout_seconds: 30, extract: null, auth: { source: "env", reference: "API_KEY", location: "header", name: "X-Key", prefix: "Bearer " } }],
      user_selectable: true, pipeline_supported: false, enabled: true, requirements: [],
    }, "d");
    expect(m?.operations[0].auth).toBeDefined();
    expect(m?.operations[0].auth?.reference).toBe("API_KEY");
    expect(m?.operations[0].auth?.location).toBe("header");
    expect(m?.operations[0].auth?.prefix).toBe("Bearer ");
  });

  /* ---- RED tests for URL/header/name constraints ---- */

  it("RED: rejects URL with ws:// scheme (HTTP required)", () => {
    expect(() => assertDeclarativeManifest({
      schema_version: "1.0", name: "s1", display_name: "S1", version: "1",
      category: "discovery", description: "desc", supported_sources: [],
      operations: [{ name: "search", description: "Search", method: "GET", url: "ws://x.com/api", query: {}, headers: {}, body: null, timeout_seconds: 30, extract: null, auth: null }],
      user_selectable: true, pipeline_supported: false, enabled: true, requirements: [],
    }, "d")).toThrow(APIError);
  });

  it("RED: rejects URL with embedded credentials", () => {
    expect(() => assertDeclarativeManifest({
      schema_version: "1.0", name: "s1", display_name: "S1", version: "1",
      category: "discovery", description: "desc", supported_sources: [],
      operations: [{ name: "search", description: "Search", method: "GET", url: "https://user:pass@x.com/api", query: {}, headers: {}, body: null, timeout_seconds: 30, extract: null, auth: null }],
      user_selectable: true, pipeline_supported: false, enabled: true, requirements: [],
    }, "d")).toThrow(APIError);
  });

  it("RED: rejects localhost URL", () => {
    expect(() => assertDeclarativeManifest({
      schema_version: "1.0", name: "s1", display_name: "S1", version: "1",
      category: "discovery", description: "desc", supported_sources: [],
      operations: [{ name: "search", description: "Search", method: "GET", url: "http://localhost:8080/api", query: {}, headers: {}, body: null, timeout_seconds: 30, extract: null, auth: null }],
      user_selectable: true, pipeline_supported: false, enabled: true, requirements: [],
    }, "d")).toThrow(APIError);
  });

  it("RED: rejects header name containing CR", () => {
    expect(() => assertDeclarativeManifest({
      schema_version: "1.0", name: "s1", display_name: "S1", version: "1",
      category: "discovery", description: "desc", supported_sources: [],
      operations: [{ name: "search", description: "Search", method: "GET", url: "https://x.com/api", query: {}, headers: { "Content-Type\rInjected": "x" }, body: null, timeout_seconds: 30, extract: null, auth: null }],
      user_selectable: true, pipeline_supported: false, enabled: true, requirements: [],
    }, "d")).toThrow(APIError);
  });

  it("RED: rejects header name containing LF", () => {
    expect(() => assertDeclarativeManifest({
      schema_version: "1.0", name: "s1", display_name: "S1", version: "1",
      category: "discovery", description: "desc", supported_sources: [],
      operations: [{ name: "search", description: "Search", method: "GET", url: "https://x.com/api", query: {}, headers: { "X-Custom\nEvil": "x" }, body: null, timeout_seconds: 30, extract: null, auth: null }],
      user_selectable: true, pipeline_supported: false, enabled: true, requirements: [],
    }, "d")).toThrow(APIError);
  });

  it("RED: rejects header name with backend placeholder braces", () => {
    expect(() => assertDeclarativeManifest({
      schema_version: "1.0", name: "s1", display_name: "S1", version: "1",
      category: "discovery", description: "desc", supported_sources: [],
      operations: [{ name: "search", description: "Search", method: "GET", url: "https://x.com/api", query: {}, headers: { "X-{user}": "x" }, body: null, timeout_seconds: 30, extract: null, auth: null }],
      user_selectable: true, pipeline_supported: false, enabled: true, requirements: [],
    }, "d")).toThrow(APIError);
  });

  it("GREEN: accepts header name with UPPERCASE placeholder braces X-{UPPER}", () => {
    const m = assertDeclarativeManifest({
      schema_version: "1.0", name: "s1", display_name: "S1", version: "1",
      category: "discovery", description: "desc", supported_sources: [],
      operations: [{ name: "search", description: "Search", method: "POST", url: "https://x.com/api", query: {}, headers: { "X-{UPPER}": "value" }, body: null, timeout_seconds: 30, extract: null, auth: null }],
      user_selectable: true, pipeline_supported: false, enabled: true, requirements: [],
    }, "d");
    if (m === null) throw new Error("Expected non-null declarative manifest");
    expect(m.operations[0].headers["X-{UPPER}"]).toBe("value");
  });

  it("RED: rejects manifest name not matching ^[a-z][a-z0-9_]*$", () => {
    expect(() => assertDeclarativeManifest({
      schema_version: "1.0", name: "MySkill", display_name: "S1", version: "1",
      category: "discovery", description: "desc", supported_sources: [],
      operations: [{ name: "search", description: "Search", method: "GET", url: "https://x.com/api", query: {}, headers: {}, body: null, timeout_seconds: 30, extract: null, auth: null }],
      user_selectable: true, pipeline_supported: false, enabled: true, requirements: [],
    }, "d")).toThrow(APIError);
  });

  it("RED: rejects duplicate operation names", () => {
    expect(() => assertDeclarativeManifest({
      schema_version: "1.0", name: "s1", display_name: "S1", version: "1",
      category: "discovery", description: "desc", supported_sources: [],
      operations: [
        { name: "search", description: "Search", method: "GET", url: "https://x.com/api", query: {}, headers: {}, body: null, timeout_seconds: 30, extract: null, auth: null },
        { name: "search", description: "Search again", method: "POST", url: "https://x.com/api2", query: {}, headers: {}, body: null, timeout_seconds: 30, extract: null, auth: null },
      ],
      user_selectable: true, pipeline_supported: false, enabled: true, requirements: [],
    }, "d")).toThrow(APIError);
  });

  it("RED: rejects declarative manifest with non-empty requirements", () => {
    expect(() => assertDeclarativeManifest({
      schema_version: "1.0", name: "s1", display_name: "S1", version: "1",
      category: "discovery", description: "desc", supported_sources: [],
      operations: [{ name: "search", description: "Search", method: "GET", url: "https://x.com/api", query: {}, headers: {}, body: null, timeout_seconds: 30, extract: null, auth: null }],
      user_selectable: true, pipeline_supported: false, enabled: true, requirements: ["numpy"],
    }, "d")).toThrow(APIError);
  });

  it("RED: rejects empty display_name", () => {
    expect(() => assertDeclarativeManifest({
      schema_version: "1.0", name: "s1", display_name: "", version: "1",
      category: "discovery", description: "desc", supported_sources: [],
      operations: [{ name: "search", description: "Search", method: "GET", url: "https://x.com/api", query: {}, headers: {}, body: null, timeout_seconds: 30, extract: null, auth: null }],
      user_selectable: true, pipeline_supported: false, enabled: true, requirements: [],
    }, "d")).toThrow(APIError);
  });

  it("RED: rejects empty description", () => {
    expect(() => assertDeclarativeManifest({
      schema_version: "1.0", name: "s1", display_name: "S1", version: "1",
      category: "discovery", description: "", supported_sources: [],
      operations: [{ name: "search", description: "Search", method: "GET", url: "https://x.com/api", query: {}, headers: {}, body: null, timeout_seconds: 30, extract: null, auth: null }],
      user_selectable: true, pipeline_supported: false, enabled: true, requirements: [],
    }, "d")).toThrow(APIError);
  });

  it("RED: rejects empty version", () => {
    expect(() => assertDeclarativeManifest({
      schema_version: "1.0", name: "s1", display_name: "S1", version: "",
      category: "discovery", description: "desc", supported_sources: [],
      operations: [{ name: "search", description: "Search", method: "GET", url: "https://x.com/api", query: {}, headers: {}, body: null, timeout_seconds: 30, extract: null, auth: null }],
      user_selectable: true, pipeline_supported: false, enabled: true, requirements: [],
    }, "d")).toThrow(APIError);
  });

});
