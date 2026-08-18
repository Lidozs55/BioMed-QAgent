import type { DeterministicDeriveRequest } from "@biomed/contracts";
import { describe, expect, test } from "vitest";

import {
  DeterministicDeriveRegistry,
  PDB_INTERFACE_DISTANCE_ALGORITHM_ID,
  SEQUENCE_ALIGNMENT_ALGORITHM_ID,
  computeDeterministicDeriveRequestIdentity,
  createPdbInterfaceDistanceAlgorithm,
  createSequenceReferenceMappingAlgorithm,
} from "../src/dataset/derive/index.js";
import {
  PROTEIN_STRUCTURE_INTERFACE_SCHEMA_ID,
  consumeProteinStructureDerivedEvidence,
} from "../src/dataset/families/protein-structure/index.js";
import { createDefaultDatasetFamilyRegistry } from "../src/dataset/families/index.js";
import {
  VARIANT_SEQUENCE_MAPPING_SCHEMA_ID,
  consumeVariantSequenceMappingEvidence,
} from "../src/dataset/families/variant-evidence/index.js";

const INPUT_DIGEST = "a".repeat(64);
const REFERENCE_DIGEST = "b".repeat(64);
const IMPLEMENTATION_DIGEST = "c".repeat(64);

function requestFor(
  algorithmId: string,
  outputSchemaRef: string,
  parameters: Record<string, string | number>,
): DeterministicDeriveRequest {
  const request = {
    schema_version: "1.0" as const,
    slot: "derive" as const,
    request_id: `request_${algorithmId}`,
    task_id: "task_non_gold",
    build_id: "build_non_gold",
    algorithm_id: algorithmId,
    algorithm_version: "1.0.0",
    implementation_digest: IMPLEMENTATION_DIGEST,
    parameters,
    reference: {
      schema_version: "1.0" as const,
      reference_id: algorithmId === PDB_INTERFACE_DISTANCE_ALGORITHM_ID
        ? "pdb_1BRS"
        : "refseq_NM_000546_6",
      version: algorithmId === PDB_INTERFACE_DISTANCE_ALGORITHM_ID
        ? "1BRS.2"
        : "NM_000546.6",
      digest: REFERENCE_DIGEST,
    },
    inputs: [{
      schema_version: "1.0" as const,
      input_id: algorithmId === PDB_INTERFACE_DISTANCE_ALGORITHM_ID
        ? "structure_coordinates"
        : "query_sequence",
      kind: "committed_result" as const,
      digest: INPUT_DIGEST,
      asset_ref: null,
      committed_result_ref: {
        schema_version: "1.0" as const,
        result_manifest_id: "result_non_gold_input",
        output_kind: "canonical_table" as const,
        output_digest: INPUT_DIGEST,
        commit_id: "commit_non_gold_input",
      },
    }],
    output_schema_ref: outputSchemaRef,
  };
  return {
    ...request,
    request_identity_digest: computeDeterministicDeriveRequestIdentity(request),
  };
}

function registry(): DeterministicDeriveRegistry {
  return new DeterministicDeriveRegistry([
    createPdbInterfaceDistanceAlgorithm({
      algorithmVersion: "1.0.0",
      implementationDigest: IMPLEMENTATION_DIGEST,
      resolveCoordinates: () => ({
        digest: INPUT_DIGEST,
        structureId: "1BRS",
        structureVersion: "1BRS.2",
        atoms: [
          { chainId: "A", residueId: "31", atomName: "CA", x: 0, y: 0, z: 0 },
          { chainId: "D", residueId: "103", atomName: "CB", x: 0, y: 3, z: 4 },
          { chainId: "D", residueId: "104", atomName: "CA", x: 0, y: 0, z: 9 },
        ],
      }),
      resolveReference: () => ({
        digest: REFERENCE_DIGEST,
        referenceId: "pdb_1BRS",
        version: "1BRS.2",
      }),
    }),
    createSequenceReferenceMappingAlgorithm({
      algorithmVersion: "1.0.0",
      implementationDigest: IMPLEMENTATION_DIGEST,
      resolveQuery: () => ({
        digest: INPUT_DIGEST,
        sequenceId: "query_TP53",
        sequence: "ACGT",
      }),
      resolveReference: () => ({
        digest: REFERENCE_DIGEST,
        referenceId: "refseq_NM_000546_6",
        version: "NM_000546.6",
        sequence: "ACGGT",
      }),
    }),
  ]);
}

