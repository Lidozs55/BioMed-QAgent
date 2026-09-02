import { afterEach, describe, expect, it } from "vitest";

import { SKILL_TOOL_NAMES, toolOwner } from "../../src/agent/skills/skill-tool-map.js";
import { createClinvarTools, lookupClinvarCounts } from "../../src/agent/tools/clinvar.js";
import { PublicHttpClient } from "../../src/external/network/index.js";
import { fakeResolver, localExecutor, PUBLIC_IP, startFixtureServer, type FixtureServer } from "./helpers.js";

const HOST = "eutils.ncbi.nlm.nih.gov";
const servers: FixtureServer[] = [];
const immediateLimiter = { wait: async (): Promise<void> => undefined };

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function client(port: number): PublicHttpClient {
  return new PublicHttpClient({
    resolve: fakeResolver({ [HOST]: [PUBLIC_IP] }),
    executor: localExecutor(port),
  });
}

describe("lookupClinvarCounts", () => {
  it("queries total and pathogenic counts using official ClinVar field tags", async () => {
    const fixture = await startFixtureServer((req, res) => {
      const url = new URL(req.url ?? "", "https://eutils.ncbi.nlm.nih.gov");
      expect(url.pathname).toBe("/entrez/eutils/esearch.fcgi");
      expect(url.searchParams.get("db")).toBe("clinvar");
      expect(url.searchParams.get("retmode")).toBe("json");
      const term = url.searchParams.get("term") ?? "";
      const count = term.includes("CLNSIG") ? "583" : "1158";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ esearchresult: { count, idlist: [] } }));
    });
    servers.push(fixture);

    const result = await lookupClinvarCounts(["BTK"], {
      client: client(fixture.port),
      limiter: immediateLimiter,
    });

    expect(fixture.requests).toHaveLength(2);
    expect(result.records).toEqual([
      expect.objectContaining({
        gene_symbol: "BTK",
        total_variant_count: 1158,
        pathogenic_or_likely_pathogenic_count: 583,
        status: "succeeded",
      }),
    ]);
  });

  it("does not emit partial counts when either official query fails", async () => {
    let calls = 0;
    const fixture = await startFixtureServer((_req, res) => {
      calls += 1;
      if (calls === 1) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ esearchresult: { count: "10" } }));
        return;
      }
      res.writeHead(500, { "content-type": "application/json" });
      res.end("{}");
    });
    servers.push(fixture);

    const result = await lookupClinvarCounts(["BTK"], {
      client: client(fixture.port),
      limiter: immediateLimiter,
      maxRetries: 0,
    });

    expect(result.records).toEqual([]);
    expect(result.failures).toEqual([
      expect.objectContaining({ gene_symbol: "BTK", status: "failed", status_code: 500 }),
    ]);
  });

  it("validates HGNC-style symbols and registers the tool under clinvar", async () => {
    await expect(lookupClinvarCounts(["not a symbol"])).rejects.toThrow(/gene symbol/i);
    await expect(lookupClinvarCounts(["BRCA1 OR BRCA2"])).rejects.toThrow(/gene symbol/i);
    const [tool] = createClinvarTools();
    expect(tool?.name).toBe("lookup_clinvar_counts");
    expect(SKILL_TOOL_NAMES.has("lookup_clinvar_counts")).toBe(true);
    expect(toolOwner("lookup_clinvar_counts")).toBe("clinvar");
  });

  it("accepts HGNC symbols with '_' and '@' cluster suffixes (Y1 alignment)", async () => {
    const fixture = await startFixtureServer((req, res) => {
      const url = new URL(req.url ?? "", "https://eutils.ncbi.nlm.nih.gov");
      const term = url.searchParams.get("term") ?? "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ esearchresult: { count: term.includes("CLNSIG") ? "7" : "14", idlist: [] } }));
    });
    servers.push(fixture);

    const result = await lookupClinvarCounts(["SNORD116@", "GTF2H2C_2"], {
      client: client(fixture.port),
      limiter: immediateLimiter,
    });

    expect(result.failures).toEqual([]);
    expect(result.succeeded_count).toBe(2);
    expect(result.records.map((record) => record.gene_symbol)).toEqual(["SNORD116@", "GTF2H2C_2"]);
    expect(decodeURIComponent(fixture.requests[0]!.url)).toContain("SNORD116@[SYM]");
  });
});
