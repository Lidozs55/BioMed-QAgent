import type { DeterministicDeriveRequest, JsonValue } from "@biomed/contracts";

import { canonicalDigest } from "../adapters/identity.js";
import { assertSha256 } from "../contracts/primitives.js";
import {
  PDB_INTERFACE_DISTANCE_ALGORITHM_ID,
  SEQUENCE_ALIGNMENT_ALGORITHM_ID,
} from "./registry.js";
import type { DeterministicDeriveAlgorithm } from "./types.js";

export const PDB_INTERFACE_DISTANCE_OUTPUT_SCHEMA_ID =
  "protein_structure.interface_derived.v1";
export const SEQUENCE_REFERENCE_MAPPING_OUTPUT_SCHEMA_ID =
  "variant_evidence.sequence_reference_mapping.v1";

export interface StructureAtomCoordinate {
  chainId: string;
  residueId: string;
  atomName: string;
  x: number;
  y: number;
  z: number;
}

export interface ResolvedStructureCoordinates {
  digest: string;
  structureId: string;
  structureVersion: string;
  atoms: readonly StructureAtomCoordinate[];
}

export interface ResolvedDeriveReference {
  digest: string;
  referenceId: string;
  version: string;
}

export interface ResolvedSequence {
  digest: string;
  sequenceId: string;
  sequence: string;
}

export interface ResolvedReferenceSequence extends ResolvedDeriveReference {
  sequence: string;
}

interface AlgorithmIdentityOptions {
  algorithmVersion: string;
  implementationDigest: string;
}

export interface PdbInterfaceDistanceAlgorithmOptions extends AlgorithmIdentityOptions {
  resolveCoordinates(request: DeterministicDeriveRequest): ResolvedStructureCoordinates;
  resolveReference(request: DeterministicDeriveRequest): ResolvedDeriveReference;
}

export interface SequenceReferenceMappingAlgorithmOptions extends AlgorithmIdentityOptions {
  resolveQuery(request: DeterministicDeriveRequest): ResolvedSequence;
  resolveReference(request: DeterministicDeriveRequest): ResolvedReferenceSequence;
}

function fail(message: string): never {
  throw new TypeError(`deterministic derive rejected: ${message}`);
}

function exactParameterKeys(
  parameters: Readonly<Record<string, JsonValue>>,
  expected: readonly string[],
): void {
  const actual = Object.keys(parameters).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`parameters must contain exactly ${wanted.join(", ")}`);
  }
}

function text(value: JsonValue | undefined, name: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${name} must be a non-empty string`);
  return value;
}

function finiteNumber(value: JsonValue | undefined, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${name} must be finite`);
  return value;
}

function assertSingleInputDigest(
  request: DeterministicDeriveRequest,
  actualDigest: string,
): string {
  if (request.inputs.length !== 1) fail("algorithm requires exactly one input");
  const digest = assertSha256(actualDigest, "resolved derive input digest");
  if (digest !== request.inputs[0]!.digest) fail("resolved input digest does not match request input digest");
  return digest;
}

function assertReference(
  request: DeterministicDeriveRequest,
  reference: ResolvedDeriveReference,
): void {
  const digest = assertSha256(reference.digest, "resolved derive reference digest");
  if (digest !== request.reference.digest) fail("resolved reference digest does not match request reference digest");
  if (reference.referenceId !== request.reference.reference_id) fail("resolved reference ID does not match request reference");
  if (reference.version !== request.reference.version) fail("resolved reference version does not match request reference");
}

function requiredOutputSchema(request: DeterministicDeriveRequest, schemaId: string): void {
  if (request.output_schema_ref !== schemaId) {
    fail(`algorithm requires output schema '${schemaId}'`);
  }
}

function coordinate(value: number, name: string): number {
  if (!Number.isFinite(value)) fail(`${name} must be finite`);
  return value;
}

