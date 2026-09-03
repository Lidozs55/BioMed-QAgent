import { afterEach, describe, expect, test } from "vitest";

import {
  installSearchInfoProbe,
  parseSearchInfo,
  registerSearchProbe,
  SEARCH_PROBE_HEADER,
} from "../src/agent/search-info-capture.js";

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
});

function withMockFetch(impl: typeof fetch): void {
  globalThis.fetch = impl;
  disposers.push(installSearchInfoProbe());
}

function sseResponse(frames: string[], contentType = "text/event-stream"): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": contentType } });
}

const DASHSCOPE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";

function searchInfoChunk(url: string, siteName = "Example"): string {
  return JSON.stringify({
    choices: [{ delta: { content: "" } }],
    search_info: { search_results: [{ site_name: siteName, icon: `https://${siteName}.example/favicon.ico`, url }] },
  });
}

describe("parseSearchInfo", () => {
  test("extracts bounded results from the documented shape", () => {
    expect(parseSearchInfo({
      search_results: [
        { site_name: "Nature", icon: "https://nature.example/i.ico", url: "https://nature.example/a" },
        { site_name: "  PubMed  ", url: "https://pubmed.example/b", title: "A title" },
      ],
    })).toEqual([
      { site_name: "Nature", url: "https://nature.example/a", icon: "https://nature.example/i.ico" },
      { site_name: "PubMed", url: "https://pubmed.example/b", title: "A title" },
    ]);
  });

  test("drops entries without a usable url and tolerates hostile shapes", () => {
    expect(parseSearchInfo(null)).toEqual([]);
    expect(parseSearchInfo([1, 2, 3])).toEqual([]);
    expect(parseSearchInfo({})).toEqual([]);
    expect(parseSearchInfo({ search_results: "nope" })).toEqual([]);
    expect(parseSearchInfo({
      search_results: [
        null,
        "string",
        { site_name: "NoUrl" },
        { url: 42 },
        { site_name: "", url: "   " },
        { site_name: "Ok", url: "https://ok.example" },
      ],
    })).toEqual([{ site_name: "Ok", url: "https://ok.example" }]);
  });

  test("truncates oversized fields and caps the entry count", () => {
    const long = "x".repeat(500);
    const many = Array.from({ length: 30 }, (_, index) => ({
      site_name: `Site ${index}`,
      url: `https://site-${index}.example`,
      title: long,
    }));
    const results = parseSearchInfo({ search_results: many });
    expect(results).toHaveLength(20);
    expect(results[0].title).toHaveLength(200);
    expect(results[19].url).toBe("https://site-19.example");
  });
});

describe("search_info fetch probe", () => {
  test("mirrors SSE search_info frames into the registered slot", async () => {
    withMockFetch(async () => sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "he" } }] })}\n\n`,
      `data: ${searchInfoChunk("https://nature.example/a")}\n\n`,
      `data: ${searchInfoChunk("https://pubmed.example/b", "PubMed")}\n\n`,
      "data: [DONE]\n\n",
    ]));
    const { probeId, slot } = registerSearchProbe();
    const response = await globalThis.fetch(DASHSCOPE_URL, {
      method: "POST",
      headers: { [SEARCH_PROBE_HEADER]: probeId },
      body: "{}",
    });
    await response.text();
    const results = await slot.done;
    expect(results).toEqual([
      { site_name: "Example", url: "https://nature.example/a", icon: "https://Example.example/favicon.ico" },
      { site_name: "PubMed", url: "https://pubmed.example/b", icon: "https://PubMed.example/favicon.ico" },
    ]);
  });

  test("passes through untouched requests: no probe header, foreign host, wrong path", async () => {
    const original = sseResponse(["data: x\n\n"]);
    withMockFetch(async () => original);
    const passthrough = async (url: string, headers: Record<string, string>): Promise<Response> =>
      globalThis.fetch(url, { method: "POST", headers, body: "{}" });
    expect(await passthrough(DASHSCOPE_URL, {})).toBe(original);
    expect(await passthrough("https://models.example/v1/chat/completions", {
      [SEARCH_PROBE_HEADER]: "probe_foreign",
    })).toBe(original);
    expect(await passthrough("https://dashscope.aliyuncs.com/api/v1/services/aigc/x", {
      [SEARCH_PROBE_HEADER]: "probe_path",
    })).toBe(original);
  });

  test("releases the slot when the model call itself fails", async () => {
    withMockFetch(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    const { probeId, slot } = registerSearchProbe();
    await expect(globalThis.fetch(DASHSCOPE_URL, {
      method: "POST",
      headers: { [SEARCH_PROBE_HEADER]: probeId },
      body: "{}",
    })).rejects.toThrow("connect ECONNREFUSED");
    expect(await slot.done).toEqual([]);
  });

  test("resolves empty for non-SSE payloads instead of consuming the body", async () => {
    const original = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    withMockFetch(async () => original);
    const { probeId, slot } = registerSearchProbe();
    const response = await globalThis.fetch(DASHSCOPE_URL, {
      method: "POST",
      headers: { [SEARCH_PROBE_HEADER]: probeId },
      body: "{}",
    });
    expect(response).toBe(original);
    expect(await slot.done).toEqual([]);
    expect(await response.text()).toContain("\"ok\"");
  });

  test("keeps concurrent probes isolated", async () => {
    withMockFetch(async (_input, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      return sseResponse([
        `data: ${searchInfoChunk(`https://source.example/${body === "first" ? "a" : "b"}`)}\n\n`,
      ]);
    });
    const first = registerSearchProbe();
    const second = registerSearchProbe();
    const [responseA, responseB] = await Promise.all([
      globalThis.fetch(DASHSCOPE_URL, { method: "POST", headers: { [SEARCH_PROBE_HEADER]: first.probeId }, body: "first" }),
      globalThis.fetch(DASHSCOPE_URL, { method: "POST", headers: { [SEARCH_PROBE_HEADER]: second.probeId }, body: "second" }),
    ]);
    await Promise.all([responseA.text(), responseB.text()]);
    const [resultsA, resultsB] = await Promise.all([first.slot.done, second.slot.done]);
    expect(resultsA).toEqual([{ site_name: "Example", url: "https://source.example/a", icon: "https://Example.example/favicon.ico" }]);
    expect(resultsB).toEqual([{ site_name: "Example", url: "https://source.example/b", icon: "https://Example.example/favicon.ico" }]);
  });

  test("accepts the international endpoint and unknown frames without failing", async () => {
    withMockFetch(async () => sseResponse([
      ": keepalive comment\n\n",
      "data: not-json\n\n",
      `data: ${searchInfoChunk("https://intl.example/c")}\n\n`,
    ]));
    const { probeId, slot } = registerSearchProbe();
    const response = await globalThis.fetch(
      "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
      { method: "POST", headers: { [SEARCH_PROBE_HEADER]: probeId }, body: "{}" },
    );
    await response.text();
    expect(await slot.done).toEqual([{ site_name: "Example", url: "https://intl.example/c", icon: "https://Example.example/favicon.ico" }]);
  });
});
