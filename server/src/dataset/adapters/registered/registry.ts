import type { DatasetSchemaV2 } from "@biomed/contracts";
import type { RegisteredTableParserDefinition } from "./types.js";

export interface RegisteredTableAdapterRegistration {
  schema: DatasetSchemaV2;
  parser: RegisteredTableParserDefinition;
}

function cloneSchema(schema: DatasetSchemaV2): DatasetSchemaV2 {
  return {
    ...schema,
    primary_key: [...schema.primary_key],
    fields: schema.fields.map((field) => ({ ...field })),
  };
}

function cloneParser(parser: RegisteredTableParserDefinition): RegisteredTableParserDefinition {
  return parser.format === "json"
    ? { ...parser, media_types: [...parser.media_types], limits: { ...parser.limits }, fields: parser.fields.map((field) => ({ ...field })) }
    : { ...parser, media_types: [...parser.media_types], limits: { ...parser.limits }, fields: parser.fields.map((field) => ({ ...field })) };
}

/**
 * Production code registers parser/schema pairs explicitly. There is no
 * dynamic import, eval, or Agent-provided parser code in this registry.
 */
export class RegisteredTableRegistry {
  private readonly registrations = new Map<string, RegisteredTableAdapterRegistration>();

  register(registration: RegisteredTableAdapterRegistration): void {
    const key = `${registration.parser.adapter_id}@${registration.parser.parser_version}`;
    if (registration.schema.schema_id !== registration.parser.schema_ref) {
      throw new Error("registered parser schema_ref must match its schema");
    }
    if (this.registrations.has(key)) throw new Error(`registered parser already exists: ${key}`);
    this.registrations.set(key, {
      schema: cloneSchema(registration.schema),
      parser: cloneParser(registration.parser),
    });
  }

  resolve(adapterId: string, parserVersion: string): RegisteredTableAdapterRegistration {
    const registration = this.registrations.get(`${adapterId}@${parserVersion}`);
    if (registration === undefined) {
      throw new Error(`unknown registered parser: ${adapterId}@${parserVersion}`);
    }
    return {
      schema: cloneSchema(registration.schema),
      parser: cloneParser(registration.parser),
    };
  }

  list(): string[] {
    return [...this.registrations.keys()].sort();
  }

  entries(): RegisteredTableAdapterRegistration[] {
    return this.list().map((key) => {
      const [adapterId, parserVersion] = key.split("@");
      return this.resolve(adapterId!, parserVersion!);
    });
  }
}
