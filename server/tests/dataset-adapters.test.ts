import { describe, expect, test } from "vitest";

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { parseDownloadAttempt, parseSourceAsset } from "../src/dataset/contracts/index.js";
import { OperationAbortedError } from "../src/dataset/cooperative.js";
import { getAdapter } from "../src/dataset/adapters/index.js";
import { BufferedCsvWriter } from "../src/dataset/adapters/base.js";
import {
  csvLine,
  DelimitedBoundsError,
  delimitedRowsFromFileAsync,
  delimitedRowsWithLines,
} from "../src/dataset/adapters/text.js";
import {
  checkAdapterContractParity,
  checkAdapterFixtureParity,
  scratchOutputRoot,
} from "./adapters-parity.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

describe("Phase 4 step 4 adapters parity", () => {
  test("adapter contract invariants mirror the Python contract tests", async () => {
    expect(await checkAdapterContractParity()).toEqual([]);
  });

  test("GDC/Xena adapter fixture parity mirrors test_dataset_adapters.py", async () => {
    const issues = await checkAdapterFixtureParity({
      fixturesRoot: join(repoRoot, "tests", "fixtures"),
      outputRoot: scratchOutputRoot("adapter-vitest-"),
    });
    expect(issues).toEqual([]);
  });

  test("download attempt round-trips with schema_version 1.0", () => {
    const attempt = parseDownloadAttempt({
      attempt_id: "attempt_1",
      source_id: "src_geo",
      url: "https://example.test/counts.gz",
      status: "succeeded",
      bytes_received: 42,
      started_at: "2026-07-12T00:00:00Z",
      finished_at: "2026-07-12T00:00:01Z",
    });
    expect(attempt.schema_version).toBe("1.0");
    expect(attempt.status).toBe("succeeded");
  });
});

describe("BufferedCsvWriter (bounded-memory parse output)", () => {
  test("streams the header and rows to disk in bounded chunks", () => {
    const outputRoot = scratchOutputRoot("csv-writer-");
    const outputPath = join(outputRoot, "out.csv");
    const writer = new BufferedCsvWriter(outputPath, ["a", "b"], 4);
    writer.writeRow(["1", "2"]);
    writer.writeRow(["3", "4"]);
    expect(existsSync(outputPath)).toBe(false);
    writer.writeRow(["5", "6"]);
    expect(readFileSync(outputPath, "utf8")).toBe("a,b\r\n1,2\r\n3,4\r\n5,6\r\n");
    writer.writeRow(["7", "8"]);
    expect(readFileSync(outputPath, "utf8")).toBe("a,b\r\n1,2\r\n3,4\r\n5,6\r\n");
    writer.flush();
    expect(readFileSync(outputPath, "utf8")).toBe(
      "a,b\r\n1,2\r\n3,4\r\n5,6\r\n7,8\r\n",
    );
  });

  test("output is byte-identical to the single-join accumulation", () => {
    const outputRoot = scratchOutputRoot("csv-writer-join-");
    const outputPath = join(outputRoot, "out.csv");
    const writer = new BufferedCsvWriter(outputPath, ["x", "y"], 3);
    const rows = [
      ["1", "2"],
      ["3", "4"],
      ["5", "6"],
      ["7", "8"],
      ["9", "10"],
    ];
    for (const row of rows) {
      writer.writeRow(row);
    }
    writer.flush();
    const expected =
      csvLine(["x", "y"]) + rows.map((row) => csvLine(row)).join("");
    expect(readFileSync(outputPath, "utf8")).toBe(expected);
  });
});
function streamAsset(path: string, sourceId = "src_test") {
  const bytes = readFileSync(path);
  const checksum = createHash("sha256").update(bytes).digest("hex");
  return parseSourceAsset({
    schema_version: "1.0",
    asset_id: `asset_${checksum}`,
    kind: "source",
    relative_path: `source_assets/${basename(path)}`,
    sha256: checksum,
    size_bytes: bytes.length,
    media_type: "text/tab-separated-values",
    generated_by_step_id: null,
    source_id: sourceId,
    successful_attempt_id: "attempt_1",
    derived_from_asset_id: null,
    data_level: "repository_processed",
  });
}

