/**
 * P5-04 GeoExpressionAdapter tests (mirror
 * ``backend/tests/test_geo_adapter.py``): tximport / series matrix /
 * supplementary matrix with golden parity against the Python reference.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { describe, expect, test } from "vitest";

import type { AdapterParams, SourceAsset } from "../../src/dataset/contracts/index.js";
import { getAdapter } from "../../src/dataset/adapters/adapters.js";
import {
  ADAPTER_REGISTRY,
  AdapterError,
  EmptySourceError,
} from "../../src/dataset/adapters/index.js";
import {
  GeoExpressionAdapter,
  geoExpressionAdapter,
  type GeoParseOptions,
} from "../../src/dataset/adapters/geo/series-matrix.js";
import {
  delimitedRowsWithLines,
  delimitedRowsFromFileAsync,
} from "../../src/dataset/adapters/text.js";
import { assetIdFromSha256 } from "../../src/dataset/adapters/identity.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/geo", import.meta.url));

function fixturePath(name: string): string {
  return path.join(FIXTURES, name);
}

function golden(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(path.join(FIXTURES, name), "utf8"),
  ) as Record<string, unknown>;
}

function params(overrides: Partial<AdapterParams> = {}): AdapterParams {
  return {
    schema_version: "1.0",
    format: "series_matrix",
    value_semantics: "normalized_expression_value",
    value_scale: "log2",
    expression_unit: "normalized_expression_value",
    is_normalized: true,
    platform_ids: [],
    delimiter: "auto",
    ...overrides,
  };
}

function assetFor(sourcePath: string, sourceId = "src_geo"): SourceAsset {
  const bytes = readFileSync(sourcePath);
  const checksum = createHash("sha256").update(bytes).digest("hex");
  return {
    schema_version: "1.0",
    asset_id: assetIdFromSha256(checksum),
    kind: "source",
    relative_path: `source_assets/${path.basename(sourcePath)}`,
    sha256: checksum,
    size_bytes: bytes.length,
    media_type: "text/tab-separated-values",
    generated_by_step_id: null,
    source_id: sourceId,
    successful_attempt_id: "attempt_1",
    derived_from_asset_id: null,
    data_level: "repository_processed",
  };
}

async function runAdapter(
  sourcePath: string,
  parameters: AdapterParams,
  outputDir: string,
  options: Partial<GeoParseOptions> = {},
) {
  return geoExpressionAdapter.parse(assetFor(sourcePath), sourcePath, {
    requirementId: "build_geo",
    bindingId: "binding_geo",
    schemaRef: "gene_expression.probe_long.v1",
    outputDir,
    parameters,
    ...options,
  });
}

function parseCsv(text: string): Array<Record<string, string>> {
  const rows = delimitedRowsWithLines(text, ",");
  const header = rows[0]?.values ?? [];
  return rows.slice(1).map(({ values }) =>
    Object.fromEntries(header.map((column, index) => [column, values[index] ?? ""])),
  );
}

function writeFixtureFile(filePath: string, content: string | Buffer): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

function gzipText(text: string): Buffer {
  return gzipSync(Buffer.from(text, "utf8"));
}

function scratchDir(): string {
  return mkdtempSync(path.join(tmpdir(), "p5-geo-adapter-"));
}

describe("adapter registry", () => {
  test("geo.expression.v1 is registered and resolvable", () => {
    expect("geo.expression.v1" in ADAPTER_REGISTRY).toBe(true);
    const adapter = getAdapter("geo.expression.v1");
    expect(adapter).toBeInstanceOf(GeoExpressionAdapter);
    expect(adapter.adapter_id).toBe("geo.expression.v1");
    expect(adapter.version).toBe("1.1.0");
    expect(adapter.source_database).toBe("geo");
  });

  test("parse without AdapterParams is rejected", async () => {
    const outputDir = scratchDir();
    try {
      await expect(
        geoExpressionAdapter.parse(
          assetFor(fixturePath("tximport_counts_slice.tsv")),
          fixturePath("tximport_counts_slice.tsv"),
          {
            requirementId: "build_geo",
            bindingId: "binding_geo",
            schemaRef: "gene_expression.probe_long.v1",
            outputDir,
          },
        ),
      ).rejects.toThrow(AdapterError);
      expect(() => {
        // none of the batch files may survive a rejected parse
        return readFileSync(path.join(outputDir, "batches", "binding_geo.csv"));
      }).toThrow();
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});

describe("streaming GEO text input", () => {
  test("iterates gzip rows without materializing the full source text", async () => {
    const dir = scratchDir();
    const sourcePath = path.join(dir, "matrix.tsv.gz");
    writeFixtureFile(sourcePath, gzipText("!meta\tone\nID_REF\tS1\nprobe_1\t1.5\n"));
    const rows: Array<{ line: number; values: string[] }> = [];
    for await (const row of delimitedRowsFromFileAsync(sourcePath, "\t")) {
      rows.push(row);
    }
    expect(rows).toEqual([
      { line: 1, values: ["!meta", "one"] },
      { line: 2, values: ["ID_REF", "S1"] },
      { line: 3, values: ["probe_1", "1.5"] },
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("exposes raw line text when includeLineText is enabled", async () => {
    const dir = scratchDir();
    const sourcePath = path.join(dir, "matrix.tsv.gz");
    writeFixtureFile(sourcePath, gzipText("ID_REF\tS1\nprobe_1\t1.5\n"));
    const rows: Array<{ line: number; values: string[]; lineText?: string }> = [];
    for await (const row of delimitedRowsFromFileAsync(sourcePath, "\t", null, {
      includeLineText: true,
    })) {
      rows.push(row);
    }
    expect(rows[0].values).toEqual(["ID_REF", "S1"]);
    expect(rows[0].lineText).toBe("ID_REF\tS1");
    expect(rows[1].lineText).toBe("probe_1\t1.5");
    expect(rows[0].lineText).not.toContain("\n");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("series matrix golden parity", () => {
  test("standard microarray series matrix matches the Python golden", async () => {
    const outputDir = scratchDir();
    try {
      const batch = await runAdapter(
        fixturePath("geo_series_matrix.txt.gz"),
        params(),
        outputDir,
      );
      const expected = golden("geo_series_matrix_batch.golden.json");
      expect(batch.row_count).toBe(expected.row_count);
      const statistics = { ...batch.statistics };
      delete statistics.supporting_assets;
      expect(statistics).toEqual(expected.statistics);
      expect(batch.warnings).toEqual(expected.warnings);
      expect(batch.declared_mappings).toEqual(expected.mappings);
      const longRows = parseCsv(
        readFileSync(path.join(outputDir, "batches", "binding_geo.csv"), "utf8"),
      );
      expect(longRows).toEqual(expected.long_rows);
      const rejectedRows = parseCsv(
        readFileSync(
          path.join(outputDir, "batches", "binding_geo_rejected.csv"),
          "utf8",
        ),
      );
      expect(rejectedRows).toEqual(expected.rejected_rows);
      // Sample-metadata side table (Python supporting_assets parity). The
      // golden string is newline-normalized (Python universal newline read).
      const sampleMetadata = readFileSync(
        path.join(outputDir, "supporting", "binding_geo_sample_metadata.csv"),
        "utf8",
      ).replace(/\r\n/g, "\n");
      expect(sampleMetadata).toBe(expected.sample_metadata_csv);
      expect(batch.statistics.supporting_assets).toEqual([
        "supporting/binding_geo_sample_metadata.csv",
      ]);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("metadata-only series matrix fails closed with no table block", async () => {
    const outputDir = scratchDir();
    try {
      await expect(
        runAdapter(
          fixturePath("geo_metadata_only_matrix.txt.gz"),
          params(),
          outputDir,
        ),
      ).rejects.toThrow(/series_matrix_table_begin/);
      expect(() =>
        readFileSync(path.join(outputDir, "batches", "binding_geo.csv")),
      ).toThrow();
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});

describe("tximport counts golden parity", () => {
  test("real tximport slice matches the Python golden", async () => {
    const outputDir = scratchDir();
    try {
      const batch = await runAdapter(
        fixturePath("tximport_counts_slice.tsv"),
        params({
          format: "tximport_counts",
          value_semantics: "estimated_count",
          value_scale: "linear",
          expression_unit: "estimated_count",
          is_normalized: false,
        }),
        outputDir,
      );
      const expected = golden("geo_tximport_batch.golden.json");
      expect(batch.row_count).toBe(expected.row_count);
      const statistics = { ...batch.statistics };
      delete statistics.supporting_assets;
      expect(statistics).toEqual(expected.statistics);
      expect(batch.warnings).toEqual(expected.warnings);
      expect(batch.declared_mappings).toEqual(expected.mappings);
      const longRows = parseCsv(
        readFileSync(path.join(outputDir, "batches", "binding_geo.csv"), "utf8"),
      );
      expect(longRows).toEqual(expected.long_rows);
      const first = longRows[0];
      expect(first.gene_id_raw).toBe("ENSG00000000003");
      expect(first.gene_id_namespace_declared).toBe("ensembl_gene");
      expect(first.sample_id).toBe("A1");
      expect(first.value_semantics).toBe("estimated_count");
      expect(first.value_scale).toBe("linear");
      expect(first.is_normalized).toBe("false");
      expect(first.is_integer_expected).toBe("true");
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("missing counts columns fail closed", async () => {
    const outputDir = scratchDir();
    try {
      const badCounts = path.join(outputDir, "bad_counts.tsv");
      writeFixtureFile(badCounts, "gene\tS1\tS2\nENSG00000141510\t1\t2\n");
      await expect(
        runAdapter(
          badCounts,
          params({ format: "tximport_counts" }),
          outputDir,
        ),
      ).rejects.toThrow(/counts\./);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});

describe("supplementary matrix golden parity", () => {
  test("comma supplementary matrix matches the Python golden", async () => {
    const outputDir = scratchDir();
    try {
      const batch = await runAdapter(
        fixturePath("geo_supplementary_counts.csv"),
        params({
          format: "supplementary_matrix",
          value_semantics: "raw_count",
          value_scale: "linear",
          expression_unit: "counts",
          is_normalized: false,
        }),
        outputDir,
      );
      const expected = golden("geo_supplementary_batch.golden.json");
      expect(batch.row_count).toBe(expected.row_count);
      const statistics = { ...batch.statistics };
      delete statistics.supporting_assets;
      expect(statistics).toEqual(expected.statistics);
      expect(batch.warnings).toEqual(expected.warnings);
      expect(batch.declared_mappings).toEqual(expected.mappings);
      const longRows = parseCsv(
        readFileSync(path.join(outputDir, "batches", "binding_geo.csv"), "utf8"),
      );
      expect(longRows).toEqual(expected.long_rows);
      expect(longRows[0].gene_id_namespace_declared).toBe("geo_probe");
      expect(longRows[0].value_semantics).toBe("raw_count");
      expect(longRows[0].expression_unit).toBe("counts");
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("explicit delimiter and scale-only-from-parameters", async () => {
    const outputDir = scratchDir();
    try {
      const semicolon = path.join(outputDir, "semicolon.csv");
      writeFixtureFile(semicolon, "probe_id;S1;S2\nAFFX-BioB-5;1.5;2.0\n");
      const batch = await runAdapter(
        semicolon,
        params({
          format: "supplementary_matrix",
          delimiter: ";",
          value_scale: "linear",
          expression_unit: "counts",
          is_normalized: false,
        }),
        outputDir,
      );
      expect(batch.statistics.row_count).toBe(2);
      // The file name never implies a scale: same input, two scales.
      const csvPath = fixturePath("geo_supplementary_counts.csv");
      const log2Dir = path.join(outputDir, "log2");
      const linearDir = path.join(outputDir, "linear");
      const log2Batch = await runAdapter(
        csvPath,
        params({
          format: "supplementary_matrix",
          value_scale: "log2",
          expression_unit: "log2_expression",
        }),
        log2Dir,
      );
      const linearBatch = await runAdapter(
        csvPath,
        params({
          format: "supplementary_matrix",
          value_scale: "linear",
          expression_unit: "counts",
          is_normalized: false,
        }),
        linearDir,
      );
      const log2Rows = parseCsv(
        readFileSync(path.join(log2Dir, "batches", "binding_geo.csv"), "utf8"),
      );
      const linearRows = parseCsv(
        readFileSync(path.join(linearDir, "batches", "binding_geo.csv"), "utf8"),
      );
      expect(log2Rows.every((row) => row.value_scale === "log2")).toBe(true);
      expect(linearRows.every((row) => row.value_scale === "linear")).toBe(true);
      expect(log2Batch.row_count).toBe(4);
      expect(linearBatch.row_count).toBe(4);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});

describe("fail-closed structure checks", () => {
  test("truncated gzip fails closed and removes partial outputs", async () => {
    const outputDir = scratchDir();
    try {
      const full = readFileSync(fixturePath("geo_series_matrix.txt.gz"));
      const truncated = path.join(outputDir, "truncated.txt.gz");
      writeFixtureFile(truncated, full.subarray(0, Math.floor(full.length / 2)));
      await expect(runAdapter(truncated, params(), outputDir)).rejects.toThrow(
        /could not read|truncated or unreadable input/,
      );
      expect(() =>
        readFileSync(path.join(outputDir, "batches", "binding_geo.csv")),
      ).toThrow();
      expect(() =>
        readFileSync(
          path.join(outputDir, "batches", "binding_geo_rejected.csv"),
        ),
      ).toThrow();
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("checksum mismatch fails closed before parsing", async () => {
    const outputDir = scratchDir();
    try {
      const sourcePath = fixturePath("geo_series_matrix.txt.gz");
      const tampered: SourceAsset = {
        ...assetFor(sourcePath),
        asset_id: assetIdFromSha256("0".repeat(64)),
        sha256: "0".repeat(64),
      };
      await expect(
        geoExpressionAdapter.parse(tampered, sourcePath, {
          requirementId: "build_geo",
          bindingId: "binding_geo",
          schemaRef: "gene_expression.probe_long.v1",
          outputDir,
          parameters: params(),
        }),
      ).rejects.toThrow(/checksum/);
      expect(() => readFileSync(path.join(outputDir, "batches"))).toThrow();
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("duplicate sample headers fail closed", async () => {
    const outputDir = scratchDir();
    try {
      const dup = path.join(outputDir, "dup.txt.gz");
      writeFixtureFile(
        dup,
        gzipText(
          '!series_matrix_table_begin\n"ID_REF"\t"GSM1"\t"GSM1"\n' +
            '"AFFX-BioB-5"\t1.5\t2.0\n!series_matrix_table_end\n',
        ),
      );
      await expect(runAdapter(dup, params(), outputDir)).rejects.toThrow(/unique/);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("column-width mismatch fails closed", async () => {
    const outputDir = scratchDir();
    try {
      const width = path.join(outputDir, "width.txt.gz");
      writeFixtureFile(
        width,
        gzipText(
          '!series_matrix_table_begin\n"ID_REF"\t"GSM1"\t"GSM2"\n' +
            '"AFFX-BioB-5"\t1.5\n!series_matrix_table_end\n',
        ),
      );
      await expect(runAdapter(width, params(), outputDir)).rejects.toThrow(/field count/);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("non-finite cells are audited, not fatal", async () => {
    const outputDir = scratchDir();
    try {
      const nan = path.join(outputDir, "nan.txt.gz");
      writeFixtureFile(
        nan,
        gzipText(
          '!series_matrix_table_begin\n"ID_REF"\t"GSM1"\t"GSM2"\n' +
            '"AFFX-BioB-5"\t1.5\tnan\n"1007_s_at"\t3.0\tinf\n' +
            '"ENSG00000141510"\t5.0\t6.0\n!series_matrix_table_end\n',
        ),
      );
      const batch = await runAdapter(nan, params(), outputDir);
      expect(batch.statistics.row_count).toBe(4);
      expect(batch.statistics.rejected_count).toBe(2);
      const rejected = readFileSync(
        path.join(outputDir, "batches", "binding_geo_rejected.csv"),
        "utf8",
      );
      expect(rejected).toContain("non_finite_value");
      expect(rejected).toContain("nan");
      expect(rejected).toContain("inf");
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("zero valid rows raise a typed EmptySourceError", async () => {
    const outputDir = scratchDir();
    try {
      const empty = path.join(outputDir, "empty.txt.gz");
      writeFixtureFile(
        empty,
        gzipText(
          '!series_matrix_table_begin\n"ID_REF"\t"GSM1"\t"GSM2"\n' +
            '"AFFX-BioB-5"\tNA\tNA\n!series_matrix_table_end\n',
        ),
      );
      await expect(runAdapter(empty, params(), outputDir)).rejects.toThrow(EmptySourceError);
      try {
        await runAdapter(empty, params(), outputDir);
      } catch (error) {
        expect((error as EmptySourceError).reason_code).toBe("no_primary_data");
      }
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("header-only matrix raises EmptySourceError", async () => {
    const outputDir = scratchDir();
    try {
      // Header + no data rows (Python: "series matrix contains no data rows").
      const headerOnly = path.join(outputDir, "header_only.txt.gz");
      writeFixtureFile(
        headerOnly,
        gzipText(
          '!series_matrix_table_begin\n"ID_REF"\t"GSM1"\t"GSM2"\n' +
            "!series_matrix_table_end\n",
        ),
      );
      await expect(runAdapter(headerOnly, params(), outputDir)).rejects.toThrow(
        /contains no data rows/,
      );
      // Table block without any header line (Python: "header-only").
      const emptyBlock = path.join(outputDir, "empty_block.txt.gz");
      writeFixtureFile(
        emptyBlock,
        gzipText(
          "!series_matrix_table_begin\n!series_matrix_table_end\n",
        ),
      );
      await expect(runAdapter(emptyBlock, params(), outputDir)).rejects.toThrow(
        /header-only/,
      );
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});

describe("platform evidence", () => {
  test("multi-GPL evidence is recorded per sample", async () => {
    const outputDir = scratchDir();
    try {
      const multi = path.join(outputDir, "multi_gpl.txt.gz");
      writeFixtureFile(
        multi,
        gzipText(
          '!Sample_platform_id\t"GPL570"\t"GPL96"\n' +
            '!series_matrix_table_begin\n"ID_REF"\t"GSM1"\t"GSM2"\n' +
            '"PROBE1"\t1.5\t2.0\n!series_matrix_table_end\n',
        ),
      );
      const batch = await runAdapter(multi, params(), outputDir);
      expect(batch.statistics.platform_ids).toEqual(["GPL570", "GPL96"]);
      expect(batch.statistics.sample_platform_ids).toEqual({
        GSM1: "GPL570",
        GSM2: "GPL96",
      });
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("declared platform_ids conflicting with sample evidence fail closed", async () => {
    const outputDir = scratchDir();
    try {
      const mismatch = path.join(outputDir, "mismatch.txt.gz");
      writeFixtureFile(
        mismatch,
        gzipText(
          '!Sample_platform_id\t"GPL96"\t"GPL96"\n' +
            '!series_matrix_table_begin\n"ID_REF"\t"GSM1"\t"GSM2"\n' +
            '"PROBE1"\t1.5\t2.0\n!series_matrix_table_end\n',
        ),
      );
      await expect(
        runAdapter(mismatch, params({ platform_ids: ["GPL570"] }), outputDir),
      ).rejects.toThrow(/do not match/);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("incomplete sample platform evidence fails closed", async () => {
    const outputDir = scratchDir();
    try {
      const incomplete = path.join(outputDir, "incomplete.txt.gz");
      writeFixtureFile(
        incomplete,
        gzipText(
          '!Sample_platform_id\t"GPL570"\n' +
            '!series_matrix_table_begin\n"ID_REF"\t"GSM1"\t"GSM2"\n' +
            '"PROBE1"\t1.5\t2.0\n!series_matrix_table_end\n',
        ),
      );
      await expect(runAdapter(incomplete, params(), outputDir)).rejects.toThrow(
        /cover every sample/,
      );
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});

describe("explicit SOFT metadata (Python metadata_path parity)", () => {
  const TXIMPORT = "counts.S1\tcounts.S2\nENSG00000141510\t10\t20\nENSG00000000003\t30\t40\n";

  test("matching SOFT metadata publishes the sample side table", async () => {
    const outputDir = scratchDir();
    try {
      const counts = path.join(outputDir, "counts.tsv");
      writeFixtureFile(counts, TXIMPORT);
      const soft = path.join(outputDir, "matching.soft");
      writeFixtureFile(
        soft,
        "^SAMPLE = GSM1\n!Sample_description = Sample S1\n" +
          "^SAMPLE = GSM2\n!Sample_description = Sample S2\n",
      );
      const batch = await runAdapter(
        counts,
        params({
          format: "tximport_counts",
          value_semantics: "estimated_count",
          value_scale: "linear",
          expression_unit: "estimated_count",
          is_normalized: false,
        }),
        outputDir,
        { metadataPath: soft },
      );
      const sampleMetadata = parseCsv(
        readFileSync(
          path.join(outputDir, "supporting", "binding_geo_sample_metadata.csv"),
          "utf8",
        ),
      );
      expect(
        sampleMetadata.map((row) => [row.sample_id, row.source_sample_alias]),
      ).toEqual([
        ["GSM1", "S1"],
        ["GSM2", "S2"],
      ]);
      expect(batch.statistics.supporting_assets).toEqual([
        "supporting/binding_geo_sample_metadata.csv",
      ]);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("empty SOFT metadata fails closed", async () => {
    const outputDir = scratchDir();
    try {
      const counts = path.join(outputDir, "counts.tsv");
      writeFixtureFile(counts, TXIMPORT);
      const soft = path.join(outputDir, "empty.soft");
      writeFixtureFile(soft, "^SERIES = GSE1\n");
      await expect(
        runAdapter(
          counts,
          params({
            format: "tximport_counts",
            value_scale: "linear",
            is_normalized: false,
          }),
          outputDir,
          { metadataPath: soft },
        ),
      ).rejects.toThrow(/contains no SAMPLE records/);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("unrelated SOFT metadata fails closed with both id sets", async () => {
    const outputDir = scratchDir();
    try {
      const counts = path.join(outputDir, "counts.tsv");
      writeFixtureFile(counts, TXIMPORT);
      const soft = path.join(outputDir, "unrelated.soft");
      writeFixtureFile(soft, "^SAMPLE = GSM999\n!Sample_title = unrelated\n");
      await expect(
        runAdapter(
          counts,
          params({
            format: "tximport_counts",
            value_scale: "linear",
            is_normalized: false,
          }),
          outputDir,
          { metadataPath: soft },
        ),
      ).rejects.toThrow(/do not match expression sample IDs/);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});

describe("mixed valid/invalid bindings", () => {
  test("one binding failing does not disturb another binding's outputs", async () => {
    const outputDir = scratchDir();
    try {
      // Binding A: all-nan matrix -> EmptySourceError (no_primary_data).
      const nan = path.join(outputDir, "nan.txt.gz");
      writeFixtureFile(
        nan,
        gzipText(
          '!series_matrix_table_begin\n"ID_REF"\t"GSM1"\t"GSM2"\n' +
            '"AFFX-BioB-5"\tNA\tNA\n!series_matrix_table_end\n',
        ),
      );
      await expect(runAdapter(nan, params(), outputDir)).rejects.toThrow(
        /contains no valid expression rows/,
      );
      // Binding B: valid matrix in the same output dir still parses.
      const valid = path.join(outputDir, "valid.txt.gz");
      writeFixtureFile(
        valid,
        gzipText(
          '!series_matrix_table_begin\n"ID_REF"\t"GSM1"\t"GSM2"\n' +
            '"PROBE1"\t1.5\t2.0\n!series_matrix_table_end\n',
        ),
      );
      const batch = await runAdapter(valid, params(), outputDir);
      expect(batch.statistics.row_count).toBe(2);
      expect(readFileSync(path.join(outputDir, "batches", "binding_geo.csv"), "utf8")).toContain(
        "PROBE1",
      );
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});

describe("supplementary matrix bounding", () => {
  test("rejects a header that exceeds the maximum column count", async () => {
    const outputDir = scratchDir();
    try {
      const tooWide = path.join(outputDir, "too_wide.tsv");
      const header = `probe\t${Array.from({ length: 100_001 }, (_, i) => `s${i}`).join("\t")}\n`;
      writeFixtureFile(tooWide, `${header}gene1\t${Array.from({ length: 100_001 }, () => "1").join("\t")}\n`);
      await expect(
        runAdapter(
          tooWide,
          params({
            format: "supplementary_matrix",
            value_scale: "linear",
            expression_unit: "counts",
            is_normalized: false,
          }),
          outputDir,
        ),
      ).rejects.toThrow(/maximum column count/);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("rejects a single line longer than the line-length limit", async () => {
    const outputDir = scratchDir();
    try {
      const tooLong = path.join(outputDir, "too_long.tsv");
      writeFixtureFile(tooLong, `${"A".repeat(4_000_001)}\n`);
      await expect(
        runAdapter(
          tooLong,
          params({
            format: "supplementary_matrix",
            value_scale: "linear",
            expression_unit: "counts",
            is_normalized: false,
          }),
          outputDir,
        ),
      ).rejects.toThrow(/single-line length limit/);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
