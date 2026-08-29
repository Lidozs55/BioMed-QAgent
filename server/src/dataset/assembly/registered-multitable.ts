import type { DatasetSchemaV2, JsonValue, OperationResultManifest, PublicationCandidate } from "@biomed/contracts";
import { parseDatasetSchemaV2 } from "../contracts/index.js";
import type { FamilyAssemblerHandler, FamilyAssemblyInput } from "./types.js";
import { assembleLiteratureEvidenceCandidate, literatureEvidenceTables } from "../families/literature-evidence/index.js";
import { assembleTargetEvidenceCandidate } from "../families/target-evidence/index.js";
import { assembleVariantEvidenceCandidate } from "../families/variant-evidence/index.js";
import { assembleProteinStructureCandidate } from "../families/protein-structure/index.js";
import { assembleBioactivityCandidate, type BioactivityRows } from "../families/bioactivity-measurement/index.js";
import {
  assembleBioactivityChartEvidenceCandidate,
  CHART_PAPERS_TABLE_ID,
  CHART_POINTS_TABLE_ID,
  CHART_SERIES_TABLE_ID,
  CHART_SOURCES_TABLE_ID,
  type ChartEvidenceRows,
  type ChartEvidenceTableAssemblyInput,
} from "../families/bioactivity-measurement/chart-evidence/index.js";
import { assembleGutMicrobiomeCandidate } from "../families/gut-microbiome/index.js";
import { inheritedDiseaseEvidenceAssembler } from "../families/inherited-disease-evidence/index.js";

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

export const gutMicrobiomeRegisteredAssembler: FamilyAssemblerHandler = {
  familyId: "gut_microbiome",
  handlerId: "gut_microbiome.assembler.v1",
  assemble: (input) => assembleGutMicrobiomeCandidate({
    taskId: input.taskId,
    requirementId: input.requirementId,
    datasetFamily: input.datasetFamily,
    rowGranularity: input.rowGranularity,
    tables: tableInputs(input, [
      "study_records",
      "taxon_records",
      "differential_abundance_records",
      "reference_prevalence_records",
    ] as const),
    registeredAssetIds: input.registeredAssetIds,
  }),
};

export const inheritedDiseaseEvidenceRegisteredAssembler: FamilyAssemblerHandler = inheritedDiseaseEvidenceAssembler;

export const bioactivityRegisteredAssembler: FamilyAssemblerHandler = {
  familyId: "bioactivity_measurement",
  handlerId: "bioactivity_measurement.assembler.v1",
  assemble: (input) => {
    const tableResults = results(input);
    if (tableResults[CHART_SERIES_TABLE_ID] !== undefined) {
      return assembleBioactivityChartCandidate(input, tableResults);
    }
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

const CHART_TABLE_IDS = [
  CHART_SERIES_TABLE_ID,
  CHART_POINTS_TABLE_ID,
  CHART_PAPERS_TABLE_ID,
  CHART_SOURCES_TABLE_ID,
] as const;

function chartRowsFrom(
  input: FamilyAssemblyInput,
  tableId: (typeof CHART_TABLE_IDS)[number],
): readonly Record<string, unknown>[] {
  const rows = input.tableRows?.[tableId];
  if (rows === undefined) {
    throw new Error(`chart evidence assembly requires parsed rows for '${tableId}'`);
  }
  return rows;
}

function assembleBioactivityChartCandidate(
  input: FamilyAssemblyInput,
  tableResults: Readonly<Record<string, OperationResultManifest>>,
): PublicationCandidate {
  const missing = CHART_TABLE_IDS.filter((tableId) => tableResults[tableId] === undefined);
  if (missing.length > 0) {
    throw new Error(`chart evidence assembly requires all chart tables; missing: ${missing.join(", ")}`);
  }
  const baseRows = input.tableRows;
  if (baseRows === undefined) {
    throw new Error("chart evidence assembly requires parsed bioactivity and chart rows");
  }
  const bioactivityRows = {
    activities: baseRows.activities ?? [],
    compounds: baseRows.compounds ?? [],
    assays: baseRows.assays ?? [],
    targets: baseRows.targets ?? [],
  } as unknown as BioactivityRows;
  const chartRows: ChartEvidenceRows = {
    chart_series: chartRowsFrom(input, CHART_SERIES_TABLE_ID) as unknown as ChartEvidenceRows["chart_series"],
    chart_points: chartRowsFrom(input, CHART_POINTS_TABLE_ID) as unknown as ChartEvidenceRows["chart_points"],
    papers: chartRowsFrom(input, CHART_PAPERS_TABLE_ID) as unknown as ChartEvidenceRows["papers"],
    sources: chartRowsFrom(input, CHART_SOURCES_TABLE_ID) as unknown as ChartEvidenceRows["sources"],
  };
  return assembleBioactivityChartEvidenceCandidate({
    bioactivity: {
      taskId: input.taskId,
      requirementId: input.requirementId,
      datasetFamily: input.datasetFamily,
      rowGranularity: input.rowGranularity,
      tables: tableInputs(input, ["activities", "compounds", "assays", "targets"] as const),
      registeredAssetIds: input.registeredAssetIds,
      rows: bioactivityRows,
    },
    chartTables: CHART_TABLE_IDS.map((tableId): ChartEvidenceTableAssemblyInput => ({
      tableId,
      result: tableResults[tableId]!,
      provenanceResults: [tableResults[tableId]!],
      confidenceResults: [tableResults[tableId]!],
    })),
    chartRows,
    bioactivityRows,
    registeredAssetIds: input.registeredAssetIds,
  });
}
