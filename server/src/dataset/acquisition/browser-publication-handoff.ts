import type {
  DynamicFamilyPreflightReceipt,
  FamilySpec,
  OperationResultManifest,
  Projection,
} from "@biomed/contracts";
import type { CoreAcquisitionProvenance } from "../../runtime/source-assets/registry.js";
import type { DynamicFamilyTableOutputs } from "../dynamic-family/index.js";

export interface BrowserEvidenceAcceptance {
  readonly requestId: string;
  readonly reviewId: string;
  readonly hilEvidenceDigest: string;
  readonly acceptedBrowserEvidenceDigests: readonly string[];
  readonly reviewer: "user";
  readonly reviewedAt: string;
  readonly reason: string | null;
}

export interface BrowserPublicationHandoffInput {
  taskId: string;
  runId: string;
  requirementId: string;
  generation: number;
  familySpec: FamilySpec;
  projection: Projection;
  preflightReceipt: DynamicFamilyPreflightReceipt;
  tableOutputs: Readonly<Record<string, DynamicFamilyTableOutputs>>;
  integratedResults: readonly OperationResultManifest[];
  sourceAcquisitionProvenance: readonly CoreAcquisitionProvenance[];
  browserEvidenceDigests: readonly string[];
  browserEvidenceAcceptance: BrowserEvidenceAcceptance;
  trustedRoot: string;
}

export interface BrowserPublicationHandoff {
  readonly kind: "browser_publication_handoff";
  readonly taskId: string;
  readonly runId: string;
  readonly requirementId: string;
  readonly generation: number;
  readonly familySpec: FamilySpec;
  readonly projection: Projection;
  readonly preflightReceipt: DynamicFamilyPreflightReceipt;
  readonly tableOutputs: Readonly<Record<string, DynamicFamilyTableOutputs>>;
  readonly integratedResults: readonly OperationResultManifest[];
  readonly sourceAcquisitionProvenance: readonly CoreAcquisitionProvenance[];
  readonly browserEvidenceDigests: readonly string[];
  readonly browserEvidenceAcceptance: BrowserEvidenceAcceptance;
  readonly trustedRoot: string;
}

/**
 * Validates the browser-specific execution handoff without pretending that it
 * is a transform execution result. Publication adapters may consume this only
 * after mapping it to their explicit execution variant.
 */
export function createBrowserPublicationHandoff(
  input: BrowserPublicationHandoffInput,
): BrowserPublicationHandoff {
  if (input.taskId.length === 0 || input.runId.length === 0 || input.requirementId.length === 0) {
    throw new TypeError("browser publication handoff requires task/run/build identity");
  }
  if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
    throw new TypeError("browser publication handoff requires a non-negative generation");
  }
  if (input.browserEvidenceDigests.length === 0) {
    throw new TypeError("browser publication handoff requires browser evidence digests");
  }
  if (input.browserEvidenceAcceptance.requestId.length === 0 || input.browserEvidenceAcceptance.reviewId.length === 0) {
    throw new TypeError("browser publication handoff requires browser evidence acceptance identity");
  }
  if (input.browserEvidenceAcceptance.hilEvidenceDigest.length !== 64 || !/^[0-9a-f]+$/.test(input.browserEvidenceAcceptance.hilEvidenceDigest)) {
    throw new TypeError("browser publication handoff requires a valid HIL evidence digest");
  }
  const acceptedEvidence = new Set(input.browserEvidenceAcceptance.acceptedBrowserEvidenceDigests);
  if (acceptedEvidence.size === 0 || acceptedEvidence.size !== input.browserEvidenceAcceptance.acceptedBrowserEvidenceDigests.length) {
    throw new TypeError("browser evidence acceptance requires unique browser evidence digests");
  }
  for (const digest of input.browserEvidenceAcceptance.acceptedBrowserEvidenceDigests) {
    if (digest.length !== 64 || !/^[0-9a-f]+$/.test(digest)) throw new TypeError("browser evidence acceptance contains an invalid browser evidence digest");
  }
  if (acceptedEvidence.size !== input.browserEvidenceDigests.length || input.browserEvidenceDigests.some((digest) => !acceptedEvidence.has(digest))) {
    throw new TypeError("browser evidence acceptance does not cover the publication evidence");
  }
  if (input.sourceAcquisitionProvenance.length === 0) {
    throw new TypeError("browser publication handoff requires acquisition provenance");
  }
  const selected = [
    ...input.projection.primary_tables,
    ...input.projection.supporting_tables,
    ...input.projection.derived_tables,
  ];
  if (selected.length === 0) throw new TypeError("browser publication handoff requires selected projection tables");
  for (const tableId of selected) {
    const output = input.tableOutputs[tableId];
    if (output === undefined) throw new TypeError(`browser publication handoff missing table output: ${tableId}`);
    if (output.data.operation_kind !== "integrate" || output.data.output_kind !== "integrated_table") {
      throw new TypeError(`browser publication handoff requires integrated table: ${tableId}`);
    }
    if (output.provenance.length === 0 || output.confidence.length === 0) {
      throw new TypeError(`browser publication handoff missing evidence closure: ${tableId}`);
    }
  }
  const resultIds = new Set(input.integratedResults.map((result) => result.result_manifest_id));
  for (const tableId of selected) {
    const result = input.tableOutputs[tableId]!.data;
    if (!resultIds.has(result.result_manifest_id)) {
      throw new TypeError(`browser publication handoff integrated result list misses: ${tableId}`);
    }
  }
  return Object.freeze({
    kind: "browser_publication_handoff",
    taskId: input.taskId,
    runId: input.runId,
    requirementId: input.requirementId,
    generation: input.generation,
    familySpec: input.familySpec,
    projection: input.projection,
    preflightReceipt: input.preflightReceipt,
    tableOutputs: input.tableOutputs,
    integratedResults: [...input.integratedResults],
    sourceAcquisitionProvenance: [...input.sourceAcquisitionProvenance],
    browserEvidenceDigests: [...input.browserEvidenceDigests],
    browserEvidenceAcceptance: { ...input.browserEvidenceAcceptance },
    trustedRoot: input.trustedRoot,
  });
}
