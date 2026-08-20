import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  buildGoldDiagnosticMatrix,
  goldDiagnosticExitCode,
  serializeGoldDiagnosticMatrix,
  writeGoldDiagnosticMatrixAtomic,
} from "../../src/evaluation/gold-diagnostic-matrix.js";

const TARGET_COMMIT = "a".repeat(40);
const OLD_COMMIT = "b".repeat(40);
const roots: string[] = [];

async function json(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function fixture(caseIds: readonly string[]): Promise<{ evidenceRoot: string; goldRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "gold-matrix-"));
  roots.push(root);
  const evidenceRoot = join(root, "evidence");
  const goldRoot = join(root, "gold");
  await mkdir(evidenceRoot);
  await mkdir(join(goldRoot, "cases"), { recursive: true });
  await mkdir(join(goldRoot, "prompts"), { recursive: true });
  await mkdir(join(goldRoot, "schemas"), { recursive: true });
  await mkdir(join(goldRoot, "historical"), { recursive: true });
  await json(join(goldRoot, "runtime.json"), { operation_timeout_ms: 1_000 });
  await json(join(goldRoot, "manifest.json"), {
    manifest_id: "fixture-v1",
    manifest_version: 1,
    runtime_profile: "runtime.json",
    cases: caseIds.map((caseId) => ({ case_id: caseId, spec: `cases/${caseId}.json` })),
  });
  for (const caseId of caseIds) {
    await writeFile(join(goldRoot, "prompts", `${caseId}.txt`), `Build ${caseId}\n`, "utf8");
    await json(join(goldRoot, "cases", `${caseId}.json`), {
      case_id: caseId,
      prompt_file: `prompts/${caseId}.txt`,
      schema_ref: `schemas/${caseId}.json`,
    });
    await json(join(goldRoot, "schemas", `${caseId}.json`), {
      schema_id: `${caseId}.v1`,
      version: "1.0",
      family: "fixture_family",
      tables: [{
        table_id: "records",
        role: "primary",
        granularity: "record",
        primary_key: ["record_id"],
        columns: ["record_id", "source_id"],
        allow_empty: false,
      }],
      relations: [],
      required_provenance: ["source_id"],
    });
    await json(join(goldRoot, "historical", `${caseId}.runs.json`), {
      admissible_as_current_evidence: false,
    });
  }
  return { evidenceRoot, goldRoot };
}

