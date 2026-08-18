import type {
  OperationResultManifest,
  PublicationCandidate,
} from "@biomed/contracts";
import type { DatasetSchema } from "../contracts/index.js";

export interface FamilyAssemblyInput {
  taskId: string;
  buildId: string;
  datasetFamily: string;
  rowGranularity: string;
  schema: DatasetSchema;
  integrationResult: OperationResultManifest;
  registeredAssetIds: readonly string[];
  provenanceResults?: readonly OperationResultManifest[];
  confidenceResults?: readonly OperationResultManifest[];
  auditResults?: readonly OperationResultManifest[];
}

export interface FamilyAssemblerHandler {
  readonly familyId: string;
  readonly handlerId: string;
  assemble(input: FamilyAssemblyInput): PublicationCandidate;
}

export interface FamilyAssemblerCapability {
  readonly familyId: string;
  readonly handlerId: string;
  assemble(input: FamilyAssemblyInput): PublicationCandidate;
}