function validateAtom(atom: StructureAtomCoordinate): StructureAtomCoordinate {
  const chainId = atom.chainId.trim();
  const residueId = atom.residueId.trim();
  const atomName = atom.atomName.trim();
  if (chainId === "" || residueId === "" || atomName === "") {
    fail("structure atom identifiers must not be blank");
  }
  return {
    chainId,
    residueId,
    atomName,
    x: coordinate(atom.x, "atom x"),
    y: coordinate(atom.y, "atom y"),
    z: coordinate(atom.z, "atom z"),
  };
}

function roundedDistance(left: StructureAtomCoordinate, right: StructureAtomCoordinate): number {
  const distance = Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
  return Number(distance.toFixed(6));
}

export function createPdbInterfaceDistanceAlgorithm(
  options: PdbInterfaceDistanceAlgorithmOptions,
): DeterministicDeriveAlgorithm {
  return {
    algorithmId: PDB_INTERFACE_DISTANCE_ALGORITHM_ID,
    algorithmVersion: options.algorithmVersion,
    implementationDigest: options.implementationDigest,
    derive(request) {
      requiredOutputSchema(request, PDB_INTERFACE_DISTANCE_OUTPUT_SCHEMA_ID);
      exactParameterKeys(request.parameters, [
        "atom_selection", "chain_a", "chain_b", "cutoff_angstrom",
      ]);
      const chainA = text(request.parameters.chain_a, "chain_a");
      const chainB = text(request.parameters.chain_b, "chain_b");
      if (chainA === chainB) fail("chain_a and chain_b must be different");
      const atomSelection = text(request.parameters.atom_selection, "atom_selection");
      if (atomSelection !== "all" && atomSelection !== "heavy") {
        fail("atom_selection must be all or heavy");
      }
      const cutoff = finiteNumber(request.parameters.cutoff_angstrom, "cutoff_angstrom");
      if (cutoff <= 0) fail("cutoff_angstrom must be positive");

      const coordinates = options.resolveCoordinates(request);
      const inputDigest = assertSingleInputDigest(request, coordinates.digest);
      const reference = options.resolveReference(request);
      assertReference(request, reference);
      if (coordinates.structureVersion !== reference.version) {
        fail("structure coordinate version does not match derive reference version");
      }
      if (coordinates.structureId.trim() === "" || coordinates.structureVersion.trim() === "") {
        fail("resolved structure identity must not be blank");
      }
      const atoms = coordinates.atoms.map(validateAtom);
      const atomKeys = atoms.map((atom) => `${atom.chainId}\u001f${atom.residueId}\u001f${atom.atomName}`);
      if (new Set(atomKeys).size !== atomKeys.length) {
        fail("resolved structure coordinates contain duplicate atom identities");
      }
      const selected = (atom: StructureAtomCoordinate): boolean =>
        atomSelection === "all" || !atom.atomName.toUpperCase().startsWith("H");
      const left = atoms.filter((atom) => atom.chainId === chainA && selected(atom));
      const right = atoms.filter((atom) => atom.chainId === chainB && selected(atom));
      if (left.length === 0 || right.length === 0) fail("requested interface chains contain no selected atoms");

      const parameterDigest = canonicalDigest(request.parameters);
      const records = left.flatMap((atomA) => right.flatMap((atomB) => {
        const distance = roundedDistance(atomA, atomB);
        if (distance > cutoff) return [];
        const identity = {
          structure_id: coordinates.structureId,
          structure_version: coordinates.structureVersion,
          chain_a: chainA,
          residue_a: atomA.residueId,
          atom_a: atomA.atomName,
          chain_b: chainB,
          residue_b: atomB.residueId,
          atom_b: atomB.atomName,
        };
        return [{
          interface_record_id: `interface_${canonicalDigest(identity).slice(0, 32)}`,
          ...identity,
          distance_angstrom: distance,
          cutoff_angstrom: cutoff,
          evidence_origin: "deterministic_derive",
          request_identity_digest: request.request_identity_digest,
          parameter_digest: parameterDigest,
          reference_digest: request.reference.digest,
          input_digests: [inputDigest],
        }];
      }));
      records.sort((leftRecord, rightRecord) =>
        leftRecord.interface_record_id.localeCompare(rightRecord.interface_record_id));
      const outputSummary = {
        dataset_family: "protein_structure",
        evidence_origin: "deterministic_derive",
        row_count: records.length,
        records,
        parameter_digest: parameterDigest,
        reference_digest: request.reference.digest,
        input_digests: [inputDigest],
      };
      return { outputDigest: canonicalDigest(outputSummary), outputSummary };
    },
  };
}

