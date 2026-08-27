import { describe, expect, test } from "vitest";
import type { DeterministicDeriveAlgorithm } from "../src/dataset/derive/index.js";
import type { DeterministicDeriveRequest } from "@biomed/contracts";
import {
  DeterministicDeriveRegistry,
  PDB_INTERFACE_DISTANCE_ALGORITHM_ID,
  SEQUENCE_ALIGNMENT_ALGORITHM_ID,
  computeDeterministicDeriveRequestIdentity,
} from "../src/dataset/derive/index.js";
import {
  parseDeterministicDeriveRequest,
  parseDeterministicDeriveResultReceipt,
} from "../src/dataset/contracts/index.js";

const ASSET_DIGEST = "a".repeat(64);
const RESULT_DIGEST = "b".repeat(64);
const IMPLEMENTATION_DIGEST = "c".repeat(64);
const REFERENCE_DIGEST = "d".repeat(64);
const OUTPUT_DIGEST = "e".repeat(64);

function requestFor(
  algorithmId: string,
  overrides: Partial<Omit<DeterministicDeriveRequest, "request_identity_digest">> = {},
): DeterministicDeriveRequest {
  const parameters: Record<string, string | number> = algorithmId === PDB_INTERFACE_DISTANCE_ALGORITHM_ID
    ? { chain_a: "A", chain_b: "E", atom_selection: "heavy", cutoff_angstrom: 5 }
    : { mode: "global", gap_open: -10, gap_extend: -1 };
  const referenceId = algorithmId === PDB_INTERFACE_DISTANCE_ALGORITHM_ID ? "pdb_6M0J" : "refseq_NC_045512_2";
  const referenceVersion = algorithmId === PDB_INTERFACE_DISTANCE_ALGORITHM_ID ? "2026-08-18" : "NC_045512.2";
  const outputSchemaRef = algorithmId === PDB_INTERFACE_DISTANCE_ALGORITHM_ID
    ? "structure_interface_v1"
    : "sequence_reference_mapping_v1";
  const request = {
    schema_version: "1.0" as const,
    slot: "derive" as const,
    request_id: `request_${algorithmId}`,
    task_id: "task_1",
    requirement_id: "build_1",
    algorithm_id: algorithmId,
    algorithm_version: "1.0.0",
    implementation_digest: IMPLEMENTATION_DIGEST,
    parameters,
    reference: {
      schema_version: "1.0" as const,
      reference_id: referenceId,
      version: referenceVersion,
      digest: REFERENCE_DIGEST,
    },
    inputs: algorithmId === PDB_INTERFACE_DISTANCE_ALGORITHM_ID ? [{
      schema_version: "1.0" as const,
      input_id: "structure_coordinates",
      kind: "registered_asset" as const,
      digest: ASSET_DIGEST,
      asset_ref: {
        schema_version: "1.0" as const,
        asset_id: `asset_${ASSET_DIGEST}`,
        task_id: "task_1",
        role: "source" as const,
      },
      committed_result_ref: null,
    }] : [{
      schema_version: "1.0" as const,
      input_id: "canonical_sequences",
      kind: "committed_result" as const,
      digest: RESULT_DIGEST,
      asset_ref: null,
      committed_result_ref: {
        schema_version: "1.0" as const,
        result_manifest_id: "result_sequences",
        output_kind: "canonical_table" as const,
        output_digest: RESULT_DIGEST,
        commit_id: "commit_sequences",
      },
    }],
    output_schema_ref: outputSchemaRef,
    ...overrides,
  };
  return {
    ...request,
    request_identity_digest: computeDeterministicDeriveRequestIdentity(request),
  };
}

function algorithm(algorithmId: string): DeterministicDeriveAlgorithm {
  return {
    algorithmId,
    algorithmVersion: "1.0.0",
    implementationDigest: IMPLEMENTATION_DIGEST,
    derive: () => ({ outputDigest: OUTPUT_DIGEST, outputSummary: { row_count: 2 } }),
  };
}

