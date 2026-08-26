import { RegisteredTableRegistry } from "../../adapters/registered/index.js";
import type { RegisteredTableAdapterRegistration } from "../../adapters/registered/index.js";
import { inheritedDiseaseEvidenceTables } from "./schema.js";

const LIMITS = {
  max_bytes: 256 * 1024 * 1024,
  max_rows: 2_000_000,
  max_columns: 64,
  max_line_characters: 2 * 1024 * 1024,
};

function jsonFields(names: readonly string[]): { source_pointer: string; target_field: string }[] {
  return names.map((name) => ({ source_pointer: `/${name}`, target_field: name }));
}

function registration(
  tableId: string,
  schema: (typeof inheritedDiseaseEvidenceTables)[number]["schema"],
): RegisteredTableAdapterRegistration {
  return {
    schema,
    parser: {
      adapter_id: `registered_inherited_disease_${tableId}_json`,
      parser_version: "1_0_0",
      schema_ref: schema.schema_id,
      format: "json",
      rows_pointer: `/${tableId}`,
      fields: jsonFields(schema.fields.map((field) => field.name)),
      media_types: ["application/json"],
      limits: LIMITS,
    },
  };
}

export const inheritedDiseaseEvidenceAdapterRegistrations: readonly RegisteredTableAdapterRegistration[] =
  Object.freeze(inheritedDiseaseEvidenceTables.map((entry) => registration(entry.tableId, entry.schema)));

export function createInheritedDiseaseEvidenceRegisteredTableRegistry(): RegisteredTableRegistry {
  const registry = new RegisteredTableRegistry();
  for (const entry of inheritedDiseaseEvidenceAdapterRegistrations) registry.register(entry);
  return registry;
}
