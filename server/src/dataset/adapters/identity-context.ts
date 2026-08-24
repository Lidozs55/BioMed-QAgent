import type { AuthoritativeDatasetIdentityContext } from "../identity/authoritative.js";
import {
  validateAssetId,
  validateDatasetId,
  validateDatasetRevisionId,
} from "../identity/index.js";

/**
 * The narrow identity capability consumed by expression parsers.  The Core
 * derives it from task-owned receipts; adapters only project the already
 * closed identity into source-long rows.
 */
export interface ExpressionAdapterIdentityContext {
  readonly schemaRef: "gene_expression.long.v2" | "gene_expression.probe_long.v2";
  readonly datasetId: string;
  readonly datasetRevisionId: string;
  readonly carrierAssetIds: readonly string[];
  readonly sourceAssetId: string;
}

export function expressionAdapterIdentityFromCore(
  context: AuthoritativeDatasetIdentityContext,
  sourceAssetId: string,
): ExpressionAdapterIdentityContext {
  validateAssetId(sourceAssetId);
  if (!context.carrierAssetIds.includes(sourceAssetId)) {
    throw new TypeError("expression source asset is outside the authoritative carrier closure");
  }
  return Object.freeze({
    schemaRef: context.schemaRef,
    datasetId: context.datasetId,
    datasetRevisionId: context.datasetRevisionId,
    carrierAssetIds: Object.freeze([...context.carrierAssetIds]),
    sourceAssetId,
  });
}

/** Validate a parser capability at the adapter boundary. */
export function parseExpressionAdapterIdentityContext(
  value: unknown,
): ExpressionAdapterIdentityContext {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("expression identity context must be an object");
  }
  const record = value as Record<string, unknown>;
  const expected = [
    "carrierAssetIds",
    "datasetId",
    "datasetRevisionId",
    "schemaRef",
    "sourceAssetId",
  ].sort();
  const keys = Object.keys(record).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError("expression identity context has unknown or missing fields");
  }
  const schemaRef = record.schemaRef;
  if (schemaRef !== "gene_expression.long.v2" && schemaRef !== "gene_expression.probe_long.v2") {
    throw new TypeError("expression identity context schemaRef must be a V2 expression schema");
  }
  const datasetId = validateDatasetId(record.datasetId as string);
  const datasetRevisionId = validateDatasetRevisionId(record.datasetRevisionId as string);
  const sourceAssetId = validateAssetId(record.sourceAssetId as string);
  if (!Array.isArray(record.carrierAssetIds) || record.carrierAssetIds.length === 0) {
    throw new TypeError("expression identity context carrierAssetIds must be non-empty");
  }
  const carrierAssetIds = record.carrierAssetIds.map((assetId) => validateAssetId(assetId as string));
  const sorted = [...carrierAssetIds].sort();
  if (new Set(carrierAssetIds).size !== carrierAssetIds.length ||
      carrierAssetIds.some((assetId, index) => assetId !== sorted[index])) {
    throw new TypeError("expression identity context carrierAssetIds must be sorted and unique");
  }
  if (!carrierAssetIds.includes(sourceAssetId)) {
    throw new TypeError("expression source asset is outside the authoritative carrier closure");
  }
  return Object.freeze({
    schemaRef,
    datasetId,
    datasetRevisionId,
    carrierAssetIds: Object.freeze(carrierAssetIds),
    sourceAssetId,
  });
}
