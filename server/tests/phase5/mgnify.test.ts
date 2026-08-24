import { afterEach, describe, expect, it } from "vitest";

import { SKILL_TOOL_NAMES, toolOwner } from "../../src/agent/skills/skill-tool-map.js";
import { createMgnifyTools, searchMgnifyStudies } from "../../src/agent/tools/mgnify.js";
import { PublicHttpClient } from "../../src/external/network/index.js";
import { fakeResolver, localExecutor, PUBLIC_IP, startFixtureServer, type FixtureServer } from "./helpers.js";

const HOST = "www.ebi.ac.uk";
const servers: FixtureServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function client(port: number): PublicHttpClient {
  return new PublicHttpClient({
    resolve: fakeResolver({ [HOST]: [PUBLIC_IP] }),
    executor: localExecutor(port),
  });
}

describe("searchMgnifyStudies", () => {
  it("uses the MGnify JSON API and returns bounded source-linked metadata", async () => {
    const fixture = await startFixtureServer((req, res) => {
      const url = new URL(req.url ?? "", "https://www.ebi.ac.uk");
      expect(url.pathname).toBe("/metagenomics/api/v1/studies");
      expect(url.searchParams.get("search")).toBe("T2D");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        meta: { pagination: { count: 12 } },
        data: [
          {
            id: "MGYS00000322",
            type: "studies",
            attributes: {
              "study-name": "Gut metagenome in European women with diabetic glucose control",
              "study-abstract": "A real source abstract.",
              "samples-count": 145,
              bioproject: "PRJEB1786",
            },
          },
          { id: "MGYS00009999", type: "studies", attributes: { "study-name": "second" } },
        ],
      }));
    });
    servers.push(fixture);

    const result = await searchMgnifyStudies("T2D", 1, { client: client(fixture.port) });

    expect(result).toMatchObject({ source: "mgnify", query: "T2D", total_count: 12, records_count: 1 });
    expect(result.records).toEqual([
      {
        study_accession: "MGYS00000322",
        study_name: "Gut metagenome in European women with diabetic glucose control",
        study_abstract: "A real source abstract.",
        sample_count: 145,
        bioproject_id: "PRJEB1786",
        source_url: "https://www.ebi.ac.uk/metagenomics/api/v1/studies/MGYS00000322",
        publications_url: "https://www.ebi.ac.uk/metagenomics/api/v1/studies/MGYS00000322/publications",
      },
    ]);
  });

  it("rejects empty queries and registers the tool under mgnify", async () => {
    await expect(searchMgnifyStudies("", 10)).rejects.toThrow(/query/i);
    const [tool] = createMgnifyTools();
    expect(tool?.name).toBe("search_mgnify_studies");
    expect(SKILL_TOOL_NAMES.has("search_mgnify_studies")).toBe(true);
    expect(toolOwner("search_mgnify_studies")).toBe("mgnify");
  });
});
