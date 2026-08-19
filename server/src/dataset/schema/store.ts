import type { DatasetSchema } from "../contracts/index.js";
import type { DatasetSchemaV2 } from "@biomed/contracts";

export function schemasDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, index) => schemasDeepEqual(item, b[index]));
  }
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord).sort();
  const bKeys = Object.keys(bRecord).sort();
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key, index) => {
    if (key !== bKeys[index]) return false;
    return schemasDeepEqual(aRecord[key], bRecord[key]);
  });
}

export class SchemaRegistry {
  private readonly schemas = new Map<string, DatasetSchema | DatasetSchemaV2>();

  constructor(initial: readonly (DatasetSchema | DatasetSchemaV2)[] = []) {
    for (const schema of initial) this.register(schema);
  }

  register(schema: DatasetSchema | DatasetSchemaV2): void {
    const existing = this.schemas.get(schema.schema_id);
    if (existing !== undefined && !schemasDeepEqual(existing, schema)) {
      throw new Error(`schema '${schema.schema_id}' already registered`);
    }
    this.schemas.set(schema.schema_id, schema);
  }

  contains(schemaId: string): boolean {
    return this.schemas.has(schemaId);
  }

  get(schemaId: string): DatasetSchema | DatasetSchemaV2 {
    const schema = this.schemas.get(schemaId);
    if (schema === undefined) {
      throw new Error(`schema '${schemaId}' is not registered`);
    }
    return schema;
  }

  list(): string[] {
    return [...this.schemas.keys()].sort();
  }
}