async function addEvidence(
  roots: { evidenceRoot: string; goldRoot: string },
  caseId: string,
  productCommit: string,
): Promise<void> {
  const manifestPath = join(roots.goldRoot, "manifest.json");
  const casePath = join(roots.goldRoot, "cases", `${caseId}.json`);
  const promptPath = join(roots.goldRoot, "prompts", `${caseId}.txt`);
  const runtimePath = join(roots.goldRoot, "runtime.json");
  const identity = {
    manifest_id: "fixture-v1",
    manifest_version: 1,
    manifest_sha256: await sha256(manifestPath),
    case_id: caseId,
    case_spec_sha256: await sha256(casePath),
    prompt_sha256: await sha256(promptPath),
    runtime_profile_sha256: await sha256(runtimePath),
    product_commit: productCommit,
    request_id: `request-${caseId}`,
  };
  await json(join(roots.evidenceRoot, `accept-${caseId}.json`), {
    ...identity,
    accepted: { request_id: identity.request_id, task_id: `task-${caseId}`, run_id: `run-${caseId}`, status: "queued" },
  });
  await json(join(roots.evidenceRoot, `evidence-${caseId}.json`), {
    case_id: caseId,
    product_commit: productCommit,
    identity,
    task_id: `task-${caseId}`,
    run_id: `run-${caseId}`,
    terminal: {
      task: { task_id: `task-${caseId}`, status: "completed" },
      run: { run_id: `run-${caseId}`, status: "completed", summary: {} },
      publications: [],
    },
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Gold diagnostic matrix", () => {
  test("keeps every manifest case, sorts reports, and aggregates missing evidence", async () => {
    const paths = await fixture(["case-z", "case-a"]);
    const matrix = await buildGoldDiagnosticMatrix({
      evidence_root: paths.evidenceRoot,
      gold_root: paths.goldRoot,
      target_product_commit: TARGET_COMMIT,
    });

    expect(matrix.cases.map((report) => report.case_id)).toEqual(["case-a", "case-z"]);
    expect(matrix.aggregate.total).toBe(2);
    expect(matrix.aggregate.strict_status).toEqual({ pass: 0, fail: 2, blocked: 0 });
    expect(matrix.aggregate.finding_codes["evidence.accept_missing"]).toBe(2);
    expect(matrix.aggregate.finding_codes["evidence.terminal_missing"]).toBe(2);
    expect(matrix.evidence_gaps).toEqual([
      { case_id: "case-a", checks: ["execution", "publication", "semantic_product", "trusted_inputs"] },
      { case_id: "case-z", checks: ["execution", "publication", "semantic_product", "trusted_inputs"] },
    ]);
    expect(goldDiagnosticExitCode(matrix)).toBe(2);
  });

  test("reports a wrong product commit without upgrading completed execution", async () => {
    const paths = await fixture(["case-a"]);
    await addEvidence(paths, "case-a", OLD_COMMIT);
    const matrix = await buildGoldDiagnosticMatrix({
      evidence_root: paths.evidenceRoot,
      gold_root: paths.goldRoot,
      target_product_commit: TARGET_COMMIT,
    });

    expect(matrix.cases[0]?.checks.execution).toBe("pass");
    expect(matrix.cases[0]?.checks.reproducibility).toBe("fail");
    expect(matrix.cases[0]?.strict_status).toBe("fail");
    expect(matrix.cases[0]?.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "identity.product_commit_mismatch", severity: "blocker" }),
    ]));
  });

  test("serializes deterministically and writes an explicit output atomically", async () => {
    const paths = await fixture(["case-a"]);
    const matrix = await buildGoldDiagnosticMatrix({
      evidence_root: paths.evidenceRoot,
      gold_root: paths.goldRoot,
      target_product_commit: TARGET_COMMIT,
    });
    const first = serializeGoldDiagnosticMatrix(matrix);
    const second = serializeGoldDiagnosticMatrix(matrix);
    expect(second).toBe(first);
    const output = join(paths.evidenceRoot, "matrix.json");
    await writeGoldDiagnosticMatrixAtomic(output, first);
    expect(await readFile(output, "utf8")).toBe(first);
  });

  test("rejects malformed manifests, reference files, and escaping spec paths", async () => {
    const malformed = await fixture(["case-a"]);
    await json(join(malformed.goldRoot, "manifest.json"), { cases: "invalid" });
    await expect(buildGoldDiagnosticMatrix({
      evidence_root: malformed.evidenceRoot,
      gold_root: malformed.goldRoot,
      target_product_commit: TARGET_COMMIT,
    })).rejects.toThrow(/cases/);

    const badReference = await fixture(["case-a"]);
    await json(join(badReference.goldRoot, "schemas", "case-a.json"), { schema_id: "incomplete" });
    await expect(buildGoldDiagnosticMatrix({
      evidence_root: badReference.evidenceRoot,
      gold_root: badReference.goldRoot,
      target_product_commit: TARGET_COMMIT,
    })).rejects.toThrow();

    const escaping = await fixture(["case-a"]);
    await json(join(escaping.goldRoot, "manifest.json"), {
      cases: [{ case_id: "case-a", spec: "../outside.json" }],
    });
    await expect(buildGoldDiagnosticMatrix({
      evidence_root: escaping.evidenceRoot,
      gold_root: escaping.goldRoot,
      target_product_commit: TARGET_COMMIT,
    })).rejects.toThrow(/escapes Gold root/);
  });

  test("requires explicit existing roots and a lowercase commit", async () => {
    const paths = await fixture(["case-a"]);
    await expect(buildGoldDiagnosticMatrix({
      evidence_root: paths.evidenceRoot,
      gold_root: paths.goldRoot,
      target_product_commit: "not-a-commit",
    })).rejects.toThrow(/target_product_commit/);
    await expect(buildGoldDiagnosticMatrix({
      evidence_root: join(paths.evidenceRoot, "missing"),
      gold_root: paths.goldRoot,
      target_product_commit: TARGET_COMMIT,
    })).rejects.toThrow();
    expect(paths.goldRoot).toContain("gold-matrix-");
  });
});
