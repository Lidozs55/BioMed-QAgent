import type {
  OperationResultManifest,
  OperationResultOutputKind,
  PublicationCandidateResultRef,
} from "@biomed/contracts";
import { parseOperationResultManifest } from "../contracts/index.js";

export function requireCoreResult(options: {
  result: OperationResultManifest;
  taskId: string;
  buildId: string;
  operationKind?: OperationResultManifest["operation_kind"];
  outputKind?: OperationResultOutputKind;
}): OperationResultManifest {
  const result = parseOperationResultManifest(
    options.result,
    options.taskId,
    options.buildId,
  );
  if (result.status !== "succeeded") {
    throw new Error(`Core result '${result.result_manifest_id}' must have succeeded`);
  }
  if (result.migration.mode !== "native") {
    throw new Error(`Core result '${result.result_manifest_id}' must be native`);
  }
  if (options.operationKind !== undefined && result.operation_kind !== options.operationKind) {
    throw new Error(
      `Core result '${result.result_manifest_id}' must be ${options.operationKind}`,
    );
  }
  if (options.outputKind !== undefined && result.output_kind !== options.outputKind) {
    throw new Error(
      `Core result '${result.result_manifest_id}' must output ${options.outputKind}`,
    );
  }
  if (result.output_files.length === 0) {
    throw new Error(`Core result '${result.result_manifest_id}' has no file receipt`);
  }
  return result;
}

export function resultRefForHash(
  result: OperationResultManifest,
  sha256: string,
): PublicationCandidateResultRef {
  const outputFileIndex = result.output_files.findIndex((file) => file.sha256 === sha256);
  if (outputFileIndex < 0) {
    throw new Error(
      `Core result '${result.result_manifest_id}' has no receipt for ${sha256}`,
    );
  }
  return {
    result_manifest_id: result.result_manifest_id,
    output_kind: result.output_kind,
    output_file_index: outputFileIndex,
    output_file_sha256: sha256,
  };
}

export function resultRefs(options: {
  results: readonly OperationResultManifest[];
  taskId: string;
  buildId: string;
}): PublicationCandidateResultRef[] {
  return [...options.results]
    .sort((left, right) => left.result_manifest_id.localeCompare(right.result_manifest_id))
    .flatMap((result) => {
      const parsed = requireCoreResult({
        result,
        taskId: options.taskId,
        buildId: options.buildId,
      });
      return parsed.output_files.map((file, outputFileIndex) => ({
        result_manifest_id: parsed.result_manifest_id,
        output_kind: parsed.output_kind,
        output_file_index: outputFileIndex,
        output_file_sha256: file.sha256,
      }));
    });
}
