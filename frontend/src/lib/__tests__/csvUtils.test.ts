import { describe, expect, it, vi } from "vitest";

import { fetchPreviewText } from "@/lib/csvUtils";

function streamResponse(text: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(body);
}

describe("fetchPreviewText", () => {
  it("returns the full body when it fits inside the byte cap", async () => {
    const fetchMock = vi.fn().mockResolvedValue(streamResponse("a,b\n1,2\n"));
    vi.stubGlobal("fetch", fetchMock);

    const text = await fetchPreviewText("https://example.test/data.csv", 1024);
    expect(text).toBe("a,b\n1,2");

    vi.unstubAllGlobals();
  });

  it("cuts the prefix at the last complete line when capped", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode("h1,h2\nr1c1,r1c2\nr2c1,r2c2\n"));
        controller.enqueue(encoder.encode("r3c1,"));
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(body));
    vi.stubGlobal("fetch", fetchMock);

    const text = await fetchPreviewText("https://example.test/data.csv", 24);
    // 24 bytes ends inside the last row; the prefix must stop at the last newline.
    expect(text.endsWith("r2c1,r2c2")).toBe(true);
    expect(text.endsWith("r3c1,")).toBe(false);

    vi.unstubAllGlobals();
  });

  it("cancels the stream once the byte cap is reached", async () => {
    const cancelMock = vi.fn().mockResolvedValue(undefined);
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("x".repeat(1024)));
        controller.enqueue(encoder.encode("y".repeat(1024)));
      },
      cancel: cancelMock,
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(body));
    vi.stubGlobal("fetch", fetchMock);

    await fetchPreviewText("https://example.test/data.csv", 1000);
    expect(cancelMock).toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("rejects on a non-ok response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPreviewText("https://example.test/data.csv", 1024)).rejects.toThrow(
      "fetch failed",
    );

    vi.unstubAllGlobals();
  });
});
