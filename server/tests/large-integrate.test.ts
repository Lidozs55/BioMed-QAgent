import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { integrate } from "../src/dataset/integrator/integrator.js";
import { buildGeneExpressionSchema } from "../src/dataset/schema/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("large dataset integration", () => {
  test("integrates 10,000 canonical rows without error", async () => {
    const root = mkdtempSync(join(tmpdir(), "biomed-10k-"));
    roots.push(root);
    const canonicalDir = join(root, "canonical");
    mkdirSync(canonicalDir, { recursive: true });
    const canonicalPath = join(canonicalDir, "binding_gdc.csv");
    const lines = ["gene_id,sample_id,measurement_type,value_semantics,expression_value,asset_id"];
    for (let index = 0; index < 10_000; index += 1) {
      lines.push(`gene_${index},sample_${index},expression,raw,1.0,asset_${index}`);
    }
    writeFileSync(canonicalPath, `${lines.join("\n")}\n`, "utf8");

    const result = await integrate({
      results: [{
        batch: {
          batch_id: "batch_gdc",
          binding_id: "binding_gdc",
          dataset_family: "gene_expression",
          row_granularity: "gene_sample_measurement",
          schema_ref: "gene_expression.long.v1",
          file_asset: null,
          row_count: 10_000,
          column_count: 6,
          parser_id: "gdc.expression.v1",
          parser_version: "1.0",
          statistics: {},
          warnings: [],
          declared_mappings: [],
        },
        canonicalPath,
        rowCount: 10_000,
        rejectedCount: 0,
        namespaces: ["ensembl"],
        auditPaths: [],
      }],
      mergeStrategy: "append_by_canonical_row",
      schema: buildGeneExpressionSchema(),
      buildId: "build_10k",
      outputDir: join(root, "out"),
      signal: null,
    });

    expect(result.rowCount).toBe(10_000);
    expect(result.dedupCount).toBe(0);
    expect(result.conflictCount).toBe(0);
  });
});