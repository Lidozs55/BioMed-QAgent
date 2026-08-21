import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  loadTrustedEvidenceChainFiles,
  projectTrustedEvidenceChain,
} from "../../src/evaluation/trusted-evidence-chain.js";

const PRODUCT_COMMIT = "a".repeat(40);
const MANIFEST_SHA = "b".repeat(64);
const ARTIFACT_SHA = "c".repeat(64);
const TASK_ID = "task-fixture";
const RUN_ID = "run-fixture";
const REQUEST_ID = "request-fixture";
const BUILD_ID = "build-fixture";
const PUBLICATION_ID = "publication-fixture";
const roots: string[] = [];

type JsonObject = Record<string, unknown>;

function buildResult(overrides: JsonObject = {}): JsonObject {
  return {
    status: "succeeded",
    valid_row_count: 2,
    successful_sources: ["source-fixture"],
    rejected_sources: [],
    available_artifact_roles: ["primary_dataset"],
    publication_id: PUBLICATION_ID,
    reason_codes: [],
    user_summary: "Published fixture data.",
    recommended_next_action: "none",
    build_id: BUILD_ID,
    ...overrides,
  };
}

function accepted(overrides: JsonObject = {}): JsonObject {
  return {
    product_commit: PRODUCT_COMMIT,
    request_id: REQUEST_ID,
    accepted: {
      request_id: REQUEST_ID,
      task_id: TASK_ID,
      run_id: RUN_ID,
      status: "queued",
    },
    ...overrides,
  };
}

