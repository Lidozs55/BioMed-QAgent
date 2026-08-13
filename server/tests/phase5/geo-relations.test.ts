/**
 * P5-04 GEO source relations (mirror
 * ``backend/tests/test_geo_source_relations.py``).
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import type { SourceRecord } from "../../src/dataset/contracts/source.js";
import {
  buildGeoSourceRelations,
  writeSourceRelations,
} from "../../src/dataset/adapters/geo/relations.js";
import type { GeoSeriesRecord } from "../../src/external/geo/parsers.js";

function geo(): GeoSeriesRecord {
  return {
    uid: "200178352",
    accession: "GSE178352",
    title: "",
    summary: "",
    organism: "",
    experiment_type: "",
    sample_count: 0,
    samples: [],
    platform_ids: [],
    pubmed_ids: ["34180400", "12345678", "34180400"],
    bioproject: null,
    ftp_root: "",
  };
}

function pubmedSource(): SourceRecord {
  return {
    schema_version: "1.0",
    source_id: "src_pubmed_34180400",
    database: "pubmed",
    accession: "34180400",
    url: "https://pubmed.ncbi.nlm.nih.gov/34180400/",
    title: "Primary article",
    retrieved_at: "2026-07-12T00:00:00Z",
  };
}

describe("build_geo_source_relations", () => {
  test("each evidenced pmid emits two sorted inverse rows", () => {
    const relations = buildGeoSourceRelations({
      geoSourceId: "src_geo_gse178352",
      geo: geo(),
      sources: [pubmedSource()],
    });
    expect(relations).toHaveLength(4);
    expect(new Set(relations.map((relation) => relation.relation_type))).toEqual(
      new Set([
        "article_describes_dataset",
        "dataset_described_by_article",
        "geo_references_pubmed",
        "pubmed_referenced_by_geo",
      ]),
    );
    const acquired = relations.filter(
      (relation) => relation.evidence_value === "34180400",
    );
    expect(new Set(acquired.map((relation) => relation.from_source_id))).toEqual(
      new Set(["src_geo_gse178352", "src_pubmed_34180400"]),
    );
    const external = relations.filter(
      (relation) => relation.evidence_value === "12345678",
    );
    expect(new Set(external.map((relation) => relation.from_source_id))).toEqual(
      new Set(["src_geo_gse178352", "ext:pubmed:12345678"]),
    );
    const keys = relations.map((relation) => [
      relation.from_source_id,
      relation.to_source_id,
      relation.relation_type,
      relation.evidence_type,
      relation.evidence_value,
    ]);
    const sorted = [...keys].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    expect(keys).toEqual(sorted);
    for (const relation of relations) {
      expect(relation.evidence_type).toBe("geo_pubmed_id");
      expect(relation.evidence_url).toBe(
        "https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE178352",
      );
    }
  });

  test("duplicate pmids emit only one pair of rows", () => {
    const relations = buildGeoSourceRelations({
      geoSourceId: "src_geo_gse178352",
      geo: geo(),
      sources: [pubmedSource()],
    });
    const pmidRows = relations.filter(
      (relation) => relation.evidence_value === "34180400",
    );
    expect(pmidRows).toHaveLength(2);
  });

  test("no geo metadata evidence emits no relation", () => {
    const relations = buildGeoSourceRelations({
      geoSourceId: "src_geo_gse178352",
      geo: { ...geo(), pubmed_ids: [] },
      sources: [],
    });
    expect(relations).toEqual([]);
  });
});

describe("write_source_relations", () => {
  test("writes the CSV without schema_version", () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), "p5-geo-rel-"));
    try {
      const relations = buildGeoSourceRelations({
        geoSourceId: "src_geo_gse178352",
        geo: geo(),
        sources: [pubmedSource()],
      });
      const filePath = path.join(outputDir, "relations.csv");
      writeSourceRelations(filePath, relations);
      const lines = readFileSync(filePath, "utf8")
        .split(/\r\n|\n|\r/)
        .filter((line) => line !== "");
      expect(lines[0]).toBe(
        "relation_id,from_source_id,to_source_id,relation_type,evidence_type,evidence_value,evidence_url",
      );
      expect(lines).toHaveLength(5);
      expect(lines.join("\n")).not.toContain("schema_version");
      expect(lines.join("\n")).toContain("rel_gse178352_pmid12345678");
      expect(lines.join("\n")).toContain("rel_gse178352_pmid34180400");
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
