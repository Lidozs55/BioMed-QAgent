export * from "./profile-scaffold.js";

import {
  parseFamilySpec,
  parseProjection,
  stableStringify,
  verifyFamilySpecDigest,
  type DatasetSchemaV2,
  type FamilySpec,
  type JsonValue,
  type OperationResultManifest,
  type Projection,
  type PublicationCandidate,
  type PublicationCandidateResultRef,
  type TableDefinition,
} from "@biomed/contracts";

import { canonicalDigest } from "../adapters/identity.js";
import {
  parseDatasetSchemaV2,
  parsePublicationCandidate,
} from "../contracts/index.js";
import { checkFamilySpecTopology } from "../family-spec-topology/index.js";
import {
  requireCoreResult,
  resultRefs,
} from "../assembly/helpers.js";

/**
 * The only profile claimed by dynamically materialized schemas. It says
 * nothing about scientific numeric, unit, ontology, or domain semantics.
 */
export const DYNAMIC_STRING_PRESERVING_PROFILE = "dynamic_string_preserving.v1";

export interface DynamicFamilyTableOutputs {
  readonly data: OperationResultManifest;
  readonly provenance: readonly OperationResultManifest[];
  readonly confidence: readonly OperationResultManifest[];
  readonly audit: readonly OperationResultManifest[];
}

export interface DynamicFamilyAssemblyInput {
  readonly taskId: string;
  readonly runId?: string;
  readonly requirementId: string;
  readonly familySpec: FamilySpec;
  readonly projection: Projection;
  readonly tableOutputs: Readonly<Record<string, DynamicFamilyTableOutputs>>;
}

export interface DynamicFamilySchemaMaterialization {
  readonly profile: typeof DYNAMIC_STRING_PRESERVING_PROFILE;
  readonly schemas: readonly DatasetSchemaV2[];
}

export interface DynamicFamilyMaterialization {
  readonly schema_profile: typeof DYNAMIC_STRING_PRESERVING_PROFILE;
  readonly schemas: readonly DatasetSchemaV2[];
  readonly candidate: PublicationCandidate;
}

interface TableSummary {
  readonly table_id: string;
  readonly dataset_family: string;
  readonly row_granularity: string;
  readonly schema_ref: string;
  readonly row_count: number;
  readonly column_count: number;
  readonly primary_file_sha256: string;
}

function summaryString(
  summary: Readonly<Record<string, JsonValue>>,
  key: Exclude<keyof TableSummary, "row_count" | "column_count">,
): string {
  const value = summary[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`dynamic family table summary requires ${key}`);
  }
  return value;
}

function summaryCount(
  summary: Readonly<Record<string, JsonValue>>,
  key: "row_count" | "column_count",
): number {
  const value = summary[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`dynamic family table summary requires non-negative ${key}`);
  }
  return value;
}

function parseTableSummary(
  result: OperationResultManifest,
  tableId: string,
): TableSummary {
  const summaries = result.output_summary.tables;
  let summary: Readonly<Record<string, JsonValue>> = result.output_summary;
  if (summaries !== undefined) {
    if (summaries === null || typeof summaries !== "object" || Array.isArray(summaries)) {
      throw new Error("dynamic family multi-table summary requires a table object");
    }
    const selected = Reflect.get(summaries, tableId);
    if (selected === null || typeof selected !== "object" || Array.isArray(selected)) {
      throw new Error(`dynamic family multi-table summary is missing '${tableId}'`);
    }
    summary = selected as Readonly<Record<string, JsonValue>>;
  }
  return {
    table_id: summaryString(summary, "table_id"),
    dataset_family: summaryString(summary, "dataset_family"),
    row_granularity: summaryString(summary, "row_granularity"),
    schema_ref: summaryString(summary, "schema_ref"),
    row_count: summaryCount(summary, "row_count"),
    column_count: summaryCount(summary, "column_count"),
    primary_file_sha256: summaryString(summary, "primary_file_sha256"),
  };
}

function assertSharedSummaryClosure(
  outputs: Readonly<Record<string, DynamicFamilyTableOutputs>>,
): void {
  const referenced = new Map<string, { result: OperationResultManifest; tables: string[] }>();
  for (const [tableId, table] of Object.entries(outputs)) {
    const entry = referenced.get(table.data.result_manifest_id) ?? { result: table.data, tables: [] };
    entry.tables.push(tableId);
    referenced.set(table.data.result_manifest_id, entry);
  }
  for (const { result, tables } of referenced.values()) {
    const summaries = result.output_summary.tables;
    if (summaries === undefined) {
      if (tables.length !== 1) {
        throw new Error("a shared dynamic OperationResult requires output_summary.tables");
      }
      continue;
    }
    if (summaries === null || typeof summaries !== "object" || Array.isArray(summaries)) {
      throw new Error("dynamic family multi-table summary requires a table object");
    }
    const actual = Object.keys(summaries).sort();
    const expected = [...tables].sort();
    if (actual.length !== expected.length || actual.some((tableId, index) => tableId !== expected[index])) {
      throw new Error("dynamic family multi-table summary must exactly close referenced tables");
    }
  }
}

