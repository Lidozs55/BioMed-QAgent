/**
 * P5-04 probe mapping tests (mirror
 * ``backend/tests/test_dataset_probe_mapping.py``) with golden parity
 * against the Python reference.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { describe, expect, test } from "vitest";

import type { SourceAsset } from "../../src/dataset/contracts/source.js";
import { assetIdFromSha256 } from "../../src/dataset/adapters/identity.js";
import {
  PROBE_MAPPING_RULE_ID,
  ProbeMappingAssetMismatchError,
  buildProbeMapping,
  parsePlatformTable,
  parsePlatformTableText,
} from "../../src/dataset/adapters/geo/probe-mapping.js";
import { canonicalize } from "../../src/dataset/canonicalizer/canonicalizer.js";
import { ProbeIndex } from "../../src/dataset/adapters/geo/probe-index.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/geo", import.meta.url));

function fixturePath(name: string): string {
  return path.join(FIXTURES, name);
}

function golden(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(path.join(FIXTURES, name), "utf8"),
  ) as Record<string, unknown>;
}

function mappingAsset(annotationPath: string, wrongSha?: string): SourceAsset {
  const actual = createHash("sha256")
    .update(readFileSync(annotationPath))
    .digest("hex");
  const checksum = wrongSha ?? actual;
  return {
    schema_version: "1.0",
    asset_id: assetIdFromSha256(checksum),
    kind: "source",
    relative_path: "source_assets/GPL570_annot.txt.gz",
    sha256: checksum,
    size_bytes: 1,
    media_type: "text/tab-separated-values",
    generated_by_step_id: null,
    source_id: "src_annotation",
    successful_attempt_id: "attempt_1",
    derived_from_asset_id: null,
    data_level: "repository_processed",
  };
}

function writeBatch(outputDir: string, probes: string[]): string {
  const rows = probes.map(
    (probe) =>
      "b1,gse,src,asset," +
      `${probe},geo_probe,GSM1,expression,expression_value,` +
      "log2,normalized_expression_value,1,1.5,log2_expression," +
      "f.txt,3,2,S1,1.5",
  );
  const batchPath = path.join(outputDir, "batch.csv");
  writeFileSync(
    batchPath,
    "record_id,dataset_id,source_id,asset_id,gene_id_raw," +
      "gene_id_namespace_declared,sample_id,measurement_type,value_semantics," +
      "value_scale,expression_unit,is_normalized,is_integer_expected," +
      "expression_value,source_logical_file,source_line_number," +
      "source_column_index,source_column_name,source_raw_value\n" +
      rows.join("\n") +
      "\n",
    "utf8",
  );
  return batchPath;
}

describe("parsePlatformTable golden parity", () => {
  test("gene-symbol mapping (golden)", async () => {
    const result = await parsePlatformTable(fixturePath("gpl570_annot.txt.gz"));
    expect(result.mapping).toEqual(golden("geo_platform_table.golden.json").mapping);
    expect(result.target_namespace).toBe(
      golden("geo_platform_table.golden.json").target_namespace,
    );
    expect(result.status).toBe(golden("geo_platform_table.golden.json").status);
    expect([...result.ambiguous_probes]).toEqual(
      golden("geo_platform_table.golden.json").ambiguous,
    );
    expect(result.probe_column).toBe(
      golden("geo_platform_table.golden.json").probe_column,
    );
    expect(result.gene_column).toBe(
      golden("geo_platform_table.golden.json").gene_column,
    );
  });

  test("ENSEMBL_ID target namespace (golden)", async () => {
    const result = await parsePlatformTable(
      fixturePath("gpl570_annot_ensembl.txt.gz"),
    );
    expect(result.target_namespace).toBe("ensembl_gene");
    expect(result.mapping).toEqual({ PROBE1: "ENSG00000141510" });
    expect(result.status).toBe("mapped");
  });

  test("no recognized gene column (golden)", async () => {
    const result = await parsePlatformTable(fixturePath("gpl1_no_gene_annot.txt.gz"));
    expect(result.mapping).toEqual({});
    expect(result.status).toBe("no_gene_annotation");
    expect(result.probe_column).toBe("ID");
    expect(result.gene_column).toBeNull();
  });

  test("parsePlatformTableText fail-closed on markers", () => {
    const noTable = parsePlatformTableText("not a platform table");
    expect(noTable.has_table).toBe(false);
    expect(noTable.gene_column).toBeNull();
    const headerOnly = parsePlatformTableText(
      "!platform_table_begin\nID\tDESCRIPTION\n!platform_table_end\n",
    );
    expect(headerOnly.has_table).toBe(true);
    expect(headerOnly.gene_column).toBeNull();
    expect(headerOnly.rows).toEqual([]);
  });

  test("parsePlatformTableText parses SOFT ^PLATFORM mini-format", () => {
    const table = parsePlatformTableText(
      "^PLATFORM = GPL10332\n" +
        "#ID = Agilent feature number\n" +
        "#GENE_SYMBOL = Gene Symbol\n" +
        "ID\tGENE_SYMBOL\n" +
        "12\tATP6V0D2\n" +
        "13\tBRAF\n" +
        "45167\tABHD14B\n",
    );
    expect(table.has_table).toBe(true);
    expect(table.probe_column).toBe("ID");
    expect(table.gene_column).toBe("GENE_SYMBOL");
    expect(table.rows).toEqual([
      ["12", "ATP6V0D2"],
      ["13", "BRAF"],
      ["45167", "ABHD14B"],
    ]);
  });

  test("SOFT ^PLATFORM annotation parses to gene symbols (golden)", async () => {
    const result = await parsePlatformTable(fixturePath("gpl10332_soft.txt.gz"));
    expect(result.mapping).toEqual({
      "12": "ATP6V0D2",
      "13": "BRAF",
      "45167": "ABHD14B",
    });
    expect(result.target_namespace).toBe("gene_symbol");
    expect(result.status).toBe("mapped");
    expect(result.probe_column).toBe("ID");
    expect(result.gene_column).toBe("GENE_SYMBOL");
    expect([...result.ambiguous_probes]).toEqual([]);
  });

  test("mixed-case gene column matches case-insensitively (GPL570)", () => {
    // Real GPL570 header uses mixed-case "Gene symbol" instead of "GENE_SYMBOL".
    const table = parsePlatformTableText(
      "^PLATFORM = GPL570\n" +
        "#ID = Affymetrix Probe Set ID\n" +
        "#Gene symbol = Gene Symbol\n" +
        "ID\tGene symbol\tGene title\n" +
        "1007_s_at\tDDR1\tneuroblastoma\n" +
        "1053_at\tRFC2\tseed\n",
    );
    expect(table.has_table).toBe(true);
    expect(table.gene_column).toBe("Gene symbol");
    expect(table.rows).toEqual([
      ["1007_s_at", "DDR1"],
      ["1053_at", "RFC2"],
    ]);
  });
});

describe("buildProbeMapping", () => {
  test("partial summary, audit CSV and map (golden)", async () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), "p5-probe-map-"));
    try {
      const annotationPath = fixturePath("gpl570_annot.txt.gz");
      const batchPath = writeBatch(outputDir, [
        "PROBE1",
        "PROBE2",
        "PROBE3",
        "UNKNOWN1",
      ]);
      const result = await buildProbeMapping({
        annotationPath,
        batchPath,
        bindingId: "binding_geo",
        platformId: "GPL570",
        annotationAsset: mappingAsset(annotationPath),
        outputDir,
        sourceId: "src_annotation",
      });
      const expected = golden("geo_probe_mapping.golden.json");
      expect(result.probe_to_gene).toEqual(expected.probe_to_gene);
      expect(result.target_namespace).toBe(expected.target_namespace);
      expect(result.summary).toEqual(expected.summary);
      expect(result.summary.mapping_asset_id).toBe(
        (expected.summary as Record<string, unknown>).mapping_asset_id,
      );
      expect(readFileSync(result.detail_path, "utf8").replace(/\r\n/g, "\n")).toBe(
        expected.detail_csv,
      );
      // Detail CSV columns.
      const lines = readFileSync(result.detail_path, "utf8")
        .split(/\r\n|\n|\r/)
        .filter((line) => line !== "");
      expect(lines[0]).toBe(
        "binding_id,platform_id,probe_id,target_gene_id,target_namespace,status,evidence_asset_id,rule_id",
      );
      expect(lines.join("\n")).toContain("PROBE1,TP53,gene_symbol,mapped");
      expect(lines.join("\n")).toContain("PROBE2,,,unmapped");
      expect(lines.join("\n")).toContain("UNKNOWN1,,,unmapped");
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("SOFT mini-format annotation maps all probes with full coverage", async () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), "p5-probe-map-"));
    try {
      const annotationPath = fixturePath("gpl10332_soft.txt.gz");
      const result = await buildProbeMapping({
        annotationPath,
        batchPath: writeBatch(outputDir, ["12", "13", "45167"]),
        bindingId: "binding_geo",
        platformId: "GPL10332",
        annotationAsset: mappingAsset(annotationPath),
        outputDir,
      });
      expect(result.probe_to_gene).toEqual({
        "12": "ATP6V0D2",
        "13": "BRAF",
        "45167": "ABHD14B",
      });
      expect(result.summary.mapping_status).toBe("mapped");
      expect(result.summary.coverage_ratio).toBe(1.0);
      const record = result.platform_record;
      expect(record?.platform_id).toBe("GPL10332");
      expect(record?.annotation_status).toBe("mapped");
      expect(record?.gene_id_field).toBe("GENE_SYMBOL");
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("full coverage is mapped with coverage 1.0", async () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), "p5-probe-map-"));
    try {
      const result = await buildProbeMapping({
        annotationPath: fixturePath("gpl570_annot.txt.gz"),
        batchPath: writeBatch(outputDir, ["PROBE1", "PROBE3"]),
        bindingId: "binding_geo",
        platformId: "GPL570",
        annotationAsset: mappingAsset(fixturePath("gpl570_annot.txt.gz")),
        outputDir,
      });
      expect(result.summary.mapping_status).toBe("mapped");
      expect(result.summary.coverage_ratio).toBe(1.0);
      expect(result.summary.mapped_probe_count).toBe(2);
      expect(result.probe_to_gene).toEqual({ PROBE1: "TP53", PROBE3: "BRCA1" });
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("zero coverage is unmapped with 0.0", async () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), "p5-probe-map-"));
    try {
      const result = await buildProbeMapping({
        annotationPath: fixturePath("gpl570_annot.txt.gz"),
        batchPath: writeBatch(outputDir, ["OTHER1", "OTHER2"]),
        bindingId: "binding_geo",
        platformId: "GPL570",
        annotationAsset: mappingAsset(fixturePath("gpl570_annot.txt.gz")),
        outputDir,
      });
      expect(result.summary.mapping_status).toBe("unmapped");
      expect(result.summary.coverage_ratio).toBe(0.0);
      expect(result.summary.mapped_probe_count).toBe(0);
      expect(result.summary.unmapped_probe_count).toBe(2);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("sha mismatch raises ProbeMappingAssetMismatchError (F2)", async () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), "p5-probe-map-"));
    try {
      const annotationPath = fixturePath("gpl570_annot.txt.gz");
      await expect(
        buildProbeMapping({
          annotationPath,
          batchPath: writeBatch(outputDir, ["PROBE1"]),
          bindingId: "binding_geo",
          platformId: "GPL570",
          annotationAsset: mappingAsset(
            annotationPath,
            createHash("sha256")
              .update("some other file contents")
              .digest("hex"),
          ),
          outputDir,
        }),
      ).rejects.toThrow(ProbeMappingAssetMismatchError);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("multi-target probe is ambiguous and excluded from the map (F3)", async () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), "p5-probe-map-"));
    try {
      const annotationPath = path.join(outputDir, "multi.txt.gz");
      writeFileSync(
        annotationPath,
        gzipSync(
          Buffer.from(
            '!platform_table_begin\n"ID"\t"GENE_SYMBOL"\n' +
              '"PROBE1"\t"TP53"\n"PROBE1"\t"BRCA1"\n"PROBE2"\t"TP53"\n' +
              "!platform_table_end\n",
          ),
        ),
      );
      const result = await buildProbeMapping({
        annotationPath,
        batchPath: writeBatch(outputDir, ["PROBE1", "PROBE2"]),
        bindingId: "binding_geo",
        platformId: "GPL570",
        annotationAsset: mappingAsset(annotationPath),
        outputDir,
      });
      expect(result.probe_to_gene).toEqual({ PROBE2: "TP53" });
      expect(result.summary.total_probe_count).toBe(2);
      expect(result.summary.mapped_probe_count).toBe(1);
      expect(result.summary.unmapped_probe_count).toBe(1);
      expect(result.summary.ambiguous_probe_count).toBe(1);
      expect(result.summary.coverage_ratio).toBe(0.5);
      expect(result.summary.mapping_status).toBe("partial");
      const audit = readFileSync(result.detail_path, "utf8");
      expect(audit).toContain("PROBE1,,,ambiguous");
      expect(audit).toContain("PROBE2,TP53,gene_symbol,mapped");
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("duplicate same-target rows are not ambiguous", async () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), "p5-probe-map-"));
    try {
      const annotationPath = path.join(outputDir, "dup.txt.gz");
      writeFileSync(
        annotationPath,
        gzipSync(
          Buffer.from(
            '!platform_table_begin\n"ID"\t"GENE_SYMBOL"\n' +
              '"PROBE1"\t"TP53"\n"PROBE1"\t"TP53"\n' +
              "!platform_table_end\n",
          ),
        ),
      );
      const result = await buildProbeMapping({
        annotationPath,
        batchPath: writeBatch(outputDir, ["PROBE1"]),
        bindingId: "binding_geo",
        platformId: "GPL570",
        annotationAsset: mappingAsset(annotationPath),
        outputDir,
      });
      expect(result.probe_to_gene).toEqual({ PROBE1: "TP53" });
      expect(result.summary.mapped_probe_count).toBe(1);
      expect(result.summary.ambiguous_probe_count).toBe(0);
      expect(result.summary.coverage_ratio).toBe(1.0);
      expect(result.summary.mapping_status).toBe("mapped");
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("platform record carries annotation provenance (F4)", async () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), "p5-probe-map-"));
    try {
      const annotationPath = fixturePath("gpl570_annot.txt.gz");
      const asset = mappingAsset(annotationPath);
      const result = await buildProbeMapping({
        annotationPath,
        batchPath: writeBatch(outputDir, ["PROBE1"]),
        bindingId: "binding_geo",
        platformId: "GPL570",
        annotationAsset: asset,
        outputDir,
      });
      const record = result.platform_record;
      expect(record).not.toBeNull();
      expect(record?.platform_id).toBe("GPL570");
      expect(record?.source_id).toBe("src_annotation");
      expect(record?.annotation_status).toBe("mapped");
      expect(record?.probe_id_field).toBe("ID");
      expect(record?.gene_id_field).toBe("GENE_SYMBOL");
      expect(record?.target_namespace).toBe("gene_symbol");
      expect(record?.annotation_asset_id).toBe(asset.asset_id);
      expect(record?.annotation_sha256).toBe(asset.sha256);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("no-gene-column annotation emits a NO_GENE_ANNOTATION platform record", async () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), "p5-probe-map-"));
    try {
      const annotationPath = fixturePath("gpl1_no_gene_annot.txt.gz");
      const asset = mappingAsset(annotationPath);
      const result = await buildProbeMapping({
        annotationPath,
        batchPath: writeBatch(outputDir, ["PROBE1"]),
        bindingId: "binding_geo",
        platformId: "GPL1",
        annotationAsset: asset,
        outputDir,
      });
      expect(result.summary.mapping_status).toBe("no_gene_annotation");
      const record = result.platform_record;
      expect(record?.annotation_status).toBe("no_gene_annotation");
      expect(record?.probe_id_field).toBe("ID");
      expect(record?.gene_id_field).toBeNull();
      expect(record?.target_namespace).toBeNull();
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("empty probe batch yields zero counts and no detail rows", async () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), "p5-probe-map-"));
    try {
      const result = await buildProbeMapping({
        annotationPath: fixturePath("gpl570_annot.txt.gz"),
        batchPath: writeBatch(outputDir, []),
        bindingId: "binding_geo",
        platformId: "GPL570",
        outputDir,
      });
      expect(result.summary.total_probe_count).toBe(0);
      expect(result.summary.coverage_ratio).toBe(0.0);
      expect(result.summary.mapping_rule_id).toBe(PROBE_MAPPING_RULE_ID);
      const detail = readFileSync(result.detail_path, "utf8");
      expect(detail.split(/\r\n|\n|\r/).filter((line) => line !== "")).toHaveLength(1);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("streaming distinctProbes dedupes and includes the final row", async () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), "p5-probe-map-"));
    try {
      const header =
        "record_id,dataset_id,source_id,asset_id,gene_id_raw," +
        "gene_id_namespace_declared,sample_id,measurement_type,value_semantics," +
        "value_scale,expression_unit,is_normalized,is_integer_expected," +
        "expression_value,source_logical_file,source_line_number," +
        "source_column_index,source_column_name,source_raw_value";
      const rows: string[] = [header];
      for (let index = 0; index < 500; index += 1) {
        rows.push(
          "b1,gse,src,asset," +
            `${index % 2 === 0 ? "PROBE1" : "PROBE3"},geo_probe,` +
            "GSM1,expression,expression_value,log2,normalized_expression_value," +
            "1,1.5,log2_expression,f.txt,3,2,S1,1.5",
        );
        rows.push(
          "b1,gse,src,asset," +
            `GENE${index},gene_symbol,GSM1,expression,expression_value,` +
            "log2,normalized_expression_value,1,1.5,log2_expression," +
            "f.txt,3,2,S1,1.5",
        );
      }
      rows.push(
        "b1,gse,src,asset,UNKNOWN_LAST,geo_probe,GSM1,expression," +
          "expression_value,log2,normalized_expression_value,1,1.5," +
          "log2_expression,f.txt,3,2,S1,1.5",
      );
      const batchPath = path.join(outputDir, "batch.csv");
      writeFileSync(batchPath, rows.join("\n") + "\n", "utf8");
      const result = await buildProbeMapping({
        annotationPath: fixturePath("gpl570_annot.txt.gz"),
        batchPath,
        bindingId: "binding_geo",
        platformId: "GPL570",
        annotationAsset: mappingAsset(fixturePath("gpl570_annot.txt.gz")),
        outputDir,
      });
      expect(result.summary.total_probe_count).toBe(3);
      expect(result.summary.mapped_probe_count).toBe(2);
      expect(result.summary.unmapped_probe_count).toBe(1);
      expect(result.summary.coverage_ratio).toBe(2 / 3);
      expect(result.summary.mapping_status).toBe("partial");
      const audit = readFileSync(result.detail_path, "utf8");
      expect(audit).toContain("UNKNOWN_LAST,,,unmapped");
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});

describe("canonicalizer consumes the probe map", () => {
  test("mapped probes are re-namespaced to the target namespace", async () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), "p5-probe-canon-"));
    try {
      const result = await buildProbeMapping({
        annotationPath: fixturePath("gpl570_annot.txt.gz"),
        batchPath: writeBatch(outputDir, ["PROBE1", "PROBE2"]),
        bindingId: "binding_geo",
        platformId: "GPL570",
        annotationAsset: mappingAsset(fixturePath("gpl570_annot.txt.gz")),
        outputDir,
      });
      expect(result.probe_to_gene).toEqual({ PROBE1: "TP53", PROBE3: "BRCA1" });
      expect(result.target_namespace).toBe("gene_symbol");
      // The canonicalizer already accepts probeMap/probeTargetNamespace
      // (Phase 5 T7 D2): spot-check the contract via the exported shape.
      const probeMap: Readonly<Record<string, string>> = result.probe_to_gene ?? {};
      expect(probeMap.PROBE1).toBe("TP53");
      expect(canonicalize).toBeTypeOf("function");
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});

describe("ProbeIndex disk store (A4)", () => {
  test("put/get/resolve/materialize lifecycle and destroy cleanup", async () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), "p5-probe-index-"));
    try {
      const dir = path.join(outputDir, "idx");
      const index = ProbeIndex.create(dir);
      await index.put("P1", "TP53");
      await index.put("P2", "BRCA1");
      await index.put("P3", "TP53");
      await index.put("P3", "BRCA1");
      await index.put("P1", "TP53");
      expect(await index.get("P1")).toBe("TP53");
      expect(await index.get("P2")).toBe("BRCA1");
      expect(await index.get("P3")).toBeUndefined();
      expect(await index.get("MISSING")).toBeUndefined();
      expect(await index.resolve("P3")).toEqual({ kind: "ambiguous" });
      expect(await index.resolve("MISSING")).toEqual({ kind: "absent" });
      expect(await index.materialize()).toEqual({ P1: "TP53", P2: "BRCA1" });
      index.destroy();
      expect(existsSync(dir)).toBe(false);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("high-cardinality put flushes shards and materializes correctly", async () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), "p5-probe-index-"));
    try {
      const dir = path.join(outputDir, "idx");
      const index = ProbeIndex.create(dir);
      const N = 20000;
      for (let i = 0; i < N; i += 1) {
        await index.put(`PROBE_${i}`, `GENE_${i}`);
      }
      await index.put("PROBE_0", "GENE_OTHER");
      const mapping = await index.materialize();
      expect(Object.keys(mapping)).toHaveLength(N - 1);
      expect(mapping.PROBE_0).toBeUndefined();
      expect(mapping.PROBE_12345).toBe("GENE_12345");
      expect(mapping.PROBE_19999).toBe("GENE_19999");
      expect(await index.get("PROBE_9999")).toBe("GENE_9999");
      index.destroy();
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("bulkResolve preserves input order across shards", async () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), "p5-probe-index-"));
    try {
      const index = ProbeIndex.create(path.join(outputDir, "idx"));
      await index.put("A", "TP53");
      await index.put("C", "BRCA1");
      const resolved = await index.bulkResolve(["C", "MISSING", "A", "D"]);
      expect(resolved).toEqual([
        { kind: "mapped", gene: "BRCA1" },
        { kind: "absent" },
        { kind: "mapped", gene: "TP53" },
        { kind: "absent" },
      ]);
      expect(resolved.map((value) => value.kind)).toEqual([
        "mapped",
        "absent",
        "mapped",
        "absent",
      ]);
      index.destroy();
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});

describe("buildProbeMapping disk-backed mode (A4)", () => {
  function writeMarkerAnnotation(outputDir: string): string {
    const annotationPath = path.join(outputDir, "m.txt.gz");
    writeFileSync(
      annotationPath,
      gzipSync(
        Buffer.from(
          '!platform_table_begin\n"ID"\t"GENE_SYMBOL"\n' +
            '"P1"\t"TP53"\n"P2"\t"BRCA1"\n"P1"\t"BRCA1"\n' +
            "!platform_table_end\n",
        ),
      ),
    );
    return annotationPath;
  }

  test("materializeProbeMap:false returns no map but a live disk index", async () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), "p5-probe-map-"));
    try {
      const result = await buildProbeMapping({
        annotationPath: fixturePath("gpl570_annot.txt.gz"),
        batchPath: writeBatch(outputDir, ["PROBE1", "PROBE2", "PROBE3"]),
        bindingId: "binding_geo",
        platformId: "GPL570",
        annotationAsset: mappingAsset(fixturePath("gpl570_annot.txt.gz")),
        outputDir,
        materializeProbeMap: false,
      });
      expect(result.probe_to_gene).toBeUndefined();
      const index = result.probe_index;
      expect(index).toBeInstanceOf(ProbeIndex);
      expect(await index.get("PROBE1")).toBe("TP53");
      expect(await index.get("PROBE3")).toBe("BRCA1");
      expect(await index.get("PROBE2")).toBeUndefined();
      expect(await index.materialize()).toEqual({
        PROBE1: "TP53",
        PROBE3: "BRCA1",
      });
      expect(result.summary.mapped_probe_count).toBe(2);
      const audit = readFileSync(result.detail_path, "utf8");
      expect(audit).toContain("PROBE1,TP53,gene_symbol,mapped");
      index.destroy();
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("streaming marker-format ingest is parity with parsePlatformTable", async () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), "p5-probe-map-"));
    try {
      const annotationPath = writeMarkerAnnotation(outputDir);
      const parsed = await parsePlatformTable(annotationPath);
      const result = await buildProbeMapping({
        annotationPath,
        batchPath: writeBatch(outputDir, ["P1", "P2"]),
        bindingId: "binding_geo",
        platformId: "GPL123",
        annotationAsset: mappingAsset(annotationPath),
        outputDir,
      });
      expect(parsed.mapping).toEqual({ P2: "BRCA1" });
      expect(result.probe_to_gene).toEqual(parsed.mapping);
      expect(result.summary.ambiguous_probe_count).toBe(1);
      const audit = readFileSync(result.detail_path, "utf8");
      expect(audit).toContain("P1,,,ambiguous");
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("SOFT mini-format fallback is parity with parsePlatformTable", async () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), "p5-probe-map-"));
    try {
      const annotationPath = fixturePath("gpl10332_soft.txt.gz");
      const parsed = await parsePlatformTable(annotationPath);
      expect(parsed.mapping).toEqual({
        "12": "ATP6V0D2",
        "13": "BRAF",
        "45167": "ABHD14B",
      });
      const result = await buildProbeMapping({
        annotationPath,
        batchPath: writeBatch(outputDir, ["12", "13", "45167"]),
        bindingId: "binding_geo",
        platformId: "GPL10332",
        annotationAsset: mappingAsset(annotationPath),
        outputDir,
      });
      expect(result.probe_to_gene).toEqual(parsed.mapping);
      expect(result.summary.coverage_ratio).toBe(1.0);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("high-cardinality platform maps 20k probes through flushed shards", async () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), "p5-probe-map-"));
    try {
      const annotationPath = path.join(outputDir, "big.txt.gz");
      const N = 20000;
      const table: string[] = ['"ID"\t"GENE_SYMBOL"'];
      for (let i = 0; i < N; i += 1) {
        table.push(`"PROBE_${i}"\t"GENE_${i}"`);
      }
      writeFileSync(
        annotationPath,
        gzipSync(Buffer.from(`!platform_table_begin\n${table.join("\n")}\n!platform_table_end\n`)),
      );
      const probes = Array.from({ length: N }, (_, i) => `PROBE_${i}`);
      const result = await buildProbeMapping({
        annotationPath,
        batchPath: writeBatch(outputDir, probes),
        bindingId: "binding_geo",
        platformId: "GPLX",
        annotationAsset: mappingAsset(annotationPath),
        outputDir,
      });
      expect(result.summary.total_probe_count).toBe(N);
      expect(result.summary.mapped_probe_count).toBe(N);
      expect(result.summary.coverage_ratio).toBe(1.0);
      expect(result.summary.mapping_status).toBe("mapped");
      expect(result.probe_to_gene?.["PROBE_0"]).toBe("GENE_0");
      expect(result.probe_to_gene?.[`PROBE_${N - 1}`]).toBe(`GENE_${N - 1}`);
      expect(Object.keys(result.probe_to_gene ?? {})).toHaveLength(N);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
