import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OperationResultManifest, ProductAssessment } from "@biomed/contracts";
import { afterEach, describe, expect, test } from "vitest";

import { canonicalDigest } from "../src/dataset/adapters/identity.js";
import {
  type AuthoritativePublicationReceipt,
  type AuthoritativePublicationResolution,
  type AuthoritativePublicationReuseRequest,
  verifyAuthoritativePublicationForReuse,
} from "../src/dataset/publish-verifier/index.js";

const DIGEST = "a".repeat(64);
const roots: string[] = [];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assessment(): ProductAssessment {
  return {
    schema_version: "1.0",
    requirement_id: "family_release.v1",
    package_id: "family_release",
    package_version: "1.0",
    product_status: "publishable",
    scores: ["schema", "relations", "identifiers", "provenance", "confidence", "reproducibility"].map(
      (dimension) => ({ dimension, score: 1, satisfied: 1, required: 1 }),
    ) as ProductAssessment["scores"],
    missing_requirements: [],
    blockers: [],
  };
}

async function fixture(): Promise<{
  request: AuthoritativePublicationReuseRequest;
  resolution: AuthoritativePublicationResolution;
}> {
  const root = await mkdtemp(join(tmpdir(), "publication-verifier-"));
  roots.push(root);
  const body = "publication bytes\n";
  const fileDigest = sha256(body);
  await writeFile(join(root, "dataset.csv"), body, "utf8");

  const dependencyClosure = {
    input_asset_ids: ["asset_1"],
    upstream_result_manifest_ids: ["validate_1"],
    parameter_digest: DIGEST,
    implementation_digest: DIGEST,
  };
  const operationResult: OperationResultManifest = {
    schema_version: "1.0",
    result_manifest_id: "result_1",
    task_id: "task_1",
    run_id: "run_1",
    requirement_id: "build_1",
    operation_id: "publish",
    operation_kind: "publish",
    operation_attempt_id: "attempt_1",
    attempt: 1,
    status: "succeeded",
    input_digest: DIGEST,
    parameter_digest: DIGEST,
    implementation_digest: DIGEST,
    output_digest: DIGEST,
    output_kind: "publication_manifest",
    output_summary: { publication_id: "publication_1", manifest_id: "manifest_1" },
    output_files: [{ relative_path: "dataset.csv", size_bytes: Buffer.byteLength(body), sha256: fileDigest }],
    dependency_closure: dependencyClosure,
    commit: { state: "committed", commit_id: "commit_1", committed_at: "2026-08-22T00:00:00Z" },
  };
  const assets = [{ asset_id: "asset_1", size_bytes: 4, sha256: "b".repeat(64) }];
  const unsigned = {
    schema_version: "1.0" as const,
    task_id: "task_1",
    requirement_id: "build_1",
    run_id: "run_1",
    attempt: 1,
    generation: 3,
    publication_id: "publication_1",
    manifest_id: "manifest_1",
    state: "published" as const,
    input_digest: DIGEST,
    parameter_digest: DIGEST,
    implementation_digest: DIGEST,
    dependency_digest: canonicalDigest(dependencyClosure),
    asset_digest: canonicalDigest(assets),
    assets,
    artifacts: [{ schema: "dataset.csv.v1", locator: "dataset.csv", size_bytes: Buffer.byteLength(body), sha256: fileDigest }],
    assessment: { requirement_id: "family_release.v1", package_id: "family_release", package_version: "1.0" },
  };
  const receipt: AuthoritativePublicationReceipt = {
    ...unsigned,
    receipt_digest: canonicalDigest(unsigned),
  };
  return {
    request: {
      task_id: "task_1",
      requirement_id: "build_1",
      run_id: "run_1",
      attempt: 1,
      publication_id: "publication_1",
      manifest_id: "manifest_1",
    },
    resolution: {
      receipt,
      operation_result: operationResult,
      assessment: assessment(),
      artifact_root: root,
      current_generation: 3,
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("authoritative publication verifier", () => {
  test("returns immutable evidence only after replaying every authoritative check", async () => {
    const { request, resolution } = await fixture();
    const result = await verifyAuthoritativePublicationForReuse(request, async () => resolution);

    expect(result.kind).toBe("authoritative_publication_evidence");
    expect(result.checks).toHaveLength(8);
    expect(result.checks.every((check) => check.passed)).toBe(true);
    expect(result).not.toHaveProperty("artifact_root");
    expect(Object.isFrozen(result)).toBe(true);
  });

  test("fails closed for missing, stale, tampered, or non-closed evidence", async () => {
    const { request, resolution } = await fixture();
    expect((await verifyAuthoritativePublicationForReuse(request, async () => null)).kind).toBe("not_reusable");

    const stale = { ...resolution, current_generation: 4 };
    expect((await verifyAuthoritativePublicationForReuse(request, async () => stale)).kind).toBe("not_reusable");

    await writeFile(join(resolution.artifact_root!, "dataset.csv"), "tampered\n", "utf8");
    expect((await verifyAuthoritativePublicationForReuse(request, async () => resolution)).kind).toBe("not_reusable");

    const fresh = await fixture();
    await writeFile(join(fresh.resolution.artifact_root!, "unreceipted.txt"), "extra", "utf8");
    expect((await verifyAuthoritativePublicationForReuse(fresh.request, async () => fresh.resolution)).kind).toBe("not_reusable");
  });

  test("does not execute receipt accessors or proxy traps", async () => {
    const { request, resolution } = await fixture();
    let accessed = false;
    const receipt: AuthoritativePublicationReceipt = { ...resolution.receipt! };
    Object.defineProperty(receipt, "state", { enumerable: true, get: () => { accessed = true; return "published"; } });
    expect((await verifyAuthoritativePublicationForReuse(request, async () => ({ ...resolution, receipt }))).kind).toBe("not_reusable");
    expect(accessed).toBe(false);

    const proxy = new Proxy(resolution.receipt!, { ownKeys: () => { throw new Error("trap executed"); } });
    expect((await verifyAuthoritativePublicationForReuse(request, async () => ({ ...resolution, receipt: proxy }))).kind).toBe("not_reusable");
  });
});
