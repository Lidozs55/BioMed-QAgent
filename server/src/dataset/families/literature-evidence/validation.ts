import path from "node:path";

import type {
  OperationResultManifest,
  PublicationCandidate,
  PublicationCandidateResultRef,
} from "@biomed/contracts";

import { delimitedRowsFromFileAsync } from "../../adapters/text.js";
import {
  parsePublicationCandidate,
  parseSourceLocator,
} from "../../contracts/index.js";
import type {
  MultiTableValidationCheck,
  MultiTableValidationResult,
  MultiTableValidationTable,
  TrustedTableFileInput,
} from "../../contracts/validation.js";
import { requireCoreResult, resultRefs } from "../../assembly/helpers.js";
import { validateMultiTableCandidate } from "../../validation/multitable.js";
import {
  LITERATURE_EVIDENCE_FAMILY_ID,
  LITERATURE_SOURCES_TABLE_ID,
  literatureEvidenceRelations,
  literatureEvidenceTables,
} from "./schema.js";

export interface LiteratureEvidenceValidationInput {
  candidate: PublicationCandidate;
  integration_result: OperationResultManifest;
  provenance_results: readonly OperationResultManifest[];
  confidence_results: readonly OperationResultManifest[];
  trusted_root: string;
  forbidden_roots: string[];
  delimiter?: "," | "\t";
}

function refKey(ref: PublicationCandidateResultRef): string {
  return [
    ref.result_manifest_id,
    ref.output_kind,
    ref.output_file_index,
    ref.output_file_sha256,
  ].join(":");
}

