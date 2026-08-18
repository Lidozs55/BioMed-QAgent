import { RegisteredTableRegistry } from "../../adapters/registered/index.js";
import { targetEvidenceSchemas } from "./schemas.js";

const LIMITS = {
  max_bytes: 8 * 1024 * 1024,
  max_rows: 100_000,
  max_columns: 32,
  max_line_characters: 128 * 1024,
};

function fields(names: readonly string[]): { source_column: string; target_field: string }[] {
  return names.map((name) => ({ source_column: name, target_field: name }));
}

export function createTargetEvidenceRegisteredTableRegistry(): RegisteredTableRegistry {
  const registry = new RegisteredTableRegistry();
  for (const schema of targetEvidenceSchemas) {
    const tableId = schema.schema_id.slice("target_evidence.".length, -".v1".length);
    registry.register({
      schema,
      parser: {
        adapter_id: `registered_target_evidence_${tableId}_csv`,
        parser_version: "1_0_0",
        schema_ref: schema.schema_id,
        format: "csv",
        fields: fields(schema.fields.map((field) => field.name)),
        media_types: ["text/csv"],
        limits: LIMITS,
      },
    });
  }
  return registry;
}
