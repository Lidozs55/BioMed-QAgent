import { RegisteredTableRegistry } from "../../adapters/registered/index.js";
import { buildProteinStructureTables } from "./schemas.js";

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

function columns(names: readonly string[]) {
  return names.map((name) => ({
    source_column: name,
    target_field: name,
  }));
}

export function createProteinStructureRegisteredTableRegistry(): RegisteredTableRegistry {
  const schemas = buildProteinStructureTables();
  const registry = new RegisteredTableRegistry();
  for (const registration of [
    {
      schema: schemas.structure,
      adapterId: "registered_protein_structure_json",
      rowsPointer: "/structures",
    },
    {
      schema: schemas.chain,
      adapterId: "registered_protein_structure_chain_json",
      rowsPointer: "/chains",
    },
    {
      schema: schemas.ligand,
      adapterId: "registered_protein_structure_ligand_json",
      rowsPointer: "/ligands",
    },
    {
      schema: schemas.source,
      adapterId: "registered_protein_structure_source_json",
      rowsPointer: "/sources",
    },
  ] as const) {
    registry.register({
      schema: registration.schema,
      parser: {
        adapter_id: registration.adapterId,
        parser_version: "1_0_0",
        schema_ref: registration.schema.schema_id,
        format: "json",
        rows_pointer: registration.rowsPointer,
        fields: fields(registration.schema.fields.map((item) => item.name)),
        media_types: ["application/json"],
        limits: LIMITS,
      },
    });
  }
  // XLSX variant for the structure table: PDB/literature summary spreadsheets are a
  // Core-owned promoted browser target, so the default browser recipe catalog can
  // bind the spreadsheet media type without any Agent-supplied parser.
  registry.register({
    schema: schemas.structure,
    parser: {
      adapter_id: "registered_protein_structure_xlsx",
      parser_version: "1_0_0",
      schema_ref: schemas.structure.schema_id,
      format: "xlsx",
      sheet_name: "Data",
      fields: columns(schemas.structure.fields.map((item) => item.name)),
      media_types: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      limits: LIMITS,
    },
  });
  return registry;
}