type TraceState = "match" | "gap_query" | "gap_reference";

interface AlignmentCell {
  score: number;
  previous: TraceState | null;
}

function best(candidates: readonly [number, TraceState][]): AlignmentCell {
  let winner = candidates[0]!;
  for (const candidate of candidates.slice(1)) {
    if (candidate[0] > winner[0]) winner = candidate;
  }
  return { score: winner[0], previous: winner[1] };
}

function assertSequence(value: string, name: string): string {
  const sequence = value.trim().toUpperCase();
  if (sequence === "" || !/^[A-Z*]+$/.test(sequence)) {
    fail(`${name} must contain an ungapped residue sequence`);
  }
  return sequence;
}

function globalAlignment(
  query: string,
  reference: string,
  matchScore: number,
  mismatchScore: number,
  gapOpen: number,
  gapExtend: number,
): Array<{ queryPosition: number; queryResidue: string; referencePosition: number | null; referenceResidue: string | null }> {
  const negativeInfinity = Number.NEGATIVE_INFINITY;
  const rows = query.length + 1;
  const columns = reference.length + 1;
  const match: AlignmentCell[][] = Array.from({ length: rows }, () =>
    Array.from({ length: columns }, () => ({ score: negativeInfinity, previous: null })));
  const gapQuery: AlignmentCell[][] = Array.from({ length: rows }, () =>
    Array.from({ length: columns }, () => ({ score: negativeInfinity, previous: null })));
  const gapReference: AlignmentCell[][] = Array.from({ length: rows }, () =>
    Array.from({ length: columns }, () => ({ score: negativeInfinity, previous: null })));
  match[0]![0] = { score: 0, previous: null };
  for (let column = 1; column < columns; column += 1) {
    gapQuery[0]![column] = {
      score: gapOpen + (column - 1) * gapExtend,
      previous: column === 1 ? "match" : "gap_query",
    };
  }
  for (let row = 1; row < rows; row += 1) {
    gapReference[row]![0] = {
      score: gapOpen + (row - 1) * gapExtend,
      previous: row === 1 ? "match" : "gap_reference",
    };
  }
  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const residueScore = query[row - 1] === reference[column - 1]
        ? matchScore
        : mismatchScore;
      const diagonal = best([
        [match[row - 1]![column - 1]!.score, "match"],
        [gapQuery[row - 1]![column - 1]!.score, "gap_query"],
        [gapReference[row - 1]![column - 1]!.score, "gap_reference"],
      ]);
      match[row]![column] = {
        score: diagonal.score + residueScore,
        previous: diagonal.previous,
      };
      gapQuery[row]![column] = best([
        [match[row]![column - 1]!.score + gapOpen, "match"],
        [gapQuery[row]![column - 1]!.score + gapExtend, "gap_query"],
        [gapReference[row]![column - 1]!.score + gapOpen, "gap_reference"],
      ]);
      gapReference[row]![column] = best([
        [match[row - 1]![column]!.score + gapOpen, "match"],
        [gapReference[row - 1]![column]!.score + gapExtend, "gap_reference"],
        [gapQuery[row - 1]![column]!.score + gapOpen, "gap_query"],
      ]);
    }
  }

  let row = query.length;
  let column = reference.length;
  let state = best([
    [match[row]![column]!.score, "match"],
    [gapQuery[row]![column]!.score, "gap_query"],
    [gapReference[row]![column]!.score, "gap_reference"],
  ]).previous!;
  const mapped: Array<{
    queryPosition: number;
    queryResidue: string;
    referencePosition: number | null;
    referenceResidue: string | null;
  }> = [];
  while (row > 0 || column > 0) {
    if (state === "match") {
      const previous = match[row]![column]!.previous;
      mapped.push({
        queryPosition: row,
        queryResidue: query[row - 1]!,
        referencePosition: column,
        referenceResidue: reference[column - 1]!,
      });
      row -= 1;
      column -= 1;
      state = previous!;
    } else if (state === "gap_query") {
      const previous = gapQuery[row]![column]!.previous;
      column -= 1;
      state = previous!;
    } else {
      const previous = gapReference[row]![column]!.previous;
      mapped.push({
        queryPosition: row,
        queryResidue: query[row - 1]!,
        referencePosition: null,
        referenceResidue: null,
      });
      row -= 1;
      state = previous!;
    }
  }
  return mapped.reverse();
}

