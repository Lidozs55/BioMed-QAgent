import re

def detail_body(name="demo/db"):
    return {
        "id": name, "name": "Demo DB", "category": "discovery",
        "description": "Updated", "available": True, "enabled": True,
        "origin": "package", "version": "1", "pipeline_supported": False,
        "capability": "research_only",
        "declarative_manifest": {
            "schema_version": "1.0", "name": "demo", "display_name": "Demo DB",
            "version": "1", "category": "discovery", "description": "Updated",
            "supported_sources": ["demo"], "user_selectable": True,
            "pipeline_supported": False, "enabled": True, "requirements": [],
            "operations": [{
                "name": "search", "description": "Search", "method": "POST",
                "url": "https://example.com/search/{query}",
                "query": {"q": "{query}"}, "headers": {}, "body": None,
                "timeout_seconds": 30, "extract": None, "auth": None,
            }],
        },
    }

# api-database.test.ts
p = "src/test/api-database.test.ts"
s = open(p, encoding="utf-8").read()
s = s.replace(
    'const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ generation: 4, skill: null }));',
    f'const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({detail_body("demo/db")}));')
open(p, "w", encoding="utf-8").write(s)

# api-malformed-rejection.test.ts: database envelope fixture + createDatabase mock
p = "src/test/api-malformed-rejection.test.ts"
s = open(p, encoding="utf-8").read()
s = s.replace(
    'jsonResponse({ databases: [{ id: "d1", name: "D1", category: "cat", description: "desc" }] })',
    'jsonResponse({ databases: [{ id: "d1", name: "D1", category: "cat", description: "desc", origin: "builtin", version: "1", pipeline_supported: false, available: true, enabled: true, capability: "research_only" }] })')
s = s.replace(
    'const fetcher = vi.fn<FetchLike>().mockResolvedValue(new Response("{}", { status: 200 }));\n    const api = createAPIClient({ fetcher });\n    const manifest = { schema_version: "1.0" as const, name: "test-db"',
    f'const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({detail_body("test-db")}));\n    const api = createAPIClient({ fetcher });\n    const manifest = {{ schema_version: "1.0" as const, name: "test-db"')
open(p, "w", encoding="utf-8").write(s)
print("patched")
