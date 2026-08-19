/**
 * WP-A7 bounded-release-tail acceptance tests for the publisher tail:
 *
 * - Publish streams the copy WHILE hashing/counting and re-verifies the
 *   staged bytes against the manifest receipt (hash-while-copy), so a stale
 *   receipt / copy drift / target corruption is rejected before promotion.
 * - The disk budget is evaluated before any staging; an over-budget publish
 *   aborts with NO phantom version (or stage) directory.
 *
 * `copyArtifactVerifying` is exported for deterministic receipt-mismatch
 * coverage (a mid-copy mutation race against a live publish would be
 * non-deterministic); promotePublication covers the observable publish
 * invariants (byte-correct immutable version + no phantom on budget abort).
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import type { DatasetManifest } from "../src/dataset/contracts/manifest.js";
import type { ValidationResult } from "../src/dataset/contracts/validation.js";
import { parseDatasetManifest } from "../src/dataset/contracts/manifest.js";
import { parseValidationResult } from "../src/dataset/contracts/validation.js";
import { PUBLISH_DIR } from "../src/dataset/publish/invariants.js";
import {
  AtomicPromotionError,
  copyArtifactVerifying,
  promotePublication,
} from "../src/dataset/publish/publisher.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

function scratchRoot(name: string): string {
  const root = mkdtempSync(join(os.tmpdir(), `${name}-`));
  roots.push(root);
  return root;
}

function sha256Of(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface BuildMaterials {
  outputDir: string;
  primary: string;
  projectedBytes: number;
  versionName: string;
  manifest: DatasetManifest;
  validation: ValidationResult;
}

function buildMaterials(): BuildMaterials {
  const outputDir = join(scratchRoot("publish-tail"), "output");
  mkdirSync(outputDir, { recursive: true });
  const primary = "gene_id,value\nTP53,1.0\nBRCA1,0.5\nMYC,2.0\n";
  const primaryBytes = Buffer.byteLength(primary);
  const primarySha256 = sha256Of(Buffer.from(primary));
  const provenance = JSON.stringify({ sources: [], operations: [{ type: "load" }] });
  const provenanceBytes = Buffer.byteLength(provenance);
  const provenanceSha256 = sha256Of(Buffer.from(provenance));
  writeFileSync(join(outputDir, "primary.csv"), primary, "utf8");
  writeFileSync(join(outputDir, "provenance.json"), provenance, "utf8");
  const manifest = parseDatasetManifest({
    schema_version: "1.0",
    manifest_id: "manifest_publish_tail",
    task_id: "task_1",
    build_id: "build_1",
    dataset_family: "expression",
    row_granularity: "gene",
    schema_ref: "gene_expression.long.v1",
    row_count: 3,
    sha256: "0".repeat(64),
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
        sha256: provenanceSha256,
      },
    ],
  }) as DatasetManifest;
  const validation = parseValidationResult({
    schema_version: "1.0",
    manifest_digest: manifest.sha256,
    profile_ref: "minimal",
    status: "passed",
    checked_count: 3,
    failed_count: 0,
  }) as ValidationResult;
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
  const projectedBytes = primaryBytes + provenanceBytes + manifestBytes.length;
  const versionName = `${manifest.build_id}_${manifest.sha256.slice(0, 16)}`;
  return {
    outputDir,
    primary,
    projectedBytes,
    versionName,
    manifest,
    validation,
  };
}

describe("WP-A7 publisher tail", () => {
  it("hash-while-copy promotes a byte-correct immutable version (receipt matches)", async () => {
    const materials = buildMaterials();
    const result = await promotePublication({
      outputDir: materials.outputDir,
      manifest: materials.manifest,
      validation: materials.validation,
      publishedAt: "2026-08-19T00:00:00+00:00",
    });
    expect(result.versionDir).toBe(`publish/${materials.versionName}`);
    const versionDir = join(materials.outputDir, PUBLISH_DIR, materials.versionName);
    expect(existsSync(versionDir)).toBe(true);

    // The staged copy is byte-identical to the source (hash-while-copy wrote
    // the exact immutable bytes, not a blind copyFile that could drift).
    expect(readFileSync(join(versionDir, "primary.csv"), "utf8")).toBe(materials.primary);
    // The P7 receipt binds the exact manifest FILE BYTES.
    const manifestBytes = readFileSync(join(versionDir, "dataset_manifest.json"));
    const publication = JSON.parse(
      readFileSync(join(versionDir, "publication.json"), "utf8"),
    ) as { manifest_sha256: string };
    expect(publication.manifest_sha256).toBe(sha256Of(manifestBytes));
  });

  it("staged receipt mismatch (copy/source drift) rejects before promotion", async () => {
    const root = scratchRoot("publish-tail-mismatch");
    const src = join(root, "src.bin");
    const dest = join(root, "staged.bin");
    const bytes = Buffer.from("gene_id,value\nTP53,1\nMYC,2\n", "utf8");
    const realSha256 = sha256Of(bytes);
    writeFileSync(src, bytes);
    // A wrong source hash in the receipt — computed against the true bytes
    // so only the size is off, then a fully mismatched digest.
    await expect(
      copyArtifactVerifying(src, dest, { size_bytes: 99_999, sha256: realSha256 }, null),
    ).rejects.toBeInstanceOf(AtomicPromotionError);
    await expect(
      copyArtifactVerifying(src, dest, { size_bytes: bytes.byteLength, sha256: "deadbeef".repeat(8) }, null),
    ).rejects.toBeInstanceOf(AtomicPromotionError);
  });

  it("matching receipt commits the staged copy for promotion", async () => {
    const root = scratchRoot("publish-tail-match");
    const src = join(root, "src.bin");
    const dest = join(root, "staged.bin");
    const bytes = Buffer.from("gene_id,value\nTP53,1\nMYC,2\n", "utf8");
    writeFileSync(src, bytes);
    await copyArtifactVerifying(
      src,
      dest,
      { size_bytes: bytes.byteLength, sha256: sha256Of(bytes) },
      null,
    );
    expect(readFileSync(dest)).toEqual(bytes);
  });

  it("disk budget abort leaves no phantom version or stage directory", async () => {
    const materials = buildMaterials();
    // Set the budget strictly below the projected immutable size.
    await expect(
      promotePublication({
        outputDir: materials.outputDir,
        manifest: materials.manifest,
        validation: materials.validation,
        maxVersionBytes: materials.projectedBytes - 1,
        publishedAt: "2026-08-19T00:00:00+00:00",
      }),
    ).rejects.toThrow(/exceeds disk budget/);

    const publishDir = join(materials.outputDir, PUBLISH_DIR);
    expect(existsSync(join(publishDir, materials.versionName))).toBe(false);
    // No leftover staging directory either (abort before staging).
    if (existsSync(publishDir)) {
      expect(readdirSync(publishDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    }
  });
});