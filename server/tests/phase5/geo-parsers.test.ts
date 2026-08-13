/**
 * P5-04 GEO external parsers/discovery parity (mirrors
 * ``backend/tests/integrations/ncbi/test_parsers.py`` and
 * ``test_discovery.py`` GEO parts) — golden fixtures generated from the
 * Python reference implementation.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  parseGeoEsearch,
  parseGeoEsummary,
  resolveGeoSupplementaryAssets,
  safeInt,
} from "../../src/external/geo/index.js";
import {
  describeGeoSeries,
  searchGeoSeries,
  ValueError,
} from "../../src/external/geo/discovery.js";
import type { GeoDiscoveryClient } from "../../src/external/geo/client.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/geo", import.meta.url));

function fixture(name: string): Buffer {
  return readFileSync(path.join(FIXTURES, name));
}

function golden(name: string): unknown {
  return JSON.parse(fixture(name).toString("utf8")) as unknown;
}

/** Python ContractModel adds schema_version; the TS types do not carry it. */
function stripSchemaVersion(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSchemaVersion);
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
      if (key !== "schema_version") result[key] = stripSchemaVersion(item);
    }
    return result;
  }
  return value;
}

describe("parse_geo_esearch parity", () => {
  test("keeps numeric UIDs distinct from accessions (golden)", () => {
    const page = parseGeoEsearch(fixture("geo_esearch.json"));
    expect(page).toEqual(stripSchemaVersion(golden("geo_esearch_page.golden.json")));
    expect(page.count).toBe(14);
    expect(page.ids[0]).toBe("200178352");
    expect(page.ids.every((id) => /^\d+$/.test(id))).toBe(true);
    expect(page.query_translation).toBe("GSE178352[Accession]");
  });
});

describe("parse_geo_esummary parity", () => {
  test("maps series uid to typed GSE record (golden)", () => {
    const records = parseGeoEsummary(fixture("geo_esummary.json"));
    expect(records).toEqual(
      stripSchemaVersion(golden("geo_esummary_records.golden.json")),
    );
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record.uid).toBe("200178352");
    expect(record.accession).toBe("GSE178352");
    expect(record.organism).toBe("Homo sapiens");
    expect(record.sample_count).toBe(12);
    expect(record.samples).toHaveLength(12);
    expect(new Set(record.samples.map((sample) => sample.accession)).size).toBe(12);
    expect(record.samples[0].accession).toBe("GSM5388281");
    expect(record.platform_ids).toEqual(["GPL24676"]);
    expect(record.pubmed_ids).toEqual(["34180400"]);
    expect(record.bioproject).toBe("PRJNA738534");
    expect(record.ftp_root.endsWith("/GSE178352/")).toBe(true);
  });

  test("tolerates empty n_samples (falls back to samples length)", () => {
    const payload = JSON.parse(
      fixture("geo_esummary.json").toString("utf8"),
    ) as {
      result: Record<string, Record<string, unknown>>;
    };
    payload.result["200178352"].n_samples = "";
    const records = parseGeoEsummary(
      Buffer.from(JSON.stringify(payload), "utf8"),
    );
    expect(records).toHaveLength(1);
    expect(records[0].sample_count).toBe(12);
  });
});

describe("safeInt parity", () => {
  test("handles ints, numeric strings and garbage", () => {
    expect(safeInt(7, 3)).toBe(7);
    expect(safeInt("12", 3)).toBe(12);
    expect(safeInt("", 3)).toBe(3);
    expect(safeInt(null, 3)).toBe(3);
    expect(safeInt("nope", 3)).toBe(3);
  });
});

describe("resolve_geo_supplementary_assets parity", () => {
  test("finds the counts asset separately (golden)", () => {
    const assets = resolveGeoSupplementaryAssets(
      fixture("geo_suppl_listing.html"),
      "https://ftp.ncbi.nlm.nih.gov/geo/series/GSE178nnn/GSE178352/suppl/",
    );
    expect(assets).toEqual(
      stripSchemaVersion(golden("geo_suppl_assets.golden.json")),
    );
    expect(assets).toHaveLength(1);
    expect(assets[0].filename).toBe("GSE178352_tximportCounts.txt.gz");
    expect(assets[0].url.endsWith("/GSE178352_tximportCounts.txt.gz")).toBe(true);
    expect(assets[0].media_type).toBe("application/gzip");
    expect(assets[0].data_level).toBe("repository_processed");
  });

  test("ignores parent-directory and unrelated links", () => {
    const html = Buffer.from(
      '<a href="/geo/series/GSE178nnn/GSE178352/">Parent Directory</a>\n' +
        '<a href="raw.tar.gz">ignored</a>\n' +
        '<a href="README.txt">ignored</a>\n' +
        '<a href="GSE178352_tximportCounts.txt.gz">kept</a>\n',
      "utf8",
    );
    const assets = resolveGeoSupplementaryAssets(html, "https://x.test/base/");
    expect(assets.map((asset) => asset.filename)).toEqual([
      "GSE178352_tximportCounts.txt.gz",
    ]);
  });
});

