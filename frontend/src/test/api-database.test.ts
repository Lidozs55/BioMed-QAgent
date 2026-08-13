import { describe, expect, it, vi } from "vitest";

import { createAPIClient, type FetchLike } from "@/hooks/useAPI";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("database API", () => {
  it("updates a database with a typed partial patch body", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({'id': 'demo/db', 'name': 'Demo DB', 'category': 'discovery', 'description': 'Updated', 'available': true, 'enabled': true, 'origin': 'package', 'version': '1', 'pipeline_supported': false, 'capability': 'research_only', 'declarative_manifest': {'schema_version': '1.0', 'name': 'demo', 'display_name': 'Demo DB', 'version': '1', 'category': 'discovery', 'description': 'Updated', 'supported_sources': ['demo'], 'user_selectable': true, 'pipeline_supported': false, 'enabled': true, 'requirements': [], 'operations': [{'name': 'search', 'description': 'Search', 'method': 'POST', 'url': 'https://example.com/search/{query}', 'query': {'q': '{query}'}, 'headers': {}, 'body': null, 'timeout_seconds': 30, 'extract': null, 'auth': null}]}}));
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
