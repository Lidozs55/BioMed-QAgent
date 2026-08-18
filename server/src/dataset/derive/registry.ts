import { createHash } from "node:crypto";

import type {
  DeterministicDeriveAlgorithm,
  DeterministicDeriveCapability,
} from "./types.js";
import type {
  DeterministicDeriveRequest,
  DeterministicDeriveResultReceipt,
} from "@biomed/contracts";
import {
  computeDeterministicDeriveRequestIdentity,
  parseDeterministicDeriveRequest,
  parseDeterministicDeriveResultReceipt,
} from "../contracts/deterministic-derive.js";
import {
  assertJsonRecord,
  assertNonEmptyString,
  assertSafeId,
  assertSha256,
} from "../contracts/primitives.js";

export const PDB_INTERFACE_DISTANCE_ALGORITHM_ID = "pdb_interface_distance";
export const SEQUENCE_ALIGNMENT_ALGORITHM_ID = "sequence_alignment";

export { computeDeterministicDeriveRequestIdentity };

function resultId(requestIdentityDigest: string, outputDigest: string): string {
  const digest = createHash("sha256")
    .update(`${requestIdentityDigest}:${outputDigest}`, "utf8")
    .digest("hex");
  return `derive_${digest.slice(0, 32)}`;
}

export class DeterministicDeriveRegistry {
  readonly #algorithms = new Map<string, DeterministicDeriveAlgorithm>();

  constructor(initial: readonly DeterministicDeriveAlgorithm[] = []) {
    for (const algorithm of initial) this.register(algorithm);
  }

  register(algorithm: DeterministicDeriveAlgorithm): void {
    const algorithmId = assertSafeId(algorithm.algorithmId, "derive algorithm_id");
    const algorithmVersion = assertNonEmptyString(algorithm.algorithmVersion, "derive algorithm_version");
    if (algorithmVersion.includes("/") || algorithmVersion.includes("\\") || algorithmVersion.includes("..")) {
      throw new TypeError("derive algorithm_version must be a safe version identifier");
    }
    const implementationDigest = assertSha256(algorithm.implementationDigest, "derive implementation_digest");
    if (typeof algorithm.derive !== "function") throw new TypeError("derive algorithm must provide a trusted handler");
    const key = `${algorithmId}@${algorithmVersion}`;
    if (this.#algorithms.has(key)) throw new Error(`derive algorithm '${key}' is already registered`);
    this.#algorithms.set(key, Object.freeze({
      algorithmId,
      algorithmVersion,
      implementationDigest,
      derive: (request: DeterministicDeriveRequest) => algorithm.derive(request),
    }));
  }

  has(algorithmId: string, algorithmVersion: string): boolean {
    return this.#algorithms.has(`${algorithmId}@${algorithmVersion}`);
  }

  get(algorithmId: string, algorithmVersion: string): DeterministicDeriveAlgorithm {
    const algorithm = this.#algorithms.get(`${algorithmId}@${algorithmVersion}`);
    if (algorithm === undefined) {
      throw new Error(`derive algorithm '${algorithmId}@${algorithmVersion}' is not registered`);
    }
    return algorithm;
  }

  list(): string[] {
    return [...this.#algorithms.keys()].sort();
  }

  createCapability(algorithmId: string, algorithmVersion: string): DeterministicDeriveCapability {
    const algorithm = this.get(algorithmId, algorithmVersion);
    return Object.freeze({
      slot: "derive" as const,
      algorithmId: algorithm.algorithmId,
      algorithmVersion: algorithm.algorithmVersion,
      implementationDigest: algorithm.implementationDigest,
      execute: (rawRequest: DeterministicDeriveRequest): DeterministicDeriveResultReceipt => {
        const request = parseDeterministicDeriveRequest(rawRequest);
        if (request.algorithm_id !== algorithm.algorithmId || request.algorithm_version !== algorithm.algorithmVersion) {
          throw new Error("derive request algorithm does not match the registered capability");
        }
        if (request.implementation_digest !== algorithm.implementationDigest) {
          throw new Error("derive request implementation digest does not match the registered capability");
        }
        const execution = algorithm.derive(request);
        const outputDigest = assertSha256(execution.outputDigest, "derive output_digest");
        const outputSummary = assertJsonRecord(execution.outputSummary, "derive output_summary");
        const provenance = {
          schema_version: "1.0" as const,
          slot: "derive" as const,
          request_id: request.request_id,
          request_identity_digest: request.request_identity_digest,
          algorithm_id: request.algorithm_id,
          algorithm_version: request.algorithm_version,
          implementation_digest: request.implementation_digest,
          parameters: request.parameters,
          reference: request.reference,
          inputs: request.inputs,
          output_schema_ref: request.output_schema_ref,
          output_digest: outputDigest,
        };
        return parseDeterministicDeriveResultReceipt({
          schema_version: "1.0",
          result_id: resultId(request.request_identity_digest, outputDigest),
          task_id: request.task_id,
          build_id: request.build_id,
          slot: "derive",
          request_id: request.request_id,
          request_identity_digest: request.request_identity_digest,
          output_kind: "derived_evidence",
          output_schema_ref: request.output_schema_ref,
          output_digest: outputDigest,
          output_summary: outputSummary,
          provenance,
        }, request.task_id, request.build_id);
      },
    });
  }
}