describe("protein_structure deterministic derived evidence module", () => {
  test("keeps the derived family module out of the production default registry", () => {
    expect(createDefaultDatasetFamilyRegistry().list()).toEqual(["gene_expression"]);
  });

  test("recomputes a non-Gold PDB interface and keeps it explicitly derived", () => {
    const request = requestFor(
      PDB_INTERFACE_DISTANCE_ALGORITHM_ID,
      PROTEIN_STRUCTURE_INTERFACE_SCHEMA_ID,
      { chain_a: "A", chain_b: "D", atom_selection: "all", cutoff_angstrom: 5 },
    );
    const receipt = registry().createCapability(
      PDB_INTERFACE_DISTANCE_ALGORITHM_ID,
      "1.0.0",
    ).execute(request);
    const consumed = consumeProteinStructureDerivedEvidence(receipt);

    expect(consumed.table.role).toBe("derived");
    expect(consumed.profile.dataset_family).toBe("protein_structure");
    expect(consumed.records).toHaveLength(1);
    expect(consumed.records[0]).toMatchObject({
      structure_id: "1BRS",
      structure_version: "1BRS.2",
      chain_a: "A",
      chain_b: "D",
      distance_angstrom: 5,
      evidence_origin: "deterministic_derive",
      request_identity_digest: request.request_identity_digest,
      input_digests: [INPUT_DIGEST],
      reference_digest: REFERENCE_DIGEST,
    });
    expect(consumed.schema.fields.map((field) => field.name)).not.toContain("source_id");
    expect(consumed.schema.fields.map((field) => field.name)).not.toContain("source_locator");
  });

  test("rejects digest drift, the wrong algorithm, and source-record masquerading", () => {
    const request = requestFor(
      PDB_INTERFACE_DISTANCE_ALGORITHM_ID,
      PROTEIN_STRUCTURE_INTERFACE_SCHEMA_ID,
      { chain_a: "A", chain_b: "D", atom_selection: "all", cutoff_angstrom: 5 },
    );
    const receipt = registry().createCapability(
      PDB_INTERFACE_DISTANCE_ALGORITHM_ID,
      "1.0.0",
    ).execute(request);
    expect(() => consumeProteinStructureDerivedEvidence({
      ...receipt,
      output_summary: { ...receipt.output_summary, source_id: "source_pdb" },
    })).toThrow(/derived output fields|source/i);
    expect(() => consumeProteinStructureDerivedEvidence({
      ...receipt,
      provenance: { ...receipt.provenance, algorithm_id: SEQUENCE_ALIGNMENT_ALGORITHM_ID },
    })).toThrow(/identity digest|algorithm/i);
    expect(() => consumeProteinStructureDerivedEvidence({
      ...receipt,
      output_summary: { ...receipt.output_summary, reference_digest: "d".repeat(64) },
    })).toThrow(/reference digest/i);
  });
});

describe("variant_evidence deterministic sequence mapping module", () => {
  test("recomputes a non-Gold sequence/reference mapping with closed provenance", () => {
    const request = requestFor(
      SEQUENCE_ALIGNMENT_ALGORITHM_ID,
      VARIANT_SEQUENCE_MAPPING_SCHEMA_ID,
      { mode: "global", match_score: 2, mismatch_score: -1, gap_open: -3, gap_extend: -1 },
    );
    const receipt = registry().createCapability(
      SEQUENCE_ALIGNMENT_ALGORITHM_ID,
      "1.0.0",
    ).execute(request);
    const consumed = consumeVariantSequenceMappingEvidence(receipt);

    expect(consumed.table.role).toBe("derived");
    expect(consumed.profile.dataset_family).toBe("variant_evidence");
    expect(consumed.records.map((record) => record.query_position)).toEqual([1, 2, 3, 4]);
    expect(consumed.records.map((record) => record.reference_position)).toEqual([1, 2, 4, 5]);
    expect(consumed.records.every((record) =>
      record.parameter_digest === consumed.parameterDigest &&
      record.reference_digest === REFERENCE_DIGEST &&
      record.input_digests[0] === INPUT_DIGEST
    )).toBe(true);
  });

  test("rejects unknown algorithms, Agent code, schema drift, and resolver digest drift", () => {
    const deriveRegistry = registry();
    expect(() => deriveRegistry.createCapability("agent_python", "1.0.0")).toThrow(/not registered/);

    const request = requestFor(
      SEQUENCE_ALIGNMENT_ALGORITHM_ID,
      VARIANT_SEQUENCE_MAPPING_SCHEMA_ID,
      { mode: "global", match_score: 2, mismatch_score: -1, gap_open: -3, gap_extend: -1 },
    );
    const withCode = {
      ...request,
      parameters: { ...request.parameters, code: "return arbitrary_rows" },
    };
    withCode.request_identity_digest = computeDeterministicDeriveRequestIdentity(withCode);
    expect(() => deriveRegistry.createCapability(
      SEQUENCE_ALIGNMENT_ALGORITHM_ID,
      "1.0.0",
    ).execute(withCode)).toThrow(/forbid code/);

    const receipt = deriveRegistry.createCapability(
      SEQUENCE_ALIGNMENT_ALGORITHM_ID,
      "1.0.0",
    ).execute(request);
    expect(() => consumeVariantSequenceMappingEvidence({
      ...receipt,
      output_schema_ref: PROTEIN_STRUCTURE_INTERFACE_SCHEMA_ID,
    })).toThrow(/schema/i);

    const driftedRegistry = new DeterministicDeriveRegistry([
      createSequenceReferenceMappingAlgorithm({
        algorithmVersion: "1.0.0",
        implementationDigest: IMPLEMENTATION_DIGEST,
        resolveQuery: () => ({ digest: "d".repeat(64), sequenceId: "query_TP53", sequence: "ACGT" }),
        resolveReference: () => ({
          digest: REFERENCE_DIGEST,
          referenceId: "refseq_NM_000546_6",
          version: "NM_000546.6",
          sequence: "ACGGT",
        }),
      }),
    ]);
    expect(() => driftedRegistry.createCapability(
      SEQUENCE_ALIGNMENT_ALGORITHM_ID,
      "1.0.0",
    ).execute(request)).toThrow(/input digest/i);
  });
});
