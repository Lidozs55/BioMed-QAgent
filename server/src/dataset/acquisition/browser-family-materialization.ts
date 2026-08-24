import type { FamilySpec, OperationResultManifest, Projection } from "@biomed/contracts";
import {
  materializeDynamicFamilyCandidate,
  type DynamicFamilyMaterialization,
} from "../dynamic-family/index.js";

export interface BrowserFamilyMaterializationInput {
  taskId: string;
  buildId: string;
  familySpec: FamilySpec;
  projection: Projection;
  integratedTables: Readonly<Record<string, OperationResultManifest>>;
}

/**
 * Core-only bridge from one browser-integrated table to the existing generic
 * FamilySpec materializer. It does not infer missing tables or publish.
 */
export async function materializeBrowserIntegratedFamily(
  input: BrowserFamilyMaterializationInput,
): Promise<DynamicFamilyMaterialization> {
  const selected = [
    ...input.projection.primary_tables,
    ...input.projection.supporting_tables,
    ...input.projection.derived_tables,
  ];
  const tableOutputs = Object.fromEntries(selected.map((tableId) => {
    const integratedTable = input.integratedTables[tableId];
    if (integratedTable === undefined) throw new Error(`browser family materialization is missing selected table: ${tableId}`);
    if (integratedTable.operation_kind !== "integrate" || integratedTable.output_kind !== "integrated_table") {
      throw new Error(`browser family materialization requires integrated-table result: ${tableId}`);
    }
    if (integratedTable.output_summary.table_id !== tableId) throw new Error(`browser integrated result table mismatch: ${tableId}`);
    return [tableId, { data: integratedTable, provenance: [], confidence: [], audit: [] }];
  }));
  return materializeDynamicFamilyCandidate({
    taskId: input.taskId,
    buildId: input.buildId,
    familySpec: input.familySpec,
    projection: input.projection,
    tableOutputs,
  });
}
