import { describe, expect, it, vi } from "vitest";

import { createAPIClient, type FetchLike } from "@/hooks/useAPI";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("database API", () => {
  it("updates a database with a typed partial patch body", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ generation: 4, skill: null }));
    const api = createAPIClient({ fetcher });

    await api.updateDatabase("demo/db", {
      description: "Updated",
      operation: {
        name: "search", method: "POST",
        url: "https://example.com/search/{query}",
        query: { q: "{query}" },
      },
    });

    expect(fetcher).toHaveBeenCalledWith("/api/v1/databases/demo%2Fdb", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: "Updated",
        operation: { name: "search", method: "POST", url: "https://example.com/search/{query}", query: { q: "{query}" } },
      }),
    });
  });
});