class FixtureDiscoveryClient implements GeoDiscoveryClient {
  constructor(
    private readonly searchIds: string[],
    private readonly summaryPayload: Buffer,
  ) {}

  readonly esummaryIds: string[][] = [];

  async esearch(request: {
    db: string;
    term: string;
    retmax: number;
  }): Promise<Uint8Array> {
    expect(request.db).toBe("gds");
    const payload = {
      esearchresult: {
        count: String(this.searchIds.length),
        retmax: String(request.retmax),
        retstart: "0",
        idlist: this.searchIds,
        querytranslation: `${request.term} translated`,
      },
    };
    return Buffer.from(JSON.stringify(payload), "utf8");
  }

  async esummary(request: { db: string; ids: string[] }): Promise<Uint8Array> {
    expect(request.db).toBe("gds");
    this.esummaryIds.push(request.ids);
    return this.summaryPayload;
  }
}

function singleRecordSummary(): Buffer {
  const payload = {
    result: {
      uids: ["200178352"],
      "200178352": {
        uid: "200178352",
        accession: "GSE178352",
        title: "Title",
        summary: "Summary",
        taxon: "Homo sapiens",
        entrytype: "GSE",
        gdstype: "Expression profiling by high throughput sequencing",
        gpl: "24676",
        n_samples: 2,
        samples: [
          { accession: "GSM5388281", title: "S1" },
          { accession: "GSM5388275", title: "S2" },
        ],
        pubmedids: ["34180400"],
        bioproject: "PRJNA738534",
        ftplink: "ftp://ftp.ncbi.nlm.nih.gov/geo/series/GSE178nnn/GSE178352/",
      },
    },
  };
  return Buffer.from(JSON.stringify(payload), "utf8");
}

describe("search_geo_series parity", () => {
  test("resolves numeric UIDs before returning accessions", async () => {
    const client = new FixtureDiscoveryClient(
      ["200178352"],
      singleRecordSummary(),
    );
    const result = await searchGeoSeries(client, "GSE178352[Accession]", 20);
    expect(result.query).toBe("GSE178352[Accession]");
    expect(result.query_translation).toBe("GSE178352[Accession] translated");
    expect(result.total_count).toBe(1);
    expect(result.records).toHaveLength(1);
    expect(result.records[0].accession).toBe("GSE178352");
  });

  test("deduplicates repeated accessions", async () => {
    const client = new FixtureDiscoveryClient(
      ["200178352", "200178352"],
      singleRecordSummary(),
    );
    const result = await searchGeoSeries(client, "q", 20);
    expect(result.records).toHaveLength(1);
  });

  test("batches more than 200 uids", async () => {
    const ids = Array.from({ length: 201 }, (_, index) => String(1000 + index));
    const client = new FixtureDiscoveryClient(
      ids,
      Buffer.from(JSON.stringify({ result: { uids: [] } })),
    );
    await searchGeoSeries(client, "batch", 201);
    expect(client.esummaryIds).toEqual([ids.slice(0, 200), ids.slice(200)]);
  });
});

describe("describe_geo_series parity", () => {
  test("finds the exact accession", async () => {
    const client = new FixtureDiscoveryClient(
      ["200178352"],
      singleRecordSummary(),
    );
    const record = await describeGeoSeries(client, "gse178352");
    expect(record.accession).toBe("GSE178352");
  });

  test("rejects a non-GSE accession before network", async () => {
    const client = new FixtureDiscoveryClient([], Buffer.from("{}"));
    await expect(describeGeoSeries(client, "200178352")).rejects.toThrow(
      /accession must be a GSE accession/,
    );
    expect(client.esummaryIds).toEqual([]);
  });

  test("raises LookupError when not found", async () => {
    const client = new FixtureDiscoveryClient([], Buffer.from("{}"));
    await expect(
      describeGeoSeries(client, "GSE999999"),
    ).rejects.toThrow(/GEO series not found: GSE999999/);
  });

  test("ValueError is exported", () => {
    expect(() => {
      throw new ValueError("boom");
    }).toThrow(ValueError);
  });
});
