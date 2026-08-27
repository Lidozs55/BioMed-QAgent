import type { DatasetSchemaV2, JsonValue, OperationResultManifest } from "@biomed/contracts";
import { parseDatasetSchemaV2 } from "../contracts/index.js";
import type { FamilyAssemblerHandler, FamilyAssemblyInput } from "./types.js";
import { assembleLiteratureEvidenceCandidate, literatureEvidenceTables } from "../families/literature-evidence/index.js";
import { assembleTargetEvidenceCandidate } from "../families/target-evidence/index.js";
import { assembleVariantEvidenceCandidate } from "../families/variant-evidence/index.js";
import { assembleProteinStructureCandidate } from "../families/protein-structure/index.js";
import { assembleBioactivityCandidate } from "../families/bioactivity-measurement/index.js";

function results(input: FamilyAssemblyInput): Readonly<Record<string, OperationResultManifest>> {
  if (input.integrationResults === undefined) {
    throw new Error(`registered multi-table assembler '${input.datasetFamily}' requires table results`);
  }
  return input.integrationResults;
}

function requireResult(input: FamilyAssemblyInput, tableId: string): OperationResultManifest {
  const result = results(input)[tableId];
  if (result === undefined) throw new Error(`registered multi-table assembler requires table '${tableId}'`);
  return result;
}

function tableInputs<T extends string>(input: FamilyAssemblyInput, tableIds: readonly T[]) {
  return tableIds.map((tableId): {
    tableId: T;
    result: OperationResultManifest;
    provenanceResults: OperationResultManifest[];
    confidenceResults: OperationResultManifest[];
  } => ({
    tableId,
    result: requireResult(input, tableId),
    provenanceResults: [requireResult(input, tableId)],
    confidenceResults: [requireResult(input, tableId)],
  }));
}

function aggregateLiterature(input: FamilyAssemblyInput): OperationResultManifest {
  const entries = literatureEvidenceTables.map(({ definition, schema }) => {
    const result = requireResult(input, definition.table_id);
    const summary = result.output_summary;
    const file = result.output_files[0];
    if (file === undefined) throw new Error(`literature table '${definition.table_id}' has no output receipt`);
    return { definition, schema, result, file, summary };
  });
  const tables: Record<string, JsonValue> = {};
  for (const entry of entries) {
    tables[entry.definition.table_id] = {
      schema_ref: entry.schema.schema_id,
      row_count: entry.summary.row_count as JsonValue,
      file_sha256: entry.file.sha256,
    };
  }
  const primary = entries[0]!.result;
  return {
    ...primary,
    result_manifest_id: `result_literature_aggregate_${primary.result_manifest_id}`,
    operation_id: "integrate",
    output_summary: {
      dataset_family: input.datasetFamily,
      row_granularity: input.rowGranularity,
      tables,
    },
    output_files: entries.map((entry) => entry.file),
    dependency_closure: {
      ...primary.dependency_closure,
      input_asset_ids: [...new Set(entries.flatMap((entry) => entry.result.dependency_closure.input_asset_ids))].sort(),
      upstream_result_manifest_ids: entries.map((entry) => entry.result.result_manifest_id).sort(),
    },
  };
}

export const literatureEvidenceRegisteredAssembler: FamilyAssemblerHandler = {
  familyId: "literature_evidence",
  handlerId: "literature_evidence.assembler.v1",
  assemble(input) {
    const aggregate = aggregateLiterature(input);
    return assembleLiteratureEvidenceCandidate({
      ...input,
      integrationResult: aggregate,
      provenanceResults: Object.values(results(input)),
      confidenceResults: Object.values(results(input)),
    });
  },
};

export const targetEvidenceRegisteredAssembler: FamilyAssemblerHandler = {
  familyId: "target_evidence",
  handlerId: "target_evidence.assembler.v1",
  assemble: (input) => assembleTargetEvidenceCandidate({
    taskId: input.taskId,
    requirementId: input.requirementId,
    datasetFamily: input.datasetFamily,
    rowGranularity: input.rowGranularity,
    tables: tableInputs(input, ["targets", "evidence", "sources", "supporting"] as const),
    registeredAssetIds: input.registeredAssetIds,
  }),
};

export const variantEvidenceRegisteredAssembler: FamilyAssemblerHandler = {
  familyId: "variant_evidence",
  handlerId: "variant_evidence.assembler.v1",
  assemble(input) {
    const schema: DatasetSchemaV2 = parseDatasetSchemaV2(input.schema);
    return assembleVariantEvidenceCandidate({
      ...input,
      schema,
      integrationResult: requireResult(input, "variant_assertions"),
      evidenceResult: requireResult(input, "evidence"),
      sourceResult: requireResult(input, "sources"),
      provenanceResults: Object.values(results(input)),
      confidenceResults: Object.values(results(input)),
    });
  },
};

export const proteinStructureRegisteredAssembler: FamilyAssemblerHandler = {
  familyId: "protein_structure",
  handlerId: "protein_structure.assembler.v1",
  assemble: (input) => assembleProteinStructureCandidate({
    taskId: input.taskId,
    requirementId: input.requirementId,
    datasetFamily: input.datasetFamily,
    rowGranularity: input.rowGranularity,
    tables: tableInputs(input, ["structures", "chains", "ligands", "sources"] as const),
    registeredAssetIds: input.registeredAssetIds,
  }),
};

export const bioactivityRegisteredAssembler: FamilyAssemblerHandler = {
  familyId: "bioactivity_measurement",
  handlerId: "bioactivity_measurement.assembler.v1",
  assemble: (input) => {
    const baseTables = tableInputs(input, ["activities", "compounds", "assays", "targets"] as const);
    const identityTables = results(input).compound_crosswalks === undefined
      ? []
      : tableInputs(input, ["compound_crosswalks"] as const);
    return assembleBioactivityCandidate({
      taskId: input.taskId,
      requirementId: input.requirementId,
      datasetFamily: input.datasetFamily,
      rowGranularity: input.rowGranularity,
      tables: [...baseTables, ...identityTables],
      registeredAssetIds: input.registeredAssetIds,
    });
  },
};