function selectedTableIds(projection: Projection): string[] {
  return [
    ...projection.primary_tables,
    ...projection.supporting_tables,
    ...projection.derived_tables,
  ];
}

function assertSelectedProjection(spec: FamilySpec, selected: Projection): Projection {
  const parsed = parseProjection(selected, "$projection");
  const declared = spec.projections.find((projection) => projection.projection_id === parsed.projection_id);
  if (declared === undefined) {
    throw new Error(`unknown projection '${parsed.projection_id}'`);
  }
  if (stableStringify(declared) !== stableStringify(parsed)) {
    throw new Error(`selected projection '${parsed.projection_id}' does not exactly match FamilySpec`);
  }
  if (parsed.primary_tables.length !== 1) {
    throw new Error("selected projection must declare exactly one primary table");
  }
  return parsed;
}

function tableDefinitions(
  spec: FamilySpec,
  projection: Projection,
): TableDefinition[] {
  const byId = new Map(spec.table_definitions.map((table) => [table.table_id, table]));
  const required = new Set(projection.required);
  const allowEmpty = new Set(projection.allow_empty);
  return selectedTableIds(projection).map((tableId) => {
    const table = byId.get(tableId);
    if (table === undefined) throw new Error(`unknown selected table '${tableId}'`);
    return {
      ...table,
      primary_key: [...table.primary_key],
      field_names: [...table.field_names],
      required: required.has(tableId),
      allow_empty: allowEmpty.has(tableId),
    };
  });
}

function materializeSelectedSchemas(
  spec: FamilySpec,
  selected: Projection,
): readonly DatasetSchemaV2[] {
  return tableDefinitions(spec, selected).map((table) => {
    const primaryKey = new Set(table.primary_key);
    return parseDatasetSchemaV2({
      schema_version: "2.0",
      schema_id: table.schema_ref,
      dataset_family: spec.family_spec_id,
      row_granularity: selected.row_granularity,
      primary_key: [...table.primary_key],
      fields: table.field_names.map((name) => ({
        schema_version: "2.0",
        name,
        data_type: "string",
        semantic_role: DYNAMIC_STRING_PRESERVING_PROFILE,
        required: primaryKey.has(name),
        nullable: !primaryKey.has(name),
        unit_policy: null,
        ontology: null,
        description: `String-preserving FamilySpec field ${table.table_id}.${name}`,
        derivation_policy: null,
      })),
    });
  });
}

async function verifiedFamilySpec(value: FamilySpec): Promise<FamilySpec> {
  const spec = parseFamilySpec(value, "$family_spec");
  if (!(await verifyFamilySpecDigest(spec))) {
    throw new Error("FamilySpec canonical digest verification failed");
  }
  const topology = checkFamilySpecTopology(spec);
  if (!topology.topology_valid) {
    const details = topology.issues
      .map((issue) => `${issue.code}@${issue.path}: ${issue.message}`)
      .join("; ");
    throw new Error(`invalid FamilySpec topology: ${details}`);
  }
  return spec;
}

/**
 * Materialize only the selected projection's schema closure. Every field stays
 * a string; only primary-key presence/non-nullability is inferred. The wrapper
 * and field metadata carry the explicit conservative profile without claiming
 * a scientific type, unit, ontology, or domain role.
 */
export async function materializeDynamicFamilySchemas(
  familySpec: FamilySpec,
  projection: Projection,
): Promise<DynamicFamilySchemaMaterialization> {
  const spec = await verifiedFamilySpec(familySpec);
  const selected = assertSelectedProjection(spec, projection);
  return {
    profile: DYNAMIC_STRING_PRESERVING_PROFILE,
    schemas: materializeSelectedSchemas(spec, selected),
  };
}

function assertExactTableOutputs(
  outputs: Readonly<Record<string, DynamicFamilyTableOutputs>>,
  selectedIds: readonly string[],
  allTableIds: ReadonlySet<string>,
): void {
  const supplied = Object.keys(outputs);
  const selected = new Set(selectedIds);
  const unknown = supplied.filter((tableId) => !allTableIds.has(tableId)).sort();
  if (unknown.length > 0) throw new Error(`unknown table outputs: ${unknown.join(", ")}`);
  const extra = supplied.filter((tableId) => !selected.has(tableId)).sort();
  if (extra.length > 0) throw new Error(`extra table outputs outside selected projection: ${extra.join(", ")}`);
  const missing = selectedIds.filter((tableId) => !Object.hasOwn(outputs, tableId));
  if (missing.length > 0) throw new Error(`missing selected table outputs: ${missing.join(", ")}`);
  if (supplied.length !== selectedIds.length) {
    throw new Error("table outputs must exactly match the selected projection");
  }
}

function refKey(ref: PublicationCandidateResultRef): string {
  return `${ref.result_manifest_id}\0${ref.output_file_index}`;
}

