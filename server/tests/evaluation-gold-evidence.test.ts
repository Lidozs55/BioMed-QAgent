import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { loadGoldEvidenceInventory } from "../src/evaluation/gold-evidence/inventory.js";

const commit = "a".repeat(40);
const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "biomed-evidence-"));
  roots.push(root);
  return root;
}

async function writeJson(root: string, name: string, value: unknown): Promise<void> {
  await writeFile(join(root, name), `${JSON.stringify(value)}\n`, "utf8");
}

function accepted(caseId = "case-a") {
  return {
    manifest_id: "fixture-manifest",
    manifest_version: 1,
    manifest_sha256: "b".repeat(64),
    case_id: caseId,
    case_spec_sha256: "c".repeat(64),
    prompt_sha256: "d".repeat(64),
    runtime_profile_sha256: "e".repeat(64),
    product_commit: commit,
    request_id: "request-a",
    base_url: "http://127.0.0.1:8000",
    dry_run: false,
    accepted: {
      schema_version: "1.0",
      request_id: "request-a",
      task_id: "task-a",
      run_id: "run-a",
      status: "queued",
    },
  };
}

function evidence(caseId = "case-a", productCommit = commit) {
  return {
    case_id: caseId,
    product_commit: productCommit,
    request_id: "request-a",
    task_id: "task-a",
    run_id: "run-a",
    terminal: {
      status: "completed",
      run: {
        run_id: "run-a",
        task_id: "task-a",
        status: "completed",
        summary: {
          build_result: {
            status: "succeeded",
            build_id: "build-a",
            publication_id: "publication-a",
          },
        },
      },
      task: {
        task_id: "task-a",
        status: "completed",
        artifact_count: 2,
      },
    },
  };
}

function assessment(status: "publishable" | "validated" | "incomplete") {
  const dimensions = ["schema", "relations", "identifiers", "provenance", "confidence", "reproducibility"];
  const incomplete = status === "incomplete";
  const validated = status === "validated";
  return {
    schema_version: "1.0",
    requirement_id: "fixture.release.v1",
    package_id: "fixture_package",
    package_version: "1.0",
    product_status: status,
    scores: dimensions.map((dimension) => ({
      dimension,
      score: incomplete && dimension === "identifiers" || validated && dimension === "reproducibility" ? 0 : 1,
      satisfied: incomplete && dimension === "identifiers" || validated && dimension === "reproducibility" ? 0 : 1,
      required: 1,
    })),
    missing_requirements: incomplete ? ["fixture_identity"] : validated ? ["fixture_artifacts"] : [],
    blockers: incomplete ? [{
      requirement_id: "fixture_identity",
      dimension: "identifiers",
      code: "identity_not_closed",
      message: "Identity closure is incomplete",
    }] : validated ? [{
      requirement_id: "fixture_artifacts",
      dimension: "reproducibility",
      code: "artifact_incomplete",
      message: "Publication artifacts are incomplete",
    }] : [],
  };
}

function evidenceWithAssessment(status: "publishable" | "validated" | "incomplete") {
  const base = evidence();
  const artifactId = "artifact-assessment";
  const utf8 = `${JSON.stringify(assessment(status))}\n`;
  const digest = createHash("sha256").update(utf8).digest("hex");
  const size = Buffer.byteLength(utf8);
  return {
    ...base,
    terminal: {
      ...base.terminal,
      run: {
        ...base.terminal.run,
        summary: {
          build_result: {
            status: "succeeded",
            valid_row_count: 2,
            successful_sources: ["source-a"],
            rejected_sources: [],
            available_artifact_roles: ["audit_report"],
            publication_id: "publication-a",
            reason_codes: [],
            user_summary: "Published fixture assessment.",
            recommended_next_action: "none",
            build_id: "build-a",
          },
        },
      },
    },
    events: [{
      schema_version: "2.0",
      event_id: "event-publication",
      type: "publication_created",
      task_id: "task-a",
      run_id: "run-a",
      sequence: 1,
      timestamp: "2026-08-20T00:00:01.000Z",
      payload: {
        type: "publication_created",
        publication_id: "publication-a",
        run_id: "run-a",
        manifest_sha256: "8".repeat(64),
        supersedes_publication_id: null,
        published_at: "2026-08-20T00:00:01.000Z",
      },
    }, {
      schema_version: "2.0",
      event_id: "event-assessment",
      type: "artifact_produced",
      task_id: "task-a",
      run_id: "run-a",
      sequence: 2,
      timestamp: "2026-08-20T00:00:02.000Z",
      payload: {
        type: "artifact_produced",
        artifact: {
          artifact_id: artifactId,
          name: "product_assessment.json",
          relative_path: "product_assessment.json",
          size_bytes: size,
          sha256: digest,
        },
      },
    }],
    artifact_list: [{
      artifact_id: artifactId,
      name: "product_assessment.json",
      size,
      sha256: digest,
    }],
    artifact_hashes: [{
      artifact_id: artifactId,
      name: "product_assessment.json",
      size_bytes: size,
      sha256: digest,
    }],
    publication_artifacts: {
      schema_version: "1.0",
      publication_id: "publication-a",
      artifact_list: [{
        artifact_id: artifactId,
        name: "product_assessment.json",
        size,
        sha256: digest,
      }],
      artifact_hashes: [{
        artifact_id: artifactId,
        name: "product_assessment.json",
        size_bytes: size,
        sha256: digest,
      }],
      artifact_contents: {
        [artifactId]: {
          artifact_id: artifactId,
          utf8,
        },
      },
    },
  };
}

async function writePair(
  root: string,
  caseId = "case-a",
  productCommit = commit,
): Promise<void> {
  await writeJson(root, `accept-${caseId}.json`, accepted(caseId));
  await writeJson(root, `evidence-${caseId}.json`, evidence(caseId, productCommit));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("loadGoldEvidenceInventory", () => {
  test("loads observed task/run/build facts without promoting publication to reproducibility", async () => {
    const root = await makeRoot();
    await writePair(root);
    const result = await loadGoldEvidenceInventory({
      evidence_root: root,
      case_id: "case-a",
      target_product_commit: commit,
    });

    expect(result.identity.status).toBe("pass");
    expect(result.observed).toMatchObject({
      task_status: "completed",
      run_status: "completed",
      build_status: "succeeded",
      build_id: "build-a",
      build_publication_id: "publication-a",
      artifact_count: 2,
    });
    expect(result.checks.publication).toBe("unknown");
    expect(result.checks.reproducibility).toBe("unknown");
    expect(result.trusted_evidence_chain?.terminal.state).toBe("present");
    expect(result.trusted_evidence_chain?.publication.state).toBe("missing");
    expect(result.trusted_evidence_chain?.gaps.map((gap) => gap.code)).toEqual(expect.arrayContaining([
      "build.malformed",
      "publication.missing",
    ]));
    expect(result.trusted_evidence_chain?.semantic_product.state).toBe("missing");
    expect(result.findings.map((item) => item.code)).toContain("chain.semantic_product.not_projected");
  });

  test.each([
    ["publishable", "pass"],
    ["validated", "unknown"],
    ["incomplete", "fail"],
  ] as const)("maps a verified %s ProductAssessment to semantic_product=%s", async (status, expected) => {
    const root = await makeRoot();
    await writeJson(root, "accept-case-a.json", accepted());
    await writeJson(root, "evidence-case-a.json", evidenceWithAssessment(status));
    const result = await loadGoldEvidenceInventory({
      evidence_root: root,
      case_id: "case-a",
      target_product_commit: commit,
      expected_product_assessment: {
        requirement_id: "fixture.release.v1",
        package_id: "fixture_package",
        package_version: "1.0",
      },
    });

    expect(result.checks.semantic_product).toBe(expected);
    expect(result.trusted_evidence_chain?.semantic_product).toMatchObject({
      state: "present",
      projected: true,
      product_status: status,
    });
    expect(result.findings.map((item) => item.code)).not.toContain(
      "reproducibility.artifact_verification_missing",
    );
  });

  test("does not pass a publishable assessment for another expected package", async () => {
    const root = await makeRoot();
    await writeJson(root, "accept-case-a.json", accepted());
    await writeJson(root, "evidence-case-a.json", evidenceWithAssessment("publishable"));
    const wrong = await loadGoldEvidenceInventory({
      evidence_root: root,
      case_id: "case-a",
      target_product_commit: commit,
      expected_product_assessment: {
        requirement_id: "fixture.release.v1",
        package_id: "other_package",
        package_version: "1.0",
      },
    });
    expect(wrong.checks.semantic_product).toBe("fail");

    const unknown = await loadGoldEvidenceInventory({
      evidence_root: root,
      case_id: "case-a",
      target_product_commit: commit,
    });
    expect(unknown.checks.semantic_product).toBe("unknown");
  });

  test("treats accepted-only evidence as unknown and reports missing terminal evidence", async () => {
    const root = await makeRoot();
    await writeJson(root, "accept-case-a.json", accepted());
    const result = await loadGoldEvidenceInventory({
      evidence_root: root,
      case_id: "case-a",
      target_product_commit: commit,
    });

    expect(result.identity.status).toBe("pass");
    expect(result.checks.execution).toBe("unknown");
    expect(result.findings.map((item) => item.code)).toContain("evidence.terminal_missing");
  });

  test("fails closed for missing, malformed, and wrong-case evidence", async () => {
    const root = await makeRoot();
    await writeJson(root, "accept-case-b.json", accepted("case-b"));
    await writeFile(join(root, "evidence-case-a.json"), "not-json", "utf8");
    const result = await loadGoldEvidenceInventory({
      evidence_root: root,
      case_id: "case-a",
      target_product_commit: commit,
    });

    expect(result.findings.map((item) => item.code)).toEqual(expect.arrayContaining([
      "evidence.terminal_malformed",
      "evidence.accept_missing",
    ]));
  });

  test("reports product commit mismatch as a reproducibility blocker", async () => {
    const root = await makeRoot();
    await writePair(root, "case-a", "f".repeat(40));
    const result = await loadGoldEvidenceInventory({
      evidence_root: root,
      case_id: "case-a",
      target_product_commit: commit,
    });

    expect(result.identity.status).toBe("fail");
    expect(result.findings.map((item) => item.code)).toContain("identity.product_commit_mismatch");
  });

  test("rejects evidence-root traversal and does not read outside the root", async () => {
    const root = await makeRoot();
    await writePair(root);
    const outside = await makeRoot();
    await writeJson(outside, "evidence-case-a.json", evidence());
    const result = await loadGoldEvidenceInventory({
      evidence_root: root,
      case_id: "../case-a",
      target_product_commit: commit,
    }).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(TypeError);
  });

  test("marks an explicitly inadmissible historical declaration as blocked", async () => {
    const root = await makeRoot();
    const goldRoot = await makeRoot();
    await writePair(root);
    await mkdir(join(goldRoot, "historical"), { recursive: true });
    await writeJson(join(goldRoot, "historical"), "case-a.runs.json", {
      case_id: "case-a",
      admissible_as_current_evidence: false,
      reason: "fixture is historical",
    });
    const result = await loadGoldEvidenceInventory({
      evidence_root: root,
      case_id: "case-a",
      target_product_commit: commit,
      gold_root: goldRoot,
    });

    expect(result.historical).toEqual({
      status: "blocked",
      admissible_as_current_evidence: false,
    });
    expect(result.findings.map((item) => item.code)).toContain("evidence.historical_inadmissible");
  });

  test("blocks trusted input only for an explicit pending blocking HIL sidecar", async () => {
    const root = await makeRoot();
    await writePair(root);
    await writeJson(root, "case-a.hil-needed.json", {
      hil_request: {
        status: "pending",
        blocking: true,
      },
    });
    const result = await loadGoldEvidenceInventory({
      evidence_root: root,
      case_id: "case-a",
      target_product_commit: commit,
    });

    expect(result.checks.trusted_inputs).toBe("blocked");
    expect(result.observed.hil_count).toBe(1);
    expect(result.evidence_refs).toContain("case-a.hil-needed.json");
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "trusted_input.hil_pending", boundary: "trusted_input" }),
    ]));
  });

  test.each([
    { status: "accepted", blocking: true },
    { status: "pending", blocking: false },
  ])("does not block resolved or non-blocking HIL evidence", async (hilRequest) => {
    const root = await makeRoot();
    await writePair(root);
    await writeJson(root, "case-a.hil-needed.json", { hil_request: hilRequest });
    const result = await loadGoldEvidenceInventory({
      evidence_root: root,
      case_id: "case-a",
      target_product_commit: commit,
    });

    expect(result.checks.trusted_inputs).toBe("unknown");
    expect(result.findings.map((item) => item.code)).not.toContain("trusted_input.hil_pending");
  });

  test("reports malformed HIL evidence without treating it as resolved", async () => {
    const root = await makeRoot();
    await writePair(root);
    await writeFile(join(root, "case-a.hil-needed.json"), "not-json", "utf8");
    const result = await loadGoldEvidenceInventory({
      evidence_root: root,
      case_id: "case-a",
      target_product_commit: commit,
    });

    expect(result.checks.trusted_inputs).toBe("unknown");
    expect(result.findings.map((item) => item.code)).toContain("evidence.hil_malformed");
  });

  test("keeps output ordering deterministic", async () => {
    const firstRoot = await makeRoot();
    const secondRoot = await makeRoot();
    await writePair(firstRoot);
    await writeJson(firstRoot, "accept-case-a.json", {
      ...accepted(),
      product_commit: "f".repeat(40),
    });
    await writePair(secondRoot);
    await writeJson(secondRoot, "accept-case-a.json", {
      ...accepted(),
      product_commit: "f".repeat(40),
    });

    const first = await loadGoldEvidenceInventory({
      evidence_root: firstRoot,
      case_id: "case-a",
      target_product_commit: commit,
    });
    const second = await loadGoldEvidenceInventory({
      evidence_root: secondRoot,
      case_id: "case-a",
      target_product_commit: commit,
    });
    expect(first).toEqual(second);
  });
});
