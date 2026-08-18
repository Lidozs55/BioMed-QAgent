import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import type {
  DatasetSchemaV2,
  OperationResultManifest,
  RelationDefinition,
  SchemaFieldV2,
} from "@biomed/contracts";

import { delimitedRowsFromFileAsync } from "../adapters/text.js";
import type {
  MultiTableValidationCheck,
  MultiTableValidationRequest,
  MultiTableValidationResult,
  MultiTableValidationTable,
  ResolvedRelationMissingPolicy,
  TokenPreservationRule,
} from "../contracts/validation.js";
import { parseOperationResultManifest } from "../contracts/operation-result.js";
import { parsePublicationCandidateRef, parseRelationDefinition, parseTableDefinition } from "../contracts/multitable.js";
import { parseDatasetSchemaV2 } from "../contracts/schema.js";
import { assertRelativePath } from "../contracts/primitives.js";
import { checkpoint, CHECKPOINT_STRIDE, throwIfAborted } from "../cooperative.js";

interface TableScan {
  rowCount: number;
  keyCounts: Map<string, Map<string, number>>;
}

const SUPPORTED_DATA_TYPES = new Set([
  "string",
  "integer",
  "float",
  "number",
  "boolean",
  "date",
  "datetime",
  "json",
]);

function check(
  checks: MultiTableValidationCheck[],
  checkId: string,
  scope: string,
  passed: boolean,
  detail: string,
): void {
  checks.push({ check_id: checkId, scope, passed, detail });
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function canonicalRoot(root: string): Promise<string> {
  return path.normalize(await realpath(path.resolve(root)));
}

async function sha256File(filePath: string, signal?: AbortSignal | null): Promise<string> {
  throwIfAborted(signal);
  const hasher = createHash("sha256");
  const source = createReadStream(filePath);
  try {
    for await (const chunk of source) {
      throwIfAborted(signal);
      hasher.update(chunk as Buffer);
    }
    return hasher.digest("hex");
  } finally {
    source.destroy();
  }
}

function operationAllowsTable(result: OperationResultManifest): boolean {
  const allowed =
    (result.operation_kind === "parse" && result.output_kind === "parsed_table") ||
    (result.operation_kind === "canonicalize" && result.output_kind === "canonical_table") ||
    (result.operation_kind === "integrate" && result.output_kind === "integrated_table") ||
    (result.operation_kind === "assemble" && result.output_kind === "publication_candidate") ||
    (result.operation_kind === "derive" && result.output_kind === "derived_evidence");
  return allowed && result.status === "succeeded" && result.migration.mode === "native";
}

async function resolveTrustedTablePath(
  request: MultiTableValidationRequest,
  table: MultiTableValidationTable,
  trustedRoot: string,
  forbiddenRoots: readonly string[],
  signal?: AbortSignal | null,
): Promise<{ path: string; size: number; sha256: string }> {
  const file = table.file;
  if (file === null) throw new Error("table has no file reference");
  if (file.origin !== "core_operation_result") {
    throw new Error("only Core operation result files are accepted");
  }
  const result = parseOperationResultManifest(
    file.operation_result,
    request.task_id,
    request.build_id,
  );
  if (!operationAllowsTable(result)) {
    throw new Error("table file is not from a successful native Core table operation");
  }
  const relativePath = assertRelativePath(file.relative_path, "TrustedTableFileInput.relative_path");
  const receipts = result.output_files.filter((entry) => entry.relative_path === relativePath);
  if (receipts.length !== 1) {
    throw new Error("table file must have exactly one operation result receipt");
  }
  const lexicalPath = path.resolve(trustedRoot, ...relativePath.split("/"));
  if (!isWithin(trustedRoot, lexicalPath)) throw new Error("table file escapes the trusted root");
  const actualPath = path.normalize(await realpath(lexicalPath));
  if (!isWithin(trustedRoot, actualPath)) throw new Error("table file resolves outside the trusted root");
  if (forbiddenRoots.some((root) => isWithin(root, actualPath))) {
    throw new Error("Agent workspace and forbidden roots are not trusted table inputs");
  }
  const fileStat = await stat(actualPath);
  if (!fileStat.isFile()) throw new Error("table input is not a regular file");
  const receipt = receipts[0];
  if (fileStat.size !== receipt.size_bytes) throw new Error("table size does not match its Core receipt");
  const digest = await sha256File(actualPath, signal);
  if (digest !== receipt.sha256.toLowerCase()) throw new Error("table hash does not match its Core receipt");
  return { path: actualPath, size: fileStat.size, sha256: digest };
}

function fieldsKey(fields: readonly string[]): string {
  return fields.join("\u001f");
}

function tupleKey(values: readonly string[]): string {
  return JSON.stringify(values);
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function validDateTime(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
}

function matchesType(value: string, field: SchemaFieldV2): boolean {
  switch (field.data_type) {
    case "string": return true;
    case "integer": return /^[+-]?\d+$/.test(value) && Number.isSafeInteger(Number(value));
    case "float":
    case "number": return value.trim() !== "" && Number.isFinite(Number(value));
    case "boolean": return value === "true" || value === "false";
    case "date": return validDate(value);
    case "datetime": return validDateTime(value);
    case "json": {
      try {
        JSON.parse(value);
        return true;
      } catch {
        return false;
      }
    }
    default: return false;
  }
}

function relationCombos(
  tableId: string,
  schema: DatasetSchemaV2,
  relations: readonly RelationDefinition[],
): string[][] {
  const combinations = [schema.primary_key];
  for (const relation of relations) {
    if (relation.from_table_id === tableId) combinations.push(relation.from_fields);
    if (relation.to_table_id === tableId) combinations.push(relation.to_fields);
  }
  const unique = new Map(combinations.map((fields) => [fieldsKey(fields), [...fields]]));
  return [...unique.values()];
}

function tableTokenRules(
  tableId: string,
  rules: readonly TokenPreservationRule[],
): TokenPreservationRule[] {
  return rules.filter((rule) => rule.table_id === tableId);
}

async function scanTable(
  table: MultiTableValidationTable,
  filePath: string,
  request: MultiTableValidationRequest,
  checks: MultiTableValidationCheck[],
  signal?: AbortSignal | null,
): Promise<TableScan> {
  const tableId = table.definition.table_id;
  const expectedHeader = table.definition.field_names;
  const declaredFields = new Set(expectedHeader);
  const scannedFields = table.schema.fields.filter((field) => declaredFields.has(field.name));
  const combinations = relationCombos(tableId, table.schema, request.relations);
  const keyCounts = new Map(combinations.map((fields) => [fieldsKey(fields), new Map<string, number>()]));
  const tokenRules = tableTokenRules(tableId, request.policy.token_preservation_rules);
  let header: string[] | null = null;
  let rowCount = 0;
  let malformedWidth = 0;
  let nullabilityFailures = 0;
  let typeFailures = 0;
  let tokenFailures = 0;
  let primaryKeyNulls = 0;
  let unsupportedType: string | null = null;

  for (const field of scannedFields) {
    if (!SUPPORTED_DATA_TYPES.has(field.data_type)) {
      unsupportedType ??= `${field.name}:${field.data_type}`;
    }
  }

  for await (const row of delimitedRowsFromFileAsync(filePath, table.file?.delimiter ?? ",", signal)) {
    if (header === null) {
      header = row.values;
      continue;
    }
    if (row.values.length === 0) continue;
    rowCount += 1;
    if (row.values.length !== expectedHeader.length) {
      malformedWidth += 1;
      continue;
    }
    const values = new Map(expectedHeader.map((name, index) => [name, row.values[index] ?? ""]));
    for (const field of scannedFields) {
      const value = values.get(field.name) ?? "";
      if (value === "") {
        if (!field.nullable) nullabilityFailures += 1;
      } else if (!matchesType(value, field)) {
        typeFailures += 1;
      }
    }
    const primaryValues = table.schema.primary_key.map((field) => values.get(field) ?? "");
    if (primaryValues.some((value) => value === "")) primaryKeyNulls += 1;
    for (const fields of combinations) {
      const valuesForKey = fields.map((field) => values.get(field) ?? "");
      const counts = keyCounts.get(fieldsKey(fields));
      const encoded = tupleKey(valuesForKey);
      counts?.set(encoded, (counts.get(encoded) ?? 0) + 1);
    }
    for (const rule of tokenRules) {
      if ((values.get(rule.source_field) ?? "") !== (values.get(rule.output_field) ?? "")) {
        tokenFailures += 1;
      }
    }
    if (rowCount % CHECKPOINT_STRIDE === 0) await checkpoint(signal);
  }

  check(checks, "header_order", tableId, sameStrings(header ?? [], expectedHeader),
    `actual=${JSON.stringify(header ?? [])}; expected=${JSON.stringify(expectedHeader)}`);
  check(checks, "row_width", tableId, malformedWidth === 0,
    `${malformedWidth} malformed row(s) in ${rowCount} data row(s)`);
  check(checks, "data_type", tableId, unsupportedType === null && typeFailures === 0,
    unsupportedType === null ? `${typeFailures} invalid typed value(s)` : `unsupported schema data type ${unsupportedType}`);
  check(checks, "nullability", tableId, nullabilityFailures === 0,
    `${nullabilityFailures} null value(s) in non-nullable fields`);
  const emptyAllowed = table.definition.role !== "primary" && table.definition.allow_empty;
  check(checks, "required_allow_empty", tableId, rowCount > 0 || emptyAllowed,
    `rows=${rowCount}; role=${table.definition.role}; required=${table.definition.required}; allow_empty=${table.definition.allow_empty}`);
  const pkCounts = keyCounts.get(fieldsKey(table.schema.primary_key)) ?? new Map();
  const duplicatePrimaryKeys = [...pkCounts.values()].filter((count) => count > 1).length;
  check(checks, "primary_key_uniqueness", tableId, duplicatePrimaryKeys === 0 && primaryKeyNulls === 0,
    `${duplicatePrimaryKeys} duplicate primary key value(s); null_or_blank=${primaryKeyNulls}`);
  check(checks, "token_preservation", tableId, tokenFailures === 0,
    `${tokenFailures} relation/unit token mismatch(es) across ${tokenRules.length} rule(s)`);
  return { rowCount, keyCounts };
}

function countDuplicates(counts: ReadonlyMap<string, number>): number {
  return [...counts.values()].filter((count) => count > 1).length;
}

function relationPolicy(
  request: MultiTableValidationRequest,
  relation: RelationDefinition,
): ResolvedRelationMissingPolicy | null {
  if (relation.missing_policy !== "profile_defined") return relation.missing_policy;
  return request.policy.profile_relation_missing_policies[relation.relation_id] ?? null;
}

function validateRelation(
  request: MultiTableValidationRequest,
  relation: RelationDefinition,
  scans: ReadonlyMap<string, TableScan>,
  checks: MultiTableValidationCheck[],
): void {
  const from = scans.get(relation.from_table_id);
  const to = scans.get(relation.to_table_id);
  if (from === undefined || to === undefined) {
    check(checks, "foreign_key", relation.relation_id, false, "relation table is absent or untrusted");
    check(checks, "cardinality", relation.relation_id, false, "relation table is absent or untrusted");
    return;
  }
  const fromCounts = from.keyCounts.get(fieldsKey(relation.from_fields)) ?? new Map();
  const toCounts = to.keyCounts.get(fieldsKey(relation.to_fields)) ?? new Map();
  const policy = relationPolicy(request, relation);
  const dependentCounts = relation.cardinality === "one_to_many" ? toCounts : fromCounts;
  const referencedCounts = relation.cardinality === "one_to_many" ? fromCounts : toCounts;
  let missing = 0;
  for (const [key, count] of dependentCounts) {
    if (!referencedCounts.has(key)) missing += count;
  }
  const referencedEmpty = relation.cardinality === "one_to_many" ? from.rowCount === 0 : to.rowCount === 0;
  const missingAllowed = policy === "allow_missing" || (policy === "allow_empty" && referencedEmpty);
  check(checks, "foreign_key", relation.relation_id,
    policy !== null && (missing === 0 || missingAllowed),
    `missing=${missing}; policy=${policy ?? "unresolved_profile_defined"}`);
  const fromDuplicates = countDuplicates(fromCounts);
  const toDuplicates = countDuplicates(toCounts);
  const passed =
    (relation.cardinality === "one_to_one" && fromDuplicates === 0 && toDuplicates === 0) ||
    (relation.cardinality === "one_to_many" && fromDuplicates === 0) ||
    (relation.cardinality === "many_to_one" && toDuplicates === 0) ||
    relation.cardinality === "many_to_many";
  check(checks, "cardinality", relation.relation_id, passed,
    `cardinality=${relation.cardinality}; from_duplicate_keys=${fromDuplicates}; to_duplicate_keys=${toDuplicates}`);
}

function validateDefinitions(
  request: MultiTableValidationRequest,
  checks: MultiTableValidationCheck[],
): boolean {
  const tableIds = request.tables.map((table) => table.definition.table_id);
  const relationIds = request.relations.map((relation) => relation.relation_id);
  const uniqueTables = new Set(tableIds).size === tableIds.length;
  const uniqueRelations = new Set(relationIds).size === relationIds.length;
  const candidateTables = sameStrings([...request.candidate.table_ids].sort(), [...tableIds].sort());
  const candidateRelations = sameStrings([...request.candidate.relation_ids].sort(), [...relationIds].sort());
  check(checks, "candidate_references", request.candidate.candidate_id,
    uniqueTables && uniqueRelations && candidateTables && candidateRelations,
    "candidate must reference every validation table/relation exactly once");

  let valid = uniqueTables && uniqueRelations && candidateTables && candidateRelations;
  const tableMap = new Map(request.tables.map((table) => [table.definition.table_id, table]));
  for (const table of request.tables) {
    const definition = table.definition;
    const schema = table.schema;
    const schemaFields = schema.fields.map((field) => field.name);
    const declaredFieldSet = new Set(definition.field_names);
    const orderedDeclaredFields = schemaFields.filter((field) => declaredFieldSet.has(field));
    const requiredFields = schema.fields
      .filter((field) => field.required)
      .map((field) => field.name);
    const schemaMatches = definition.schema_ref === schema.schema_id &&
      sameStrings(definition.field_names, orderedDeclaredFields) &&
      definition.field_names.every((field) => schemaFields.includes(field)) &&
      requiredFields.every((field) => declaredFieldSet.has(field)) &&
      sameStrings(definition.primary_key, schema.primary_key) &&
      schema.primary_key.every((field) => declaredFieldSet.has(field));
    check(checks, "table_schema_contract", definition.table_id, schemaMatches,
      "table fields must preserve schema order and include every required/primary-key field");
    const provenanceClosed = table.provenance_refs.length > 0 &&
      table.provenance_refs.every((ref) => request.candidate.provenance_refs.includes(ref));
    const confidenceClosed = table.confidence_refs.length > 0 &&
      table.confidence_refs.every((ref) => request.candidate.confidence_refs.includes(ref));
    check(checks, "table_provenance_refs", definition.table_id, provenanceClosed,
      `${table.provenance_refs.length} table provenance ref(s)`);
    check(checks, "table_confidence_refs", definition.table_id, confidenceClosed,
      `${table.confidence_refs.length} table confidence ref(s)`);
    if (!schemaMatches || !provenanceClosed || !confidenceClosed) valid = false;
  }
  const tableProvenanceRefs = request.tables.flatMap((table) => table.provenance_refs);
  const tableConfidenceRefs = request.tables.flatMap((table) => table.confidence_refs);
  const exactEvidenceRefs =
    new Set(tableProvenanceRefs).size === tableProvenanceRefs.length &&
    new Set(tableConfidenceRefs).size === tableConfidenceRefs.length &&
    sameStrings([...tableProvenanceRefs].sort(), [...request.candidate.provenance_refs].sort()) &&
    sameStrings([...tableConfidenceRefs].sort(), [...request.candidate.confidence_refs].sort());
  check(checks, "candidate_evidence_closure", request.candidate.candidate_id, exactEvidenceRefs,
    "candidate provenance/confidence refs must equal the disjoint per-table ref sets");
  if (!exactEvidenceRefs) valid = false;

  for (const relation of request.relations) {
    const from = tableMap.get(relation.from_table_id);
    const to = tableMap.get(relation.to_table_id);
    const relationValid = from !== undefined && to !== undefined &&
      relation.from_fields.length > 0 &&
      relation.from_fields.length === relation.to_fields.length &&
      relation.from_fields.every((field) => from.definition.field_names.includes(field)) &&
      relation.to_fields.every((field) => to.definition.field_names.includes(field));
    check(checks, "relation_contract", relation.relation_id, relationValid,
      "relation endpoints and equal-arity fields must reference declared tables");
    if (!relationValid) valid = false;
  }
  for (const rule of request.policy.token_preservation_rules) {
    const table = tableMap.get(rule.table_id);
    const sourceField = table?.schema.fields.find((field) => field.name === rule.source_field);
    const outputField = table?.schema.fields.find((field) => field.name === rule.output_field);
    const roleFragment = rule.token_kind === "relation" ? "relation" : "unit";
    const ruleValid = table !== undefined &&
      table.definition.field_names.includes(rule.source_field) &&
      table.definition.field_names.includes(rule.output_field) &&
      sourceField?.semantic_role.includes(roleFragment) === true &&
      outputField?.semantic_role.includes(roleFragment) === true;
    check(checks, "token_preservation_rule", `${rule.table_id}:${rule.token_kind}`, ruleValid,
      `${rule.source_field} -> ${rule.output_field}`);
    if (!ruleValid) valid = false;
  }
  for (const table of request.tables) {
    const protectedFields = table.schema.fields
      .filter((field) =>
        field.semantic_role.includes("relation") ||
        field.semantic_role.includes("unit") ||
        field.unit_policy === "preserve_original",
      )
      .map((field) => field.name)
      .filter((field) => table.definition.field_names.includes(field));
    const coveredFields = new Set(
      tableTokenRules(table.definition.table_id, request.policy.token_preservation_rules)
        .flatMap((rule) => [rule.source_field, rule.output_field]),
    );
    const uncovered = protectedFields.filter((field) => !coveredFields.has(field));
    check(checks, "token_policy_coverage", table.definition.table_id, uncovered.length === 0,
      uncovered.length === 0 ? `${protectedFields.length} protected token field(s)` : `uncovered=${uncovered.join(",")}`);
    if (uncovered.length > 0) valid = false;
  }
  return valid;
}

export async function validateMultiTableCandidate(
  request: MultiTableValidationRequest,
  signal?: AbortSignal | null,
): Promise<MultiTableValidationResult> {
  throwIfAborted(signal);
  const checks: MultiTableValidationCheck[] = [];
  try {
    parsePublicationCandidateRef(request.candidate);
    for (const table of request.tables) {
      parseTableDefinition(table.definition);
      parseDatasetSchemaV2(table.schema);
    }
    request.relations.forEach(parseRelationDefinition);
  } catch (error) {
    check(checks, "contract_parse", request.candidate.candidate_id, false,
      error instanceof Error ? error.message : String(error));
    return { passed: false, checks };
  }
  if (!validateDefinitions(request, checks)) return { passed: false, checks };

  let trustedRoot: string;
  let forbiddenRoots: string[];
  try {
    trustedRoot = await canonicalRoot(request.trusted_root);
    if (request.forbidden_roots.length === 0) {
      throw new Error("at least one Agent workspace or forbidden root is required");
    }
    forbiddenRoots = await Promise.all(request.forbidden_roots.map(canonicalRoot));
    if (forbiddenRoots.some((root) => isWithin(root, trustedRoot))) {
      throw new Error("trusted root is inside an Agent workspace or forbidden root");
    }
    check(checks, "trusted_root", request.candidate.candidate_id, true, trustedRoot);
  } catch (error) {
    check(checks, "trusted_root", request.candidate.candidate_id, false,
      error instanceof Error ? error.message : String(error));
    return { passed: false, checks };
  }

  const scans = new Map<string, TableScan>();
  for (const table of request.tables) {
    const tableId = table.definition.table_id;
    if (table.file === null) {
      const allowed = !table.definition.required;
      check(checks, "trusted_table_input", tableId, allowed,
        allowed ? "optional table is absent" : "required table has no Core file reference");
      if (!allowed) continue;
      scans.set(tableId, { rowCount: 0, keyCounts: new Map() });
      continue;
    }
    try {
      const resolved = await resolveTrustedTablePath(
        request, table, trustedRoot, forbiddenRoots, signal,
      );
      check(checks, "trusted_table_input", tableId, true,
        `${table.file.relative_path}; size=${resolved.size}; sha256=${resolved.sha256}`);
      scans.set(tableId, await scanTable(table, resolved.path, request, checks, signal));
    } catch (error) {
      check(checks, "trusted_table_input", tableId, false,
        error instanceof Error ? error.message : String(error));
    }
  }
  for (const relation of request.relations) validateRelation(request, relation, scans, checks);
  return { passed: checks.every((item) => item.passed), checks };
}
