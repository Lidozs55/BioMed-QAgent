import type { PublicationCandidate, TableDefinition } from "@biomed/contracts";

import { canonicalDigest } from "../adapters/identity.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const TABLE_ROLES = new Set<TableDefinition["role"]>(["primary", "supporting", "derived"]);

export interface CoreProductTableRequirement {
  readonly table_id: string;
  readonly role: TableDefinition["role"];
  readonly schema_ref: string;
  readonly min_rows: number;
}

export interface CoreProductTopologyRequirements {
  readonly schema_version: "1.0";
  readonly profile_ref: string;
  readonly dataset_family: string;
  readonly tables: readonly CoreProductTableRequirement[];
  readonly relations: readonly string[];
}

function safeId(value: unknown, name: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new TypeError(`${name} must be a safe identifier`);
  }
  return value;
}

export function parseCoreProductTopologyRequirements(
  value: unknown,
): CoreProductTopologyRequirements {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Core-owned product requirements must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.schema_version !== "1.0") {
    throw new TypeError("Core-owned product requirements must use schema_version 1.0");
  }
  if (!Array.isArray(record.tables) || record.tables.length === 0) {
    throw new TypeError("Core-owned product requirements must declare at least one table");
  }
  if (!Array.isArray(record.relations)) {
    throw new TypeError("Core-owned product requirements relations must be an array");
  }
  const tables = record.tables.map((value, index) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError(`Core-owned product requirements table ${index} must be an object`);
    }
    const table = value as Record<string, unknown>;
    const role = table.role;
    if (typeof role !== "string" || !TABLE_ROLES.has(role as TableDefinition["role"])) {
      throw new TypeError(`Core-owned product requirements table ${index} has an invalid role`);
    }
    if (!Number.isSafeInteger(table.min_rows) || (table.min_rows as number) < 0) {
      throw new TypeError(`Core-owned product requirements table ${index} has an invalid min_rows`);
    }
    return Object.freeze({
      table_id: safeId(table.table_id, `product requirements table ${index}.table_id`),
      role: role as TableDefinition["role"],
      schema_ref: safeId(table.schema_ref, `product requirements table ${index}.schema_ref`),
      min_rows: table.min_rows as number,
    });
  });
  const tableIds = tables.map((table) => table.table_id);
  if (new Set(tableIds).size !== tableIds.length) {
    throw new TypeError("Core-owned product requirements contain duplicate table IDs");
  }
  const relations = record.relations.map((value, index) =>
    safeId(value, `product requirements relation ${index}`));
  if (new Set(relations).size !== relations.length) {
    throw new TypeError("Core-owned product requirements contain duplicate relation IDs");
  }
  return Object.freeze({
    schema_version: "1.0",
    profile_ref: safeId(record.profile_ref, "product requirements profile_ref"),
    dataset_family: safeId(record.dataset_family, "product requirements dataset_family"),
    tables: Object.freeze(tables),
    relations: Object.freeze(relations),
  });
}

export function coreProductTopologyDigest(
  requirements: CoreProductTopologyRequirements,
): string {
  return canonicalDigest(parseCoreProductTopologyRequirements(requirements));
}

export function assertProductTopology(
  candidate: PublicationCandidate,
  value: CoreProductTopologyRequirements,
): void {
  const requirements = parseCoreProductTopologyRequirements(value);
  if (candidate.dataset_family !== requirements.dataset_family) {
    throw new Error(
      `dynamic product family '${candidate.dataset_family}' does not match Core profile '${requirements.dataset_family}'`,
    );
  }
  const tables = new Map(candidate.tables.map((table) => [table.definition.table_id, table]));
  for (const required of requirements.tables) {
    const table = tables.get(required.table_id);
    if (table === undefined) {
      throw new Error(`dynamic product is missing required table '${required.table_id}'`);
    }
    if (table.definition.role !== required.role) {
      throw new Error(`dynamic product table '${required.table_id}' has the wrong role`);
    }
    if (table.definition.schema_ref !== required.schema_ref) {
      throw new Error(`dynamic product table '${required.table_id}' has the wrong schema`);
    }
    if (table.row_count < required.min_rows) {
      throw new Error(`dynamic product table '${required.table_id}' has fewer than ${required.min_rows} required rows`);
    }
  }
  if (candidate.tables.length !== requirements.tables.length) {
    throw new Error("dynamic product table closure does not exactly match its Core profile");
  }
  const relationIds = new Set(candidate.relations.map((relation) => relation.relation_id));
  for (const relationId of requirements.relations) {
    if (!relationIds.has(relationId)) {
      throw new Error(`dynamic product is missing required relation '${relationId}'`);
    }
  }
  if (candidate.relations.length !== requirements.relations.length) {
    throw new Error("dynamic product relation closure does not exactly match its Core profile");
  }
}