describe("streaming source parsing (WP-A2)", () => {
  test("delimitedRowsFromFileAsync equals the array splitter row-for-row (plain + gzip)", async () => {
    const root = mkdtempSync(join(tmpdir(), "stream-pump-"));
    const text = [
      "# comment",
      "gene_id\tS1\tS2",
      "",
      "TP53\t1.5\t2.5",
      "BRCA1\t3\r\n",
    ].join("\n");
    const rows = delimitedRowsWithLines(text, "\t");

    const plainPath = join(root, "plain.tsv");
    writeFileSync(plainPath, text);
    const streamed: { line: number; values: string[] }[] = [];
    for await (const row of delimitedRowsFromFileAsync(plainPath, "\t")) {
      streamed.push(row);
    }
    expect(streamed).toEqual(rows);

    const gzipPath = join(root, "plain.tsv.gz");
    writeFileSync(gzipPath, gzipSync(Buffer.from(text, "utf8")));
    const streamedGz: { line: number; values: string[] }[] = [];
    for await (const row of delimitedRowsFromFileAsync(gzipPath, "\t")) {
      streamedGz.push(row);
    }
    expect(streamedGz).toEqual(rows);
  });

  test("bounded streaming rejects an oversized unterminated row", async () => {
    const root = mkdtempSync(join(tmpdir(), "stream-bounds-"));
    const sourcePath = join(root, "oversized.tsv");
    writeFileSync(sourcePath, "x".repeat(2 * 1024 * 1024));
    const rows = delimitedRowsFromFileAsync(sourcePath, "\t", undefined, {
      maxRowChars: 1024,
      maxFieldChars: 1024,
      maxRowFields: 2,
    });

    await expect(rows.next()).rejects.toBeInstanceOf(DelimitedBoundsError);
  });

  test("abort mid-stream stops consumption far before EOF (bounded memory)", async () => {
    const root = mkdtempSync(join(tmpdir(), "stream-abort-"));
    const bigPath = join(root, "big.tsv");
    const lineCount = 50_000;
    const lines = ["gene_id\tS1\tS2"];
    for (let i = 0; i < lineCount; i += 1) {
      lines.push(`ENSG${i}\t1.1\t2.2`);
    }
    writeFileSync(bigPath, lines.join("\n"));
    const controller = new AbortController();
    const gen = delimitedRowsFromFileAsync(bigPath, "\t", controller.signal);
    let pulled = 0;
    let error: unknown = null;
    try {
      for (;;) {
        const { done } = await gen.next();
        if (done) break;
        pulled += 1;
        if (pulled === 5) {
          controller.abort();
        }
      }
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(OperationAbortedError);
    expect(pulled).toBeGreaterThan(0);
    expect(pulled).toBeLessThan(10_000);
  });

  test("parse with an already-aborted signal fails closed with no batches dir", async () => {
    const root = mkdtempSync(join(tmpdir(), "adapter-abort-"));
    const srcPath = join(root, "src.tsv");
    writeFileSync(srcPath, "gene_id\tS1\nTP53\t1.5\nBRCA1\t3\n");
    const outDir = join(root, "out");
    const gdc = getAdapter("gdc.expression.v1");
    const controller = new AbortController();
    controller.abort();
    await expect(
      gdc.parse(streamAsset(srcPath), srcPath, {
        requirementId: "build_test",
        bindingId: "binding_1",
        schemaRef: "gene_expression.long.v1",
        outputDir: outDir,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(OperationAbortedError);
    expect(existsSync(join(outDir, "batches"))).toBe(false);
  });

  test("large matrix parses through the streaming path with exact row counts", async () => {
    const root = mkdtempSync(join(tmpdir(), "adapter-large-"));
    const srcPath = join(root, "large.tsv");
    const geneCount = 20_000;
    const sampleCount = 5;
    const header = ["gene_id"];
    for (let i = 0; i < sampleCount; i += 1) {
      header.push(`S${i + 1}`);
    }
    const lines = [header.join("\t")];
    for (let i = 0; i < geneCount; i += 1) {
      const fields = [`ENSG00000000000${i}`];
      for (let k = 0; k < sampleCount; k += 1) {
        fields.push(String(k + 0.1));
      }
      lines.push(fields.join("\t"));
    }
    writeFileSync(srcPath, lines.join("\n"));
    const batch = await getAdapter("gdc.expression.v1").parse(
      streamAsset(srcPath),
      srcPath,
      {
        requirementId: "build_test",
        bindingId: "binding_1",
        schemaRef: "gene_expression.long.v1",
        outputDir: join(root, "out"),
      },
    );
    expect(batch.statistics.source_row_count).toBe(geneCount);
    expect(batch.statistics.sample_count).toBe(sampleCount);
    expect(batch.row_count).toBe(geneCount * sampleCount);
    expect(existsSync(join(root, "out", "batches", "binding_1.csv"))).toBe(true);
  });
});