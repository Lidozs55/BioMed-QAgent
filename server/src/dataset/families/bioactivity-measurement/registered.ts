import { RegisteredTableRegistry } from "../../adapters/registered/index.js";
import { bioactivityTableEntries } from "./schemas.js";

const LIMITS = {
  max_bytes: 16 * 1024 * 1024,
  max_rows: 250_000,
  max_columns: 32,
  max_line_characters: 256 * 1024,
};

function fields(names: readonly string[]) {
  return names.map((name) => ({
    source_pointer: `/${name}`,
    target_field: name,
  }));
}

export function createBioactivityRegisteredTableRegistry(): RegisteredTableRegistry {
  const registry = new RegisteredTableRegistry();
  for (const entry of bioactivityTableEntries()) {
    registry.register({
      schema: entry.schema,
      parser: {
        adapter_id: `registered_bioactivity_${entry.tableId}_json`,
        parser_version: "1_0_0",
        schema_ref: entry.schema.schema_id,
        format: "json",
        rows_pointer: `/${entry.tableId}`,
        fields: fields(entry.schema.fields.map((item) => item.name)),
        media_types: ["application/json"],
        limits: LIMITS,
      },
    });
  }
  return registry;
}
