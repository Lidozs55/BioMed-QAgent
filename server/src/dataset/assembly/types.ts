import type {
  OperationResultManifest,
  PublicationCandidate,
} from "@biomed/contracts";
import type { DatasetSchema } from "../contracts/index.js";

export interface FamilyAssemblyInput {
  taskId: string;
  runId?: string;
  requirementId: string;
  datasetFamily: string;
  rowGranularity: string;
  schema: DatasetSchema;
  integrationResult: OperationResultManifest;
  integrationResults?: Readonly<Record<string, OperationResultManifest>>;
  registeredAssetIds: readonly string[];
  /** Parsed row values per table; required by assemblers with row-level gates. */
  tableRows?: Readonly<Record<string, readonly Record<string, unknown>[]>>;
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