function sameRef(
  left: PublicationCandidateResultRef,
  right: PublicationCandidateResultRef,
): boolean {
  return refKey(left) === refKey(right);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function evidenceByTable(options: {
  candidateRefs: readonly PublicationCandidateResultRef[];
  results: readonly OperationResultManifest[];
  input: LiteratureEvidenceValidationInput;
  kind: "provenance" | "confidence";
}): Map<string, string[]> {
  const tableIds = new Set(literatureEvidenceTables.map(({ definition }) => definition.table_id));
  const byTable = new Map<string, string[]>();
  const expectedRefs = resultRefs({
    results: options.results,
    taskId: options.input.candidate.task_id,
    buildId: options.input.candidate.build_id,
  });
  if (
    expectedRefs.length !== options.candidateRefs.length ||
    expectedRefs.some((ref) => !options.candidateRefs.some((candidateRef) => sameRef(ref, candidateRef)))
  ) {
    throw new Error(`${options.kind} candidate refs do not match supplied Core results`);
  }
  for (const resultValue of options.results) {
    const result = requireCoreResult({
      result: resultValue,
      taskId: options.input.candidate.task_id,
      buildId: options.input.candidate.build_id,
    });
    const tableId = result.output_summary.table_id;
    if (typeof tableId !== "string" || !tableIds.has(tableId)) {
      throw new Error(`${options.kind} result must identify a literature table_id`);
    }
    if (byTable.has(tableId) || result.output_files.length !== 1) {
      throw new Error(`${options.kind} requires exactly one result file per literature table`);
    }
    byTable.set(
      tableId,
      expectedRefs.filter((ref) => ref.result_manifest_id === result.result_manifest_id).map(refKey),
    );
  }
  if (byTable.size !== tableIds.size) {
    throw new Error(`${options.kind} requires exactly one result for every literature table`);
  }
  return byTable;
}

function trustedTableFiles(
  input: LiteratureEvidenceValidationInput,
): Map<string, TrustedTableFileInput> {
  const integration = requireCoreResult({
    result: input.integration_result,
    taskId: input.candidate.task_id,
    buildId: input.candidate.build_id,
    operationKind: "integrate",
    outputKind: "integrated_table",
  });
  const files = new Map<string, TrustedTableFileInput>();
  for (const table of input.candidate.tables) {
    if (table.data_ref.result_manifest_id !== integration.result_manifest_id) {
      throw new Error(`table '${table.definition.table_id}' is not backed by the integration result`);
    }
    const receipt = integration.output_files[table.data_ref.output_file_index];
    if (
      receipt === undefined ||
      receipt.sha256 !== table.data_ref.output_file_sha256 ||
      table.data_ref.output_kind !== integration.output_kind
    ) {
      throw new Error(`table '${table.definition.table_id}' has an invalid integration receipt ref`);
    }
    files.set(table.definition.table_id, {
      origin: "core_operation_result",
      relative_path: receipt.relative_path,
      delimiter: input.delimiter ?? ",",
      operation_result: integration,
    });
  }
  return files;
}

function validationTables(
  input: LiteratureEvidenceValidationInput,
): MultiTableValidationTable[] {
  const parsed = parsePublicationCandidate(input.candidate);
  if (parsed.dataset_family !== LITERATURE_EVIDENCE_FAMILY_ID) {
    throw new Error("candidate is not a literature_evidence family candidate");
  }
  const expectedDefinitions = new Map(
    literatureEvidenceTables.map(({ definition }) => [definition.table_id, definition]),
  );
  if (
    parsed.tables.length !== expectedDefinitions.size ||
    parsed.relations.length !== literatureEvidenceRelations.length ||
    !literatureEvidenceRelations.every((relation) =>
      parsed.relations.some((candidateRelation) => sameJson(candidateRelation, relation)))
  ) {
    throw new Error("candidate does not match the literature evidence table/relation shape");
  }
  for (const table of parsed.tables) {
    const expected = expectedDefinitions.get(table.definition.table_id);
    if (expected === undefined || !sameJson(table.definition, expected)) {
      throw new Error(`candidate table '${table.definition.table_id}' does not match the family shape`);
    }
  }

  const files = trustedTableFiles({ ...input, candidate: parsed });
  const provenance = evidenceByTable({
    candidateRefs: parsed.provenance_refs,
    results: input.provenance_results,
    input: { ...input, candidate: parsed },
    kind: "provenance",
  });
  const confidence = evidenceByTable({
    candidateRefs: parsed.confidence_refs,
    results: input.confidence_results,
    input: { ...input, candidate: parsed },
    kind: "confidence",
  });
  const candidateTables = new Map(parsed.tables.map((table) => [table.definition.table_id, table]));
  return literatureEvidenceTables.map(({ schema, definition }) => {
    if (!candidateTables.has(definition.table_id)) {
      throw new Error(`candidate omits literature table '${definition.table_id}'`);
    }
    return {
      definition,
      schema,
      file: files.get(definition.table_id) ?? null,
      provenance_refs: provenance.get(definition.table_id) ?? [],
      confidence_refs: confidence.get(definition.table_id) ?? [],
    };
  });
}

async function validateSourceLocators(
  input: LiteratureEvidenceValidationInput,
  tables: readonly MultiTableValidationTable[],
  signal?: AbortSignal | null,
): Promise<MultiTableValidationCheck> {
  const source = tables.find((table) => table.definition.table_id === LITERATURE_SOURCES_TABLE_ID);
  if (source?.file === null || source?.file === undefined) {
    return {
      check_id: "source_locator_closure",
      scope: LITERATURE_SOURCES_TABLE_ID,
      passed: false,
      detail: "required source table has no trusted file",
    };
  }
  const sourceIdIndex = source.definition.field_names.indexOf("source_id");
  const assetIdIndex = source.definition.field_names.indexOf("source_asset_id");
  const locatorIndex = source.definition.field_names.indexOf("source_locator");
  const registeredAssets = new Set(input.candidate.registered_asset_ids);
  let header = true;
  let rows = 0;
  let invalid = 0;
  const filePath = path.resolve(
    input.trusted_root,
    ...source.file.relative_path.split("/"),
  );
  for await (const row of delimitedRowsFromFileAsync(filePath, source.file.delimiter, signal)) {
    if (header) {
      header = false;
      continue;
    }
    if (row.values.length === 0) continue;
    rows += 1;
    try {
      const sourceId = row.values[sourceIdIndex] ?? "";
      const sourceAssetId = row.values[assetIdIndex] ?? "";
      const locatorJson = row.values[locatorIndex] ?? "";
      const locator = parseSourceLocator(JSON.parse(locatorJson) as unknown);
      if (
        sourceId.length === 0 ||
        !("locator_version" in locator) ||
        locator.locator_version !== "2.0" ||
        locator.asset_id !== sourceAssetId ||
        !registeredAssets.has(sourceAssetId)
      ) {
        invalid += 1;
      }
    } catch {
      invalid += 1;
    }
  }
  return {
    check_id: "source_locator_closure",
    scope: LITERATURE_SOURCES_TABLE_ID,
    passed: rows > 0 && invalid === 0,
    detail: `rows=${rows}; invalid_locator_or_asset_ref=${invalid}`,
  };
}

export async function validateLiteratureEvidenceCandidate(
  input: LiteratureEvidenceValidationInput,
  signal?: AbortSignal | null,
): Promise<MultiTableValidationResult> {
  let tables: MultiTableValidationTable[];
  try {
    tables = validationTables(input);
  } catch (error) {
    return {
      passed: false,
      checks: [{
        check_id: "literature_family_contract",
        scope: input.candidate.candidate_id,
        passed: false,
        detail: error instanceof Error ? error.message : String(error),
      }],
    };
  }
  const candidate = parsePublicationCandidate(input.candidate);
  const result = await validateMultiTableCandidate({
    task_id: candidate.task_id,
    build_id: candidate.build_id,
    candidate: {
      candidate_id: candidate.candidate_id,
      table_ids: candidate.tables.map((table) => table.definition.table_id),
      relation_ids: candidate.relations.map((relation) => relation.relation_id),
      provenance_refs: candidate.provenance_refs.map(refKey),
      confidence_refs: candidate.confidence_refs.map(refKey),
      audit_refs: candidate.audit_refs.map(refKey),
    },
    tables,
    relations: candidate.relations,
    trusted_root: input.trusted_root,
    forbidden_roots: input.forbidden_roots,
    policy: {
      token_preservation_rules: [],
      profile_relation_missing_policies: {},
    },
  }, signal);
  if (!result.passed) return result;
  const locatorCheck = await validateSourceLocators(input, tables, signal);
  return {
    passed: locatorCheck.passed,
    checks: [...result.checks, locatorCheck],
  };
}
