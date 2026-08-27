/**
 * TASK-047-A7 limited-heap child (runs under vite-node with a capped
 * --max-old-space-size): writes a large <rowCount>-row gene-expression
 * primary.csv into <workRoot>, then runs the REAL release tail in-process —
 * profile validation + confidence scan (the release profile's
 * ``gene_expression.release.v1`` validate() drives both the validation checks
 * and the confidence-style streaming scan of the primary), provenance closure
 * + manifest-artifact verification (promotePublication's release gate), and
 * the bounded hash-while-copy publish — all against the multi-gigabyte-scale
 * streamed primary without materializing it.  Prints
 *
 *   tail <validationStatus> <primaryBytes> <publishedVersion>
 *
 * and exits 0 on success.  A release tail that buffered the whole primary
 * (readFile / JSON string) would exceed the capped heap before finishing.
 */

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { DatasetManifest } from "../../../src/dataset/contracts/manifest.js";
import { buildGeneExpressionSchema } from "../../../src/dataset/schema/index.js";
import { sha256FileStreamWithSize } from "../../../src/dataset/adapters/hashing.js";
import { getValidationProfile } from "../../../src/dataset/validation/profile.js";
import { writeConfidenceArtifact } from "../../../src/dataset/confidence/artifact.js";
import { parseDatasetManifest } from "../../../src/dataset/contracts/manifest.js";
import { promotePublication } from "../../../src/dataset/publish/publisher.js";

const HEADER =
  "record_id,dataset_id,source_id,asset_id,gene_id_raw,gene_id,gene_id_namespace,gene_id_version,sample_id,source_sample_alias,measurement_type,value_semantics,value_scale,is_normalized,is_integer_expected,expression_value,expression_unit,source_logical_file,source_line_number,source_column_index,source_column_name,source_raw_value";

function canonicalRow(index: number): string {
  const geneId = `gene_${index}`;
  const sampleId = `sample_${index}`;
  return [
    `record_${index}`,
    "dataset_demo",
    "source_demo",
    "asset_demo",
    geneId,
    geneId,
    "hgnc_symbol",
    "",
    sampleId,
    `sample_${index % 3}`,
    "expression",
    "raw",
    "linear",
    "false",
    "false",
    "1",
    "tpm",
    "demo.txt",
    "1",
    "0",
    "expression_value",
    "1",
  ].join(",");
}

function sha256Of(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const [workRootArg, rowCountArg] = process.argv.slice(2);
const workRoot = String(workRootArg);
const rowCount = Number(rowCountArg);

await mkdir(workRoot, { recursive: true });
const outputDir = join(workRoot, "output");
await mkdir(outputDir, { recursive: true });
const primaryPath = join(outputDir, "primary.csv");

await new Promise<void>((resolve, reject) => {
  const stream = createWriteStream(primaryPath, { highWaterMark: 4 << 20 });
  stream.on("error", reject);
  stream.write(`${HEADER}\r\n`);
  let rowIndex = 0;
  const pump = (): void => {
    while (rowIndex < rowCount) {
      const accepted = stream.write(`${canonicalRow(rowIndex++)}\r\n`);
      if (!accepted) {
        stream.once("drain", pump);
        return;
      }
    }
    stream.end(() => resolve());
  };
  pump();
});

// Confidence artifact: a single high-confidence, reviewed source batch so the
// release profile's confidence gate passes cleanly (the streaming confidence
// scan still runs against the full primary inside validate()).
await writeConfidenceArtifact(outputDir, {
  schema_version: "1.0",
  batch_defaults: [
    {
      schema_version: "1.0",
      batch_id: "batch_demo",
      record_count: rowCount,
      level: "high",
      channel: "integration",
      components: {
        source_reliability: "high",
        extraction_reliability: "high",
        mapping_reliability: "high",
        cross_source_consistency: "not_checked",
        human_review_state: "accepted",
      },
      reasons: [],
    },
  ],
  record_overrides: [],
});

// Bounded receipt for the primary (streamed hash + count, not readFile).
const { sha256: primarySha256, bytes: primaryBytes } = await sha256FileStreamWithSize(primaryPath);
if (primaryBytes <= 8 * 1024 * 1024) {
  console.error(`primary too small for a bounded-heap test: ${primaryBytes} bytes`);
  process.exit(1);
}

const provenance = JSON.stringify({
  sources: [{ source_id: "source_demo", asset_id: "asset_demo" }],
  operations: [{ type: "load", source_id: "source_demo", asset_id: "asset_demo" }],
});
await writeFile(join(outputDir, "provenance.json"), provenance, "utf8");
const provenanceBytes = Buffer.byteLength(provenance);

const manifest = parseDatasetManifest({
  schema_version: "1.0",
  manifest_id: "manifest_tail",
  task_id: "task_tail",
  requirement_id: "build_tail",
  dataset_family: "gene_expression",
  row_granularity: "gene_sample_measurement",
  schema_ref: "gene_expression.long.v1",
  row_count: rowCount,
  sha256: primarySha256,
  artifacts: [
    {
      schema_version: "1.0",
      artifact_id: "artifact_primary",
      role: "primary_dataset",
      relative_path: "primary.csv",
      media_type: "text/csv",
      size_bytes: primaryBytes,
      sha256: primarySha256,
    },
    {
      schema_version: "1.0",
      artifact_id: "artifact_provenance",
      role: "provenance",
      relative_path: "provenance.json",
      media_type: "application/json",
      size_bytes: provenanceBytes,
      sha256: sha256Of(provenance),
    },
  ],
}) as DatasetManifest;

// Run the release gate: validation + confidence + provenance + publish. The
// one validate() call covers the validation checks AND the streaming confidence
// scan; promotePublication covers provenance closure + artifact verification +
// the observed hash-while-copy publish.
const validation = await getValidationProfile("gene_expression.release.v1").validate({
  manifest,
  primaryPath,
  schema: buildGeneExpressionSchema(),
  manifestDigest: manifest.sha256,
  outputDir,
});

const published = await promotePublication({
  outputDir,
  manifest,
  validation,
  publishedAt: "2026-08-19T00:00:00+00:00",
});

console.log(`tail ${validation.status} ${primaryBytes} ${published.versionDir}`);
process.exit(validation.status === "passed" ? 0 : 1);