describe("deterministic derive contract", () => {
  test("represents PDB distance and sequence alignment through the same fixed contract", () => {
    const distance = parseDeterministicDeriveRequest(requestFor(PDB_INTERFACE_DISTANCE_ALGORITHM_ID));
    const alignment = parseDeterministicDeriveRequest(requestFor(SEQUENCE_ALIGNMENT_ALGORITHM_ID));

    for (const request of [distance, alignment]) {
      expect(request).toMatchObject({
        schema_version: "1.0",
        slot: "derive",
        algorithm_version: "1.0.0",
        implementation_digest: IMPLEMENTATION_DIGEST,
      });
      expect(request.inputs).toHaveLength(1);
      expect(request.reference.digest).toBe(REFERENCE_DIGEST);
      expect(request.request_identity_digest).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(distance.algorithm_id).toBe(PDB_INTERFACE_DISTANCE_ALGORITHM_ID);
    expect(alignment.algorithm_id).toBe(SEQUENCE_ALIGNMENT_ALGORITHM_ID);
  });

  test("changes identity when parameters, reference version or input digest changes", () => {
    const base = requestFor(PDB_INTERFACE_DISTANCE_ALGORITHM_ID);
    const changedParameters = requestFor(PDB_INTERFACE_DISTANCE_ALGORITHM_ID, {
      parameters: { chain_a: "A", chain_b: "E", atom_selection: "heavy", cutoff_angstrom: 8 },
    });
    const changedReference = requestFor(PDB_INTERFACE_DISTANCE_ALGORITHM_ID, {
      reference: { ...base.reference, version: "2026-08-19" },
    });
    const changedDigest = "f".repeat(64);
    const changedInput = requestFor(PDB_INTERFACE_DISTANCE_ALGORITHM_ID, {
      inputs: [{
        ...base.inputs[0]!,
        digest: changedDigest,
        asset_ref: { ...base.inputs[0]!.asset_ref!, asset_id: `asset_${changedDigest}` },
      }],
    });

    expect(new Set([
      base.request_identity_digest,
      changedParameters.request_identity_digest,
      changedReference.request_identity_digest,
      changedInput.request_identity_digest,
    ])).toHaveLength(4);
  });

  test("rejects Agent code, dynamic nodes, paths and mismatched input digests", () => {
    const request = requestFor(PDB_INTERFACE_DISTANCE_ALGORITHM_ID);
    expect(() => parseDeterministicDeriveRequest({ ...request, code: "return rows" })).toThrow(/unknown fields.*code/);
    expect(() => parseDeterministicDeriveRequest({ ...request, dependencies: ["node_1"] })).toThrow(/unknown fields.*dependencies/);
    expect(() => parseDeterministicDeriveRequest({ ...request, input_path: "data/workspaces/task_1/x.csv" })).toThrow(/unknown fields.*input_path/);
    expect(() => parseDeterministicDeriveRequest({
      ...request,
      parameters: { cutoff_angstrom: 5, nested: { script: "python x.py" } },
    })).toThrow(/forbid code or DAG field/);
    expect(() => parseDeterministicDeriveRequest({ ...request, slot: "custom_node" })).toThrow(/slot must be derive/);
    expect(() => parseDeterministicDeriveRequest({
      ...request,
      inputs: [{ ...request.inputs[0]!, digest: RESULT_DIGEST }],
    })).toThrow(/digest must match asset_ref/);
  });
});

describe("deterministic derive registry", () => {
  test("admits only registered algorithms and emits complete provenance", () => {
    const registry = new DeterministicDeriveRegistry([
      algorithm(PDB_INTERFACE_DISTANCE_ALGORITHM_ID),
      algorithm(SEQUENCE_ALIGNMENT_ALGORITHM_ID),
    ]);
    const request = requestFor(PDB_INTERFACE_DISTANCE_ALGORITHM_ID);
    const receipt = registry.createCapability(
      PDB_INTERFACE_DISTANCE_ALGORITHM_ID,
      "1.0.0",
    ).execute(request);

    expect(registry.list()).toEqual([
      PDB_INTERFACE_DISTANCE_ALGORITHM_ID + "@1.0.0",
      SEQUENCE_ALIGNMENT_ALGORITHM_ID + "@1.0.0",
    ]);
    expect(receipt).toMatchObject({
      slot: "derive",
      request_id: request.request_id,
      request_identity_digest: request.request_identity_digest,
      output_kind: "derived_evidence",
      output_digest: OUTPUT_DIGEST,
      provenance: {
        algorithm_id: PDB_INTERFACE_DISTANCE_ALGORITHM_ID,
        algorithm_version: "1.0.0",
        implementation_digest: IMPLEMENTATION_DIGEST,
        parameters: request.parameters,
        reference: request.reference,
        inputs: request.inputs,
        output_digest: OUTPUT_DIGEST,
      },
    });
    expect(parseDeterministicDeriveResultReceipt(receipt)).toEqual(receipt);
  });

  test("rejects unknown algorithms, implementation drift and identity drift", () => {
    const registry = new DeterministicDeriveRegistry([algorithm(PDB_INTERFACE_DISTANCE_ALGORITHM_ID)]);
    expect(() => registry.createCapability("agent_python", "1.0.0")).toThrow(/not registered/);
    const capability = registry.createCapability(PDB_INTERFACE_DISTANCE_ALGORITHM_ID, "1.0.0");
    const request = requestFor(PDB_INTERFACE_DISTANCE_ALGORITHM_ID);
    expect(() => capability.execute({ ...request, implementation_digest: "f".repeat(64) })).toThrow(/identity digest|implementation digest/);
    expect(() => capability.execute({ ...request, parameters: { cutoff_angstrom: 10 } })).toThrow(/identity digest/);
  });

  test("rejects duplicate registrations and handlers without trusted identity", () => {
    const registered = algorithm(PDB_INTERFACE_DISTANCE_ALGORITHM_ID);
    expect(() => new DeterministicDeriveRegistry([registered, registered])).toThrow(/already registered/);
    expect(() => new DeterministicDeriveRegistry([{
      ...registered,
      implementationDigest: "not-a-digest",
    }])).toThrow(/64 hexadecimal/);
  });
});
