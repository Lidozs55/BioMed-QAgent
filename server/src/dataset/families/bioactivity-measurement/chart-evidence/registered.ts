import { RegisteredTableRegistry } from "../../../adapters/registered/index.js";
import { chartEvidenceTables } from "./schemas.js";

const LIMITS = {
  max_bytes: 16 * 1024 * 1024,
  max_rows: 250_000,
  max_columns: 40,
  max_line_characters: 512 * 1024,
};

export function createChartEvidenceRegisteredTableRegistry(): RegisteredTableRegistry {
  const registry = new RegisteredTableRegistry();
  for (const entry of chartEvidenceTables) {
    registry.register({
      schema: entry.schema,
      parser: {
        adapter_id: `registered_bioactivity_${entry.definition.table_id}_json`,
        parser_version: "1_0_0",
        schema_ref: entry.schema.schema_id,
        format: "json",
        rows_pointer: `/${entry.definition.table_id}`,
        fields: entry.schema.fields.map((item) => ({
          source_pointer: `/${item.name}`,
          target_field: item.name,
        })),
        media_types: ["application/json"],
        limits: LIMITS,
      },
    });
  }
  return registry;
}
