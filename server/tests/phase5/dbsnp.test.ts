import { afterEach, describe, expect, it } from "vitest";

import { SKILL_TOOL_NAMES, toolOwner } from "../../src/agent/skills/skill-tool-map.js";
import { createDbsnpTools, lookupDbsnp } from "../../src/agent/tools/dbsnp.js";
import { PublicHttpClient } from "../../src/external/network/index.js";
import { fakeResolver, localExecutor, PUBLIC_IP, startFixtureServer, type FixtureServer } from "./helpers.js";

const HOST = "api.ncbi.nlm.nih.gov";
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

describe("lookupDbsnp", () => {
  it("normalizes rs-prefixed IDs to the official numeric RefSNP path", async () => {
    const fixture = await startFixtureServer((req, res) => {
      if (req.url === "/variation/v0/refsnp/429358") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          refsnp_id: "429358",
          primary_snapshot_data: {
            variant_type: "snv",
            placements_with_allele: [{
              seq_id: "NC_000019.10",
              is_ptlp: true,
              placement_annot: {
                seq_type: "refseq_chromosome",
                is_aln_opposite_orientation: false,
                seq_id_traits_by_assembly: [{
                  assembly_name: "GRCh38.p14",
                  assembly_accession: "GCF_000001405.40",
                }],
              },
              alleles: [{
                allele: { spdi: {
                  seq_id: "NC_000019.10",
                  position: 44908683,
                  deleted_sequence: "T",
                  inserted_sequence: "C",
                } },
                hgvs: "NC_000019.10:g.44908684T>C",
              }],
            }],
          },
        }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
    servers.push(fixture);

    const result = await lookupDbsnp(["rs429358"], {
      client: client(fixture.port),
      limiter: immediateLimiter,
    });
    expect(fixture.requests.map((request) => request.url)).toEqual(["/variation/v0/refsnp/429358"]);
    expect(result).toMatchObject({ source: "dbsnp", requested_count: 1, succeeded_count: 1, failed_count: 0 });
    expect(result.records[0]).toMatchObject({
      rs_id: "rs429358",
      refsnp_id: "429358",
      source_url: "https://api.ncbi.nlm.nih.gov/variation/v0/refsnp/429358",
      status: "succeeded",
      variant_type: "snv",
      placements: [{
        seq_id: "NC_000019.10",
        is_ptlp: true,
        is_aln_opposite_orientation: false,
        seq_type: "refseq_chromosome",
        assemblies: [{ assembly_name: "GRCh38.p14", assembly_accession: "GCF_000001405.40" }],
        alleles: [{
          position: 44908683,
          deleted_sequence: "T",
          inserted_sequence: "C",
          hgvs: "NC_000019.10:g.44908684T>C",
        }],
      }],
    });
  });

  it("reports per-ID API failures without inventing records", async () => {
    const fixture = await startFixtureServer((req, res) => {
      if (req.url === "/variation/v0/refsnp/429358") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ refsnp_id: "429358" }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    servers.push(fixture);

    const result = await lookupDbsnp(["rs429358", "rs999999999"], {
      client: client(fixture.port),
      limiter: immediateLimiter,
    });
    expect(result).toMatchObject({ requested_count: 2, succeeded_count: 1, failed_count: 1 });
    expect(result.records).toHaveLength(1);
    expect(result.failures).toEqual([
      expect.objectContaining({ rs_id: "rs999999999", status: "failed", status_code: 404 }),
    ]);
  });

  it("rejects malformed IDs and unbounded batches before network access", async () => {
    await expect(lookupDbsnp(["429358"], { client: new PublicHttpClient() })).rejects.toThrow(/rsID/i);
    await expect(lookupDbsnp(Array.from({ length: 21 }, (_, index) => `rs${index + 1}`), {
      client: new PublicHttpClient(),
    })).rejects.toThrow(/at most 20/i);
  });

  it("retries NCBI throttling through the shared limiter before reporting failure", async () => {
    let calls = 0;
    const fixture = await startFixtureServer((_req, res) => {
      calls += 1;
      if (calls === 1) {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
        res.end(JSON.stringify({ error: "rate limit" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ refsnp_id: "429358" }));
    });
    servers.push(fixture);
    const waits: string[] = [];

    const result = await lookupDbsnp(["rs429358"], {
      client: client(fixture.port),
      limiter: { wait: async (url) => { waits.push(url); } },
      sleep: async () => undefined,
      jitter: () => 0,
    });

    expect(result).toMatchObject({ succeeded_count: 1, failed_count: 0 });
    expect(calls).toBe(2);
    expect(waits).toEqual([
      "https://api.ncbi.nlm.nih.gov/variation/v0/refsnp/429358",
      "https://api.ncbi.nlm.nih.gov/variation/v0/refsnp/429358",
    ]);
  });
});

describe("createDbsnpTools", () => {
  it("registers lookup_dbsnp under the dbsnp skill", () => {
    const [tool] = createDbsnpTools({ client: new PublicHttpClient() });
    expect(tool?.name).toBe("lookup_dbsnp");
    expect(SKILL_TOOL_NAMES.has("lookup_dbsnp")).toBe(true);
    expect(toolOwner("lookup_dbsnp")).toBe("dbsnp");
  });
});
