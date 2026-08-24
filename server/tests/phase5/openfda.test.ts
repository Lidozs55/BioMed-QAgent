import { afterEach, describe, expect, it } from "vitest";

import { SKILL_TOOL_NAMES, toolOwner } from "../../src/agent/skills/skill-tool-map.js";
import { createOpenFdaTools, lookupOpenFdaDiliCounts } from "../../src/agent/tools/openfda.js";
import { PublicHttpClient } from "../../src/external/network/index.js";
import { fakeResolver, localExecutor, PUBLIC_IP, startFixtureServer, type FixtureServer } from "./helpers.js";

const HOST = "api.fda.gov";
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

describe("lookupOpenFdaDiliCounts", () => {
  it("uses one aggregate reaction query per drug and preserves exact source counts", async () => {
    const fixture = await startFixtureServer((req, res) => {
      const url = new URL(req.url ?? "", "https://api.fda.gov");
      expect(url.pathname).toBe("/drug/event.json");
      expect(url.searchParams.get("count")).toBe("patient.reaction.reactionmeddrapt.exact");
      expect(url.searchParams.get("limit")).toBe("999");
      expect(url.searchParams.get("search")).toContain("acetaminophen");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        results: [
          { term: "DRUG-INDUCED LIVER INJURY", count: 383 },
          { term: "HEPATOTOXICITY", count: 127 },
          { term: "NAUSEA", count: 9000 },
        ],
      }));
    });
    servers.push(fixture);

    const result = await lookupOpenFdaDiliCounts(
      ["acetaminophen"],
      ["Drug-induced liver injury", "Hepatotoxicity"],
      { client: client(fixture.port), limiter: immediateLimiter },
    );

    expect(fixture.requests).toHaveLength(1);
    expect(result).toMatchObject({ source: "openfda_faers", requested_count: 1, succeeded_count: 1 });
    expect(result.records[0]).toMatchObject({
      drug_name: "acetaminophen",
      reaction_counts: [
        { reaction_term: "DRUG-INDUCED LIVER INJURY", count: 383 },
        { reaction_term: "HEPATOTOXICITY", count: 127 },
      ],
      matched_report_count_sum: 510,
    });
  });

  it("reports a failed drug query instead of converting source failure to zero", async () => {
    const fixture = await startFixtureServer((_req, res) => {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "unavailable" } }));
    });
    servers.push(fixture);

    const result = await lookupOpenFdaDiliCounts(
      ["acetaminophen"],
      ["Hepatotoxicity"],
      { client: client(fixture.port), limiter: immediateLimiter, maxRetries: 0 },
    );

    expect(result.records).toEqual([]);
    expect(result.failures).toEqual([
      expect.objectContaining({ drug_name: "acetaminophen", status_code: 503, status: "failed" }),
    ]);
  });

  it("recovers requested terms omitted by the aggregate limit through exact fallback queries", async () => {
    const fixture = await startFixtureServer((req, res) => {
      const url = new URL(req.url ?? "", "https://api.fda.gov");
      const search = url.searchParams.get("search") ?? "";
      res.setHeader("content-type", "application/json");
      if (url.searchParams.has("count")) {
        res.writeHead(200);
        res.end(JSON.stringify({ results: [] }));
        return;
      }
      expect(search).toContain("patient.reaction.reactionmeddrapt.exact");
      if (search.includes("HEPATIC INFARCTION")) {
        res.writeHead(200);
        res.end(JSON.stringify({ meta: { results: { total: 7 } }, results: [{}] }));
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "No matches found!" } }));
    });
    servers.push(fixture);

    const result = await lookupOpenFdaDiliCounts(
      ["ibuprofen"],
      ["HEPATIC INFARCTION", "LIVER INDURATION"],
      { client: client(fixture.port), limiter: immediateLimiter, maxRetries: 0 },
    );

    expect(fixture.requests).toHaveLength(3);
    expect(result.records[0]).toMatchObject({
      reaction_counts: [{
        reaction_term: "HEPATIC INFARCTION",
        count: 7,
        retrieval_method: "exact_fallback",
        source_url: expect.stringContaining("HEPATIC+INFARCTION"),
      }],
      unmatched_reaction_terms: ["LIVER INDURATION"],
      matched_report_count_sum: 7,
    });
  });

  it("fails the drug when an exact fallback is unavailable instead of treating it as unmatched", async () => {
    const fixture = await startFixtureServer((req, res) => {
      const url = new URL(req.url ?? "", "https://api.fda.gov");
      res.setHeader("content-type", "application/json");
      if (url.searchParams.has("count")) {
        res.writeHead(200);
        res.end(JSON.stringify({ results: [] }));
        return;
      }
      res.writeHead(503);
      res.end(JSON.stringify({ error: { message: "temporarily unavailable" } }));
    });
    servers.push(fixture);

    const result = await lookupOpenFdaDiliCounts(
      ["ibuprofen"],
      ["HEPATIC INFARCTION"],
      { client: client(fixture.port), limiter: immediateLimiter, maxRetries: 0 },
    );

    expect(result.records).toEqual([]);
    expect(result.failures).toEqual([
      expect.objectContaining({ drug_name: "ibuprofen", status_code: 503, status: "failed" }),
    ]);
  });

  it("rejects unbounded batches and registers the tool under openfda", async () => {
    await expect(lookupOpenFdaDiliCounts(
      Array.from({ length: 21 }, (_, index) => `drug-${index}`),
      ["Hepatotoxicity"],
    )).rejects.toThrow(/at most 20/i);
    const [tool] = createOpenFdaTools();
    expect(tool?.name).toBe("lookup_openfda_dili_counts");
    expect(SKILL_TOOL_NAMES.has("lookup_openfda_dili_counts")).toBe(true);
    expect(toolOwner("lookup_openfda_dili_counts")).toBe("openfda");
  });
});
