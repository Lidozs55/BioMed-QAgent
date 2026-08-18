import { RegisteredTableRegistry } from "../../adapters/registered/index.js";
import { buildVariantEvidenceTables } from "./schema.js";

const LIMITS = {
  max_bytes: 8 * 1024 * 1024,
  max_rows: 100_000,
  max_columns: 32,
  max_line_characters: 128 * 1024,
};

function fields(
  names: readonly string[],
): { source_pointer: string; target_field: string }[] {
  return names.map((name) => ({ source_pointer: `/${name}`, target_field: name }));
}

export function createVariantEvidenceRegisteredTableRegistry(): RegisteredTableRegistry {
  const schemas = buildVariantEvidenceTables();
  const registry = new RegisteredTableRegistry();
  registry.register({
    schema: schemas.variant,
    parser: {
      adapter_id: "registered_variant_assertion_json",
      parser_version: "1_0_0",
      schema_ref: schemas.variant.schema_id,
      format: "json",
      rows_pointer: "/assertions",
      fields: fields(schemas.variant.fields.map((item) => item.name)),
      media_types: ["application/json"],
      limits: LIMITS,
    },
  });
  registry.register({
    schema: schemas.evidence,
    parser: {
      adapter_id: "registered_variant_evidence_json",
      parser_version: "1_0_0",
      schema_ref: schemas.evidence.schema_id,
      format: "json",
      rows_pointer: "/evidence",
      fields: fields(schemas.evidence.fields.map((item) => item.name)),
      media_types: ["application/json"],
      limits: LIMITS,
    },
  });
  registry.register({
    schema: schemas.source,
    parser: {
      adapter_id: "registered_variant_source_json",
      parser_version: "1_0_0",
      schema_ref: schemas.source.schema_id,
      format: "json",
      rows_pointer: "/sources",
      fields: fields(schemas.source.fields.map((item) => item.name)),
      media_types: ["application/json"],
      limits: LIMITS,
    },
  });
  return registry;
}
