import type {
  DeterministicDeriveRequest,
  DeterministicDeriveResultReceipt,
  JsonValue,
} from "@biomed/contracts";

export interface DeterministicDeriveAlgorithm {
  readonly algorithmId: string;
  readonly algorithmVersion: string;
  readonly implementationDigest: string;
  derive(request: DeterministicDeriveRequest): DeterministicDeriveExecution;
}

export interface DeterministicDeriveExecution {
  readonly outputDigest: string;
  readonly outputSummary: Record<string, JsonValue>;
}

export interface DeterministicDeriveCapability {
  readonly slot: "derive";
  readonly algorithmId: string;
  readonly algorithmVersion: string;
  readonly implementationDigest: string;
  execute(request: DeterministicDeriveRequest): DeterministicDeriveResultReceipt;
}
