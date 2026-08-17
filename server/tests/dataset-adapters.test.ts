import { describe, expect, test } from "vitest";

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseDownloadAttempt } from "../src/dataset/contracts/index.js";
import { join } from "node:path";

import { BufferedCsvWriter } from "../src/dataset/adapters/base.js";
import { csvLine } from "../src/dataset/adapters/text.js";
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