function event(
  sequence: number,
  type: string,
  payload: JsonObject,
  overrides: JsonObject = {},
): JsonObject {
  return {
    schema_version: "2.0",
    event_id: `event-${sequence}`,
    type,
    task_id: TASK_ID,
    run_id: RUN_ID,
    sequence,
    timestamp: `2026-08-20T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    payload: { type, ...payload },
    ...overrides,
  };
}

function artifactReceipt(): JsonObject {
  return {
    artifact_id: "artifact-data",
    name: "records.csv",
    role: "primary_dataset",
    relative_path: "tables/records.csv",
    media_type: "text/csv",
    size_bytes: 7,
    sha256: ARTIFACT_SHA,
    generated_by_step_id: "step-publish",
  };
}

function artifactList(): JsonObject[] {
  return [
    {
      artifact_id: "dataset-manifest",
      name: "dataset_manifest.json",
      role: "schema",
      size: 11,
      sha256: MANIFEST_SHA,
      media_type: "application/json",
    },
    {
      artifact_id: "artifact-data",
      name: "records.csv",
      role: "primary_dataset",
      size: 7,
      sha256: ARTIFACT_SHA,
      media_type: "text/csv",
    },
  ];
}

function artifactHashes(): JsonObject[] {
  return [
    {
      artifact_id: "dataset-manifest",
      name: "dataset_manifest.json",
      size_bytes: 11,
      sha256: MANIFEST_SHA,
      media_type: "application/json",
    },
    {
      artifact_id: "artifact-data",
      name: "records.csv",
      size_bytes: 7,
      sha256: ARTIFACT_SHA,
      media_type: "text/csv",
    },
  ];
}

function canonicalEvidence(overrides: JsonObject = {}): JsonObject {
  const result = buildResult();
  return {
    product_commit: PRODUCT_COMMIT,
    request_id: REQUEST_ID,
    task_id: TASK_ID,
    run_id: RUN_ID,
    snapshot: {
      task: { task_id: TASK_ID, status: "completed" },
      runs: [{
        run_id: RUN_ID,
        task_id: TASK_ID,
        request_id: REQUEST_ID,
        status: "completed",
        summary: { build_result: result },
      }],
      messages: [{
        message_id: "message-final",
        task_id: TASK_ID,
        run_id: RUN_ID,
        ordinal: 2,
        role: "assistant",
        content: `Download publication ${PUBLICATION_ID}.`,
        created_at: "2026-08-20T00:00:05.000Z",
      }],
      publications: [{
        publication_id: PUBLICATION_ID,
        manifest_sha256: MANIFEST_SHA,
        published_at: "2026-08-20T00:00:02.000Z",
        supersedes_publication_id: null,
      }],
      current_publication_id: PUBLICATION_ID,
    },
    events: [
      event(1, "run_queued", { request_id: REQUEST_ID, input: "fixture" }),
      event(2, "publication_created", {
        publication_id: PUBLICATION_ID,
        run_id: RUN_ID,
        manifest_sha256: MANIFEST_SHA,
        supersedes_publication_id: null,
        published_at: "2026-08-20T00:00:02.000Z",
      }),
      event(3, "artifact_produced", { artifact: artifactReceipt() }),
      event(4, "run_completed", { build_result: result }),
    ],
    artifact_list: artifactList(),
    artifact_hashes: artifactHashes(),
    ...overrides,
  };
}

function project(evidence: unknown, hil?: unknown) {
  return projectTrustedEvidenceChain({
    accepted: accepted(),
    evidence,
    hil,
    accepted_ref: "accept-case.json",
    evidence_ref: "evidence-case.json",
    hil_ref: "case.hil.json",
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("trusted evidence-chain projection", () => {
  test("projects a canonical unsuffixed snapshot and event chain", () => {
    const result = project(canonicalEvidence());

    expect(result.accepted_identity).toMatchObject({
      state: "present",
      product_commit: PRODUCT_COMMIT,
      request_id: REQUEST_ID,
      task_id: TASK_ID,
      run_id: RUN_ID,
    });
    expect(result.terminal).toMatchObject({
      state: "present",
      task_status: "completed",
      run_status: "completed",
    });
    expect(result.build).toMatchObject({
      state: "present",
      build_id: BUILD_ID,
      publication_id: PUBLICATION_ID,
    });
    expect(result.publication).toMatchObject({
      state: "present",
      publication_id: PUBLICATION_ID,
      manifest_sha256: MANIFEST_SHA,
    });
    expect(result.artifacts).toMatchObject({
      state: "present",
      expected_count: 2,
      verified_count: 2,
      all_verified: true,
    });
    expect(result.final_answer).toMatchObject({
      state: "present",
      publication_referenced: true,
      source: "snapshot_message",
    });
    expect(result.gaps.map((gap) => gap.code)).toEqual([
      "trusted_input.source_asset_receipt_missing",
      "semantic_product.not_projected",
    ]);
  });

  test("projects a terminal-only legacy bundle without inventing a BuildResult", () => {
    const result = project({
      product_commit: PRODUCT_COMMIT,
      request_id: REQUEST_ID,
      task_id: TASK_ID,
      run_id: RUN_ID,
      terminal: {
        status: "completed",
        task: { task_id: TASK_ID, status: "completed" },
        run: {
          task_id: TASK_ID,
          run_id: RUN_ID,
          request_id: REQUEST_ID,
          status: "completed",
          summary: { build_result: null },
        },
      },
      task_builds: [{ task_id: TASK_ID, run_id: RUN_ID, build_id: BUILD_ID }],
    });

    expect(result.terminal.state).toBe("present");
    expect(result.build).toMatchObject({ state: "receipt_only", build_id: BUILD_ID });
    expect(result.publication.state).toBe("missing");
  });

  test("detects conflicting task, run, and publication identities", () => {
    const evidence = canonicalEvidence({
      task_id: "task-other",
      run_id: "run-other",
      snapshot: {
        task: { task_id: TASK_ID, status: "completed" },
        runs: [{
          run_id: RUN_ID,
          task_id: TASK_ID,
          request_id: REQUEST_ID,
          status: "completed",
          summary: { build_result: buildResult() },
        }],
        messages: [],
        publications: [{
          publication_id: PUBLICATION_ID,
          manifest_sha256: "d".repeat(64),
          published_at: "2026-08-20T00:00:02.000Z",
          supersedes_publication_id: null,
        }],
      },
    });
    const result = project(evidence);

    expect(result.accepted_identity.state).toBe("conflicting");
    expect(result.publication.state).toBe("conflicting");
    expect(result.gaps.map((gap) => gap.code)).toEqual(expect.arrayContaining([
      "identity.conflicting",
      "publication.conflicting",
    ]));
  });

  test("keeps produced artifacts receipt-only without downloaded hashes", () => {
    const result = project(canonicalEvidence({
      artifact_list: artifactList(),
      artifact_hashes: [],
    }));

    expect(result.artifacts).toMatchObject({
      state: "receipt_only",
      expected_count: 2,
      verified_count: 0,
      all_verified: false,
    });
    expect(result.gaps.map((gap) => gap.code)).toContain("artifact.download_verification_missing");
  });

  test("marks an artifact present only when ID, hash, and size verify", () => {
    const result = project(canonicalEvidence());
    expect(result.artifacts.items).toEqual([
      expect.objectContaining({ artifact_id: "artifact-data", state: "present" }),
      expect.objectContaining({ artifact_id: "dataset-manifest", state: "present" }),
    ]);
  });

  test("fails closed on a downloaded artifact hash mismatch", () => {
    const hashes = artifactHashes();
    hashes[1] = { ...hashes[1], sha256: "e".repeat(64) };
    const result = project(canonicalEvidence({ artifact_hashes: hashes }));

    expect(result.artifacts.state).toBe("conflicting");
    expect(result.artifacts.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ artifact_id: "artifact-data", state: "conflicting" }),
    ]));
    expect(result.gaps.map((gap) => gap.code)).toContain("artifact.hash_mismatch");
  });

  test("requires an exact final-answer publication reference", () => {
    const similarOnly = canonicalEvidence();
    const snapshot = similarOnly.snapshot as JsonObject;
    const messages = snapshot.messages as JsonObject[];
    messages[0] = { ...messages[0], content: `${PUBLICATION_ID}-other` };
    const missing = project(similarOnly);
    expect(missing.final_answer).toMatchObject({
      state: "missing",
      publication_referenced: false,
    });
    expect(missing.gaps.map((gap) => gap.code)).toContain("final_answer.publication_reference_missing");

    const exact = project(canonicalEvidence());
    expect(exact.final_answer).toMatchObject({ state: "present", publication_referenced: true });
  });

  test("detects a pending blocking HIL event or sidecar", () => {
    const hilRequest = {
      request_id: "hil-fixture",
      task_id: TASK_ID,
      run_id: RUN_ID,
      status: "pending",
      blocking: true,
    };
    const evidence = canonicalEvidence({
      events: [
        ...(canonicalEvidence().events as unknown[]),
        event(5, "user_input_required", {
          request_id: "hil-fixture",
          hil_request: hilRequest,
        }),
      ],
    });
    const fromEvent = project(evidence);
    expect(fromEvent.hil).toMatchObject({ state: "present", blocking: true });

    const fromSidecar = project(canonicalEvidence(), { hil_request: hilRequest });
    expect(fromSidecar.hil).toMatchObject({ state: "present", blocking: true });
    expect(fromSidecar.gaps.map((gap) => gap.code)).toContain("hil.pending");
  });

  test("ignores terminal, build, and publication events from unrelated runs", () => {
    const unrelated = [
      event(20, "publication_created", {
        publication_id: "publication-other",
        run_id: "run-other",
        manifest_sha256: "f".repeat(64),
        supersedes_publication_id: null,
        published_at: "2026-08-20T00:00:20.000Z",
      }, { run_id: "run-other" }),
      event(21, "run_completed", {
        build_result: buildResult({
          build_id: "build-other",
          publication_id: "publication-other",
        }),
      }, { run_id: "run-other" }),
    ];
    const evidence = canonicalEvidence({
      events: [...(canonicalEvidence().events as unknown[]), ...unrelated],
    });
    const result = project(evidence);

    expect(result.build.build_id).toBe(BUILD_ID);
    expect(result.publication.publication_id).toBe(PUBLICATION_ID);
    expect(result.publication.source_refs.join(" ")).not.toContain("publication-other");
  });

  test("reconstructs ordered assistant deltas when no snapshot message exists", () => {
    const evidence = canonicalEvidence();
    const snapshot = evidence.snapshot as JsonObject;
    snapshot.messages = [];
    evidence.events = [
      ...(evidence.events as unknown[]),
      event(6, "assistant_delta", { delta: " Publication " }),
      event(5, "assistant_delta", { delta: `${PUBLICATION_ID}` }),
    ];
    const result = project(evidence);

    expect(result.final_answer).toMatchObject({
      source: "assistant_delta",
      content: `${PUBLICATION_ID} Publication `,
      publication_referenced: true,
    });
  });

  test("sorts facts, refs, and gaps deterministically", () => {
    const first = canonicalEvidence();
    const second = canonicalEvidence({
      events: [...(canonicalEvidence().events as unknown[])].reverse(),
      artifact_list: [...artifactList()].reverse(),
      artifact_hashes: [...artifactHashes()].reverse(),
    });

    expect(project(first)).toEqual(project(second));
  });

  test("enforces bounded JSON and confines file loading", async () => {
    expect(() => projectTrustedEvidenceChain({
      accepted: accepted(),
      evidence: { events: Array.from({ length: 20_001 }, () => null) },
    })).toThrow(/bounded array/);

    const root = await mkdtemp(join(tmpdir(), "trusted-chain-"));
    roots.push(root);
    await writeFile(join(root, "accepted.json"), JSON.stringify(accepted()), "utf8");
    await writeFile(join(root, "evidence.json"), JSON.stringify(canonicalEvidence()), "utf8");
    const result = await loadTrustedEvidenceChainFiles({
      evidence_root: root,
      accepted_ref: "accepted.json",
      evidence_ref: "evidence.json",
    });
    expect(result.accepted_identity.state).toBe("present");

    await expect(loadTrustedEvidenceChainFiles({
      evidence_root: root,
      accepted_ref: "../accepted.json",
      evidence_ref: "evidence.json",
    })).rejects.toThrow(/escapes evidence root/);
  });
});
