import type { FamilySpec, Projection } from "@biomed/contracts";
import type { DynamicFamilyTableOutputs } from "../dynamic-family/index.js";
import {
  materializeDynamicFamilyCandidate,
  type DynamicFamilyMaterialization,
} from "../dynamic-family/index.js";

export interface BrowserFamilyMaterializationInput {
  taskId: string;
  requirementId: string;
  familySpec: FamilySpec;
  projection: Projection;
  tableOutputs: Readonly<Record<string, DynamicFamilyTableOutputs>>;
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
    const output = input.tableOutputs[tableId];
    if (output === undefined) throw new Error(`browser family materialization is missing selected table: ${tableId}`);
    if (output.data.operation_kind !== "integrate" || output.data.output_kind !== "integrated_table") {
      throw new Error(`browser family materialization requires integrated-table result: ${tableId}`);
    }
    if (output.data.output_summary.table_id !== tableId) throw new Error(`browser integrated result table mismatch: ${tableId}`);
    if (output.provenance.length === 0) throw new Error(`browser family materialization requires provenance results: ${tableId}`);
    if (output.confidence.length === 0) throw new Error(`browser family materialization requires confidence results: ${tableId}`);
    return [tableId, output];
  }));
  return materializeDynamicFamilyCandidate({
    taskId: input.taskId,
    requirementId: input.requirementId,
    familySpec: input.familySpec,
    projection: input.projection,
    tableOutputs,
  });
}
