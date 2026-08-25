export function filesUnder(inputPath: string): string[];

export function expectedContractOutputs(
  sourceRoot: string,
  outputRoot: string,
): string[];

export function computeInputDigest(inputFiles: readonly string[], root: string): string;

export function outputsAreReusable(
  outputFiles: readonly string[],
  stampPath: string,
  inputDigest: string,
): boolean;

export interface ContractBuildState {
  contractsRoot: string;
  inputDigest: string;
  outputFiles: string[];
  outputRoot: string;
  stampPath: string;
}

export function contractBuildState(root: string): ContractBuildState;

export function ensureContractsBuilt(root?: string): "reused" | "built";