export function createSequenceReferenceMappingAlgorithm(
  options: SequenceReferenceMappingAlgorithmOptions,
): DeterministicDeriveAlgorithm {
  return {
    algorithmId: SEQUENCE_ALIGNMENT_ALGORITHM_ID,
    algorithmVersion: options.algorithmVersion,
    implementationDigest: options.implementationDigest,
    derive(request) {
      requiredOutputSchema(request, SEQUENCE_REFERENCE_MAPPING_OUTPUT_SCHEMA_ID);
      exactParameterKeys(request.parameters, [
        "gap_extend", "gap_open", "match_score", "mismatch_score", "mode",
      ]);
      if (text(request.parameters.mode, "mode") !== "global") {
        fail("sequence mapping mode must be global");
      }
      const matchScore = finiteNumber(request.parameters.match_score, "match_score");
      const mismatchScore = finiteNumber(request.parameters.mismatch_score, "mismatch_score");
      const gapOpen = finiteNumber(request.parameters.gap_open, "gap_open");
      const gapExtend = finiteNumber(request.parameters.gap_extend, "gap_extend");
      if (matchScore <= 0 || mismatchScore > 0 || gapOpen >= 0 || gapExtend > 0) {
        fail("alignment scoring requires positive match, non-positive mismatch/extension, and negative gap open");
      }
      const query = options.resolveQuery(request);
      const inputDigest = assertSingleInputDigest(request, query.digest);
      const reference = options.resolveReference(request);
      assertReference(request, reference);
      const querySequence = assertSequence(query.sequence, "query sequence");
      const referenceSequence = assertSequence(reference.sequence, "reference sequence");
      const parameterDigest = canonicalDigest(request.parameters);
      const records = globalAlignment(
        querySequence,
        referenceSequence,
        matchScore,
        mismatchScore,
        gapOpen,
        gapExtend,
      ).map((mapping) => {
        const identity = {
          query_sequence_id: query.sequenceId,
          query_position: mapping.queryPosition,
          reference_id: reference.referenceId,
          reference_version: reference.version,
        };
        return {
          mapping_id: `mapping_${canonicalDigest(identity).slice(0, 32)}`,
          ...identity,
          query_residue: mapping.queryResidue,
          reference_position: mapping.referencePosition,
          reference_residue: mapping.referenceResidue,
          mapping_status: mapping.referencePosition === null
            ? "unmapped"
            : mapping.queryResidue === mapping.referenceResidue ? "match" : "mismatch",
          evidence_origin: "deterministic_derive",
          request_identity_digest: request.request_identity_digest,
          parameter_digest: parameterDigest,
          reference_digest: request.reference.digest,
          input_digests: [inputDigest],
        };
      });
      const outputSummary = {
        dataset_family: "variant_evidence",
        evidence_origin: "deterministic_derive",
        row_count: records.length,
        records,
        parameter_digest: parameterDigest,
        reference_digest: request.reference.digest,
        input_digests: [inputDigest],
      };
      return { outputDigest: canonicalDigest(outputSummary), outputSummary };
    },
  };
}
