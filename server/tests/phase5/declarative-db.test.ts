/**
 * P5-11 declarative user database HTTP tools: manifest validation, URL
 * rendering, SSRF, secret injection, HIL approval, extraction (Python
 * app/databases/declarative.py parity).
 */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PublicHttpClient } from "../../src/external/network/http-client.js";
import {
  buildOperationTool,
  createDeclarativeDatabaseTools,
  parseDeclarativeManifest,
  type HttpOperationManifest,
} from "../../src/agent/tools/declarative-db.js";
import type { ToolApprovalGate } from "../../src/agent/tools/tool-hooks.js";
import { fakeResolver, localExecutor, PUBLIC_IP, startFixtureServer, type FixtureServer } from "./helpers.js";

const fixtures: FixtureServer[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const API_HOST = "api.example.com";

function client(port: number): PublicHttpClient {
  return new PublicHttpClient({
    resolve: fakeResolver({ [API_HOST]: [PUBLIC_IP] }),
    executor: localExecutor(port),
  });
}

const BASE_MANIFEST = {
  schema_version: "1.0",
  name: "demo",
  display_name: "Demo",
  version: "1.0.0",
  category: "discovery",
  description: "fixture declarative database",
  supported_sources: [],
  operations: [
    {
      name: "search_demo",
      description: "Search the demo database",
      method: "GET",
      url: `https://${API_HOST}/v1/search/{term}`,
      query: { limit: "5" },
      headers: { "x-client": "biomed" },
      body: null,
      timeout_seconds: 30,
      auth: null,
      extract: "results",
    },
  ],
  enabled: true,
  user_selectable: true,
  pipeline_supported: false,
  requirements: [],
} as const;

function protectedManifest(): Record<string, unknown> {
  return {
    schema_version: "1.0",
    name: "protected_db",
    display_name: "Protected",
    version: "1.0.0",
    category: "acquisition",
    description: "credentialed fixture database",
    supported_sources: [],
    operations: [
      {
        name: "query_protected",
        description: "Credentialed query",
        method: "GET",
        url: `https://${API_HOST}/query/{q}`,
        query: {},
        headers: {},
        body: null,
        timeout_seconds: 30,
        auth: { source: "env", reference: "DEMO_SECRET", location: "header", name: "Authorization", prefix: "Bearer " },
        extract: null,
      },
    ],
    enabled: true,
    user_selectable: true,
    pipeline_supported: false,
    requirements: [],
  };
}

describe("parseDeclarativeManifest validation (Python Pydantic parity)", () => {
  it("accepts a valid manifest", () => {
    const manifest = parseDeclarativeManifest({ ...BASE_MANIFEST });
    expect(manifest.operations[0]?.name).toBe("search_demo");
  });

  it.each([
    ["schema_version", { ...BASE_MANIFEST, schema_version: "2.0" }],
    ["bad manifest name", { ...BASE_MANIFEST, name: "Bad-Name" }],
    ["bad operation name", { ...BASE_MANIFEST, operations: [{ ...BASE_MANIFEST.operations[0], name: "Bad_Op" }] }],
    ["duplicate operation names", { ...BASE_MANIFEST, operations: [BASE_MANIFEST.operations[0], BASE_MANIFEST.operations[0]] }],
    ["non-http url", { ...BASE_MANIFEST, operations: [{ ...BASE_MANIFEST.operations[0], url: "ftp://x/y" }] }],
    ["url credentials", { ...BASE_MANIFEST, operations: [{ ...BASE_MANIFEST.operations[0], url: "https://u:p@api.example.com/x" }] }],
    ["localhost url", { ...BASE_MANIFEST, operations: [{ ...BASE_MANIFEST.operations[0], url: "https://localhost/x" }] }],
    ["placeholder in authority", { ...BASE_MANIFEST, operations: [{ ...BASE_MANIFEST.operations[0], url: "https://{host}.example.com/x" }] }],
    ["python requirements", { ...BASE_MANIFEST, requirements: ["pandas"] }],
    ["timeout above 120", { ...BASE_MANIFEST, operations: [{ ...BASE_MANIFEST.operations[0], timeout_seconds: 121 }] }],
    ["header placeholder name", { ...BASE_MANIFEST, operations: [{ ...BASE_MANIFEST.operations[0], headers: { "{x}-h": "v" } }] }],
    ["header CRLF name", { ...BASE_MANIFEST, operations: [{ ...BASE_MANIFEST.operations[0], headers: { "x\r\nh": "v" } }] }],
    ["bad extract path", { ...BASE_MANIFEST, operations: [{ ...BASE_MANIFEST.operations[0], extract: "a b" }] }],
    ["bad secret reference", {
      ...protectedManifest(),
      operations: [{
        ...((protectedManifest().operations as Array<Record<string, unknown>>)[0] ?? {}),
        auth: { source: "env", reference: "bad-ref", location: "header", name: "X", prefix: "" },
      }],
    }],
  ])("rejects %s", (_label, raw) => {
    expect(() => parseDeclarativeManifest(raw as unknown as Record<string, unknown>)).toThrow(/.*/);
  });
});

describe("buildOperationTool execution", () => {
  it("renders path placeholders with strict percent-encoding and extracts the payload", async () => {
    const fixture = await startFixtureServer((_req, res) => {
      expect(_req.url).toBe("/v1/search/a%2Fb%20c?limit=5");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ results: [{ id: 1 }], total: 1 }));
    });
    fixtures.push(fixture);
    const operation: HttpOperationManifest = {
      name: "search_demo",
      description: "d",
      method: "GET",
      url: `https://${API_HOST}/v1/search/{term}`,
      query: { limit: "5" },
      headers: {},
      body: null,
      timeout_seconds: 30,
      auth: null,
      extract: "results",
    };
    const tool = buildOperationTool(operation, {
      db: undefined as never,
      approval: undefined,
      secrets: {},
      hooks: undefined,
      client: client(fixture.port),
    });
    const result = await tool.execute({ term: "a/b c" });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content)).toEqual([{ id: 1 }]);
  });

  it("rejects header values containing CR/LF", async () => {
    const fixture = await startFixtureServer(() => undefined);
    fixtures.push(fixture);
    const operation: HttpOperationManifest = {
      name: "op",
      description: "d",
      method: "GET",
      url: `https://${API_HOST}/x`,
      query: {},
      headers: { "x-h": "{value}" },
      body: null,
      timeout_seconds: 30,
      auth: null,
      extract: null,
    };
    const tool = buildOperationTool(operation, {
      db: undefined as never,
      approval: undefined,
      secrets: {},
      hooks: undefined,
      client: client(fixture.port),
    });
    const result = await tool.execute({ value: "safe\r\nInjected: x" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("header values cannot contain CR/LF");
    expect(fixture.requests).toHaveLength(0);
  });

  it("enforces the 10 MiB response cap", async () => {
    const fixture = await startFixtureServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      for (let index = 0; index < 11; index += 1) res.write("x".repeat(1024 * 1024));
      res.end();
    });
    fixtures.push(fixture);
    const operation: HttpOperationManifest = {
      name: "op",
      description: "d",
      method: "GET",
      url: `https://${API_HOST}/big`,
      query: {},
      headers: {},
      body: null,
      timeout_seconds: 30,
      auth: null,
      extract: null,
    };
    const tool = buildOperationTool(operation, {
      db: undefined as never,
      approval: undefined,
      secrets: {},
      hooks: undefined,
      client: client(fixture.port),
    });
    const result = await tool.execute({});
    expect(result.isError).toBe(true);
    expect(result.content).toContain("response exceeds 10 MiB limit");
  });

  it("requires HIL approval before using credentials and injects the secret on approve", async () => {
    const fixture = await startFixtureServer((_req, res) => {
      expect(_req.headers["authorization"]).toBe("Bearer server-secret");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    fixtures.push(fixture);
    const approvals: string[] = [];
    const gate: ToolApprovalGate = {
      request: async (operation) => {
        approvals.push(operation);
        return "approve";
      },
    };
    const operation: HttpOperationManifest = {
      name: "query_protected",
      description: "d",
      method: "GET",
      url: `https://${API_HOST}/query/{q}`,
      query: {},
      headers: {},
      body: null,
      timeout_seconds: 30,
      auth: { source: "env", reference: "DEMO_SECRET", location: "header", name: "Authorization", prefix: "Bearer " },
      extract: null,
    };
    const tool = buildOperationTool(operation, {
      db: undefined as never,
      approval: gate,
      secrets: { DEMO_SECRET: "server-secret" },
      hooks: undefined,
      client: client(fixture.port),
    });
    const result = await tool.execute({ q: "TP53" });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content)).toEqual({ ok: true });
    expect(approvals).toEqual(["query_protected"]);
  });

  it("fails closed when the approval gate is missing for credentialed ops", async () => {
    const operation: HttpOperationManifest = {
      name: "query_protected",
      description: "d",
      method: "GET",
      url: `https://${API_HOST}/x`,
      query: {},
      headers: {},
      body: null,
      timeout_seconds: 30,
      auth: { source: "env", reference: "DEMO_SECRET", location: "header", name: "Authorization", prefix: "" },
      extract: null,
    };
    const tool = buildOperationTool(operation, {
      db: undefined as never,
      approval: undefined,
      secrets: {},
      hooks: undefined,
      client: new PublicHttpClient(),
    });
    const result = await tool.execute({});
    expect(result.isError).toBe(true);
    expect(result.content).toContain("requires HIL approval before credentials can be used");
  });

  it("fails closed on rejection", async () => {
    const operation: HttpOperationManifest = {
      name: "query_protected",
      description: "d",
      method: "GET",
      url: `https://${API_HOST}/x`,
      query: {},
      headers: {},
      body: null,
      timeout_seconds: 30,
      auth: { source: "env", reference: "DEMO_SECRET", location: "header", name: "Authorization", prefix: "" },
      extract: null,
    };
    const gate: ToolApprovalGate = { request: async () => "reject" };
    const tool = buildOperationTool(operation, {
      db: undefined as never,
      approval: gate,
      secrets: {},
      hooks: undefined,
      client: new PublicHttpClient(),
    });
    const result = await tool.execute({});
    expect(result.isError).toBe(true);
    expect(result.content).toContain("credential use was rejected by the user");
  });

  it("reports a missing configured secret", async () => {
    const operation: HttpOperationManifest = {
      name: "query_protected",
      description: "d",
      method: "GET",
      url: `https://${API_HOST}/x`,
      query: {},
      headers: {},
      body: null,
      timeout_seconds: 30,
      auth: { source: "env", reference: "DEMO_SECRET", location: "header", name: "Authorization", prefix: "" },
      extract: null,
    };
    const gate: ToolApprovalGate = { request: async () => "approve" };
    const tool = buildOperationTool(operation, {
      db: undefined as never,
      approval: gate,
      secrets: {},
      hooks: undefined,
      client: new PublicHttpClient({ resolve: fakeResolver({ [API_HOST]: [PUBLIC_IP] }) }),
    });
    const result = await tool.execute({});
    expect(result.isError).toBe(true);
    expect(result.content).toContain("configured secret is unavailable: DEMO_SECRET");
  });

  it("rejects a redirect hop resolving to a private address (per-hop SSRF)", async () => {
    const fixture = await startFixtureServer((_req, res) => {
      res.writeHead(302, { Location: "http://192.168.1.1/x" });
      res.end();
    });
    fixtures.push(fixture);
    const operation: HttpOperationManifest = {
      name: "op",
      description: "d",
      method: "GET",
      url: `https://${API_HOST}/x`,
      query: {},
      headers: {},
      body: null,
      timeout_seconds: 30,
      auth: null,
      extract: null,
    };
    const tool = buildOperationTool(operation, {
      db: undefined as never,
      approval: undefined,
      secrets: {},
      hooks: undefined,
      client: new PublicHttpClient({
        resolve: fakeResolver({ [API_HOST]: [PUBLIC_IP], "192.168.1.1": [{ address: "192.168.1.1", family: 4 }] }),
        executor: localExecutor(fixture.port),
      }),
    });
    const result = await tool.execute({});
    expect(result.isError).toBe(true);
    expect(result.content).toContain("non-public address");
  });

  it("reports missing template arguments", async () => {
    const operation: HttpOperationManifest = {
      name: "op",
      description: "d",
      method: "GET",
      url: `https://${API_HOST}/x/{missing}`,
      query: {},
      headers: {},
      body: null,
      timeout_seconds: 30,
      auth: null,
      extract: null,
    };
    const tool = buildOperationTool(operation, {
      db: undefined as never,
      approval: undefined,
      secrets: {},
      hooks: undefined,
      client: new PublicHttpClient(),
    });
    const result = await tool.execute({});
    expect(result.isError).toBe(true);
    expect(result.content).toContain("missing template argument: missing");
  });
});

describe("createDeclarativeDatabaseTools", () => {
  it("registers enabled manifests from the bridge and skips disabled ones", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "p5-ddb-"));
    roots.push(root);
    const db = {
      call: async (op: string): Promise<unknown> => {
        if (op === "database.tool_manifests") {
          return [
            { ...protectedManifest(), enabled: true },
            { ...BASE_MANIFEST, name: "disabled_db", enabled: false },
          ];
        }
        throw new Error(`unexpected op ${op}`);
      },
    };
    const tools = await createDeclarativeDatabaseTools({
      db: db as never,
      secrets: {},
      client: new PublicHttpClient(),
    });
    expect(tools.map((tool) => tool.name)).toEqual(["query_protected", "search_demo"]);
  });
});