function assertDisjointEvidence(options: {
  provenance: readonly PublicationCandidateResultRef[];
  confidence: readonly PublicationCandidateResultRef[];
  audit: readonly PublicationCandidateResultRef[];
  data: readonly PublicationCandidateResultRef[];
}): void {
  const owner = new Map<string, string>();
  for (const [kind, refs] of Object.entries(options)) {
    for (const ref of refs) {
      const key = refKey(ref);
      const previous = owner.get(key);
      if (previous !== undefined) {
        throw new Error(`evidence overlap: committed output belongs to both ${previous} and ${kind}`);
      }
      owner.set(key, kind);
    }
  }
}

function exactDataRef(
  result: OperationResultManifest,
  sha256: string,
): PublicationCandidateResultRef {
  const matching = result.output_files
    .map((file, index) => ({ file, index }))
    .filter(({ file }) => file.sha256 === sha256);
  if (matching.length !== 1) {
    throw new Error(`Core result '${result.result_manifest_id}' must contain exactly one receipt for ${sha256}`);
  }
  return {
    result_manifest_id: result.result_manifest_id,
    output_kind: result.output_kind,
    output_file_index: matching[0]!.index,
    output_file_sha256: sha256,
  };
}

function assetClosure(results: readonly OperationResultManifest[]): string[] {
  return [...new Set(results.flatMap((result) => result.dependency_closure.input_asset_ids))].sort();
}

/**
 * Pure Core-side materialization and assembly. This function performs no file
 * access, sandbox execution, registration, publication, or runtime routing.
 */
export async function materializeDynamicFamilyCandidate(
  input: DynamicFamilyAssemblyInput,
): Promise<DynamicFamilyMaterialization> {
  const spec = await verifiedFamilySpec(input.familySpec);
  const projection = assertSelectedProjection(spec, input.projection);
  const definitions = tableDefinitions(spec, projection);
  const selectedIds = definitions.map((table) => table.table_id);
  assertExactTableOutputs(
    input.tableOutputs,
    selectedIds,
    new Set(spec.table_definitions.map((table) => table.table_id)),
  );
  assertSharedSummaryClosure(input.tableOutputs);
  const schemas = materializeSelectedSchemas(spec, projection);
  const schemaByTable = new Map(definitions.map((definition, index) => [definition.table_id, schemas[index]!]));
  const allResults: OperationResultManifest[] = [];
  const provenance: PublicationCandidateResultRef[] = [];
  const confidence: PublicationCandidateResultRef[] = [];
  const audit: PublicationCandidateResultRef[] = [];
  const dataRefs: PublicationCandidateResultRef[] = [];

  const tables = definitions.map((definition) => {
    const outputs = input.tableOutputs[definition.table_id]!;
    const data = requireCoreResult({
      result: outputs.data,
      taskId: input.taskId,
      requirementId: input.requirementId,
      operationKind: "integrate",
      outputKind: "integrated_table",
    });
    const schema = schemaByTable.get(definition.table_id)!;
    const summary = parseTableSummary(data, definition.table_id);
    if (
      summary.table_id !== definition.table_id
      || summary.dataset_family !== spec.family_spec_id
      || summary.row_granularity !== projection.row_granularity
      || summary.schema_ref !== definition.schema_ref
    ) {
      throw new Error(`table '${definition.table_id}' result summary schema mismatch`);
    }
    if (summary.column_count !== schema.fields.length) {
      throw new Error(`table '${definition.table_id}' result column count does not match FamilySpec fields`);
    }
    if (summary.row_count === 0 && !projection.allow_empty.includes(definition.table_id)) {
      throw new Error(`table '${definition.table_id}' must not be empty in selected projection`);
    }
    const dataRef = exactDataRef(data, summary.primary_file_sha256);
    dataRefs.push(dataRef);

    const tableEvidence = (
      kind: "provenance" | "confidence" | "audit",
    ): PublicationCandidateResultRef[] => {
      const results = outputs[kind].map((result) => requireCoreResult({
        result,
        taskId: input.taskId,
        requirementId: input.requirementId,
      }));
      allResults.push(...results);
      return resultRefs({ results, taskId: input.taskId, requirementId: input.requirementId });
    };
    provenance.push(...tableEvidence("provenance"));
    confidence.push(...tableEvidence("confidence"));
    audit.push(...tableEvidence("audit"));
    allResults.push(data);
    return { definition, data_ref: dataRef, row_count: summary.row_count };
  });

  assertDisjointEvidence({ provenance, confidence, audit, data: dataRefs });
  const relationById = new Map(spec.relations.map((relation) => [relation.relation_id, relation]));
  const relations = projection.relations.map((relationId) => relationById.get(relationId)!);
  const candidateBody = {
    schema_version: "1.0" as const,
    task_id: input.taskId,
    requirement_id: input.requirementId,
    dataset_family: spec.family_spec_id,
    row_granularity: projection.row_granularity,
    tables,
    relations,
    provenance_refs: provenance,
    confidence_refs: confidence,
    audit_refs: audit,
    registered_asset_ids: assetClosure(allResults),
  };
  const candidate = parsePublicationCandidate({
    ...candidateBody,
    candidate_id: `candidate_${canonicalDigest(candidateBody).slice(0, 32)}`,
  });
  return {
    schema_profile: DYNAMIC_STRING_PRESERVING_PROFILE,
    schemas,
    candidate,
  };
}
