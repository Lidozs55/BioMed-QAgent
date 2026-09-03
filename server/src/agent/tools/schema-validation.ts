/**
 * Minimal JSON-Schema argument validation for agent tools.
 *
 * The tool catalog uses a small, closed subset of JSON-Schema keywords
 * (``type`` / ``properties`` / ``required`` / ``additionalProperties`` /
 * ``enum`` / ``items`` / ``anyOf`` plus a few numeric/string constraints).
 * Instead of pulling in a full validator dependency, this module checks that
 * subset and produces FastAPI-style field-level issues so the agent can see
 * *which* argument was wrong and *what* it sent.
 */

export interface SchemaIssue {
  /** Path to the offending value (FastAPI ``loc``): ``["field", 0, "sub"]``. */
  loc: Array<string | number>;
  msg: string;
  type: string;
  /** Echo of the offending input (bounded string form). */
  input?: string;
}

export class ArgumentValidationError extends Error {
  readonly code = "invalid_arguments";
  readonly retryable = false;
  readonly detail: readonly SchemaIssue[];

  constructor(detail: readonly SchemaIssue[]) {
    super(formatIssues(detail));
    this.name = "ArgumentValidationError";
    this.detail = detail;
  }
}

/** Human-readable one-line summary used as the `error` message. */
export function formatIssues(detail: readonly SchemaIssue[]): string {
  return detail
    .map((issue) => `${issue.loc.length > 0 ? issue.loc.join(".") : "(root)"}: ${issue.msg}`)
    .join("; ");
}

function boundedInput(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

function issue(
  loc: Array<string | number>,
  msg: string,
  type: string,
  input?: unknown,
): SchemaIssue {
  return input === undefined ? { loc, msg, type } : { loc, msg, type, input: boundedInput(input) };
}

type Schema = Record<string, unknown>;

function isSchema(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function typeMatches(value: unknown, expected: string): boolean {
  switch (expected) {
    case "object": return isSchema(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "boolean": return typeof value === "boolean";
    case "number": return typeof value === "number";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "null": return value === null;
    default: return true;
  }
}

/** Validate `value` against the subset schema, collecting all issues. */
export function collectSchemaIssues(value: unknown, schema: Schema, loc: Array<string | number> = []): SchemaIssue[] {
  const issues: SchemaIssue[] = [];

  const type = schema.type;
  if (typeof type === "string" && !typeMatches(value, type)) {
    return [issue(loc, `Input should be a valid ${type}, received ${typeName(value)}`, `${type}_type`, value)];
  }

  const anyOf = schema.anyOf;
  if (Array.isArray(anyOf)) {
    const branches = anyOf.filter(isSchema);
    if (branches.length > 0 && !branches.some((branch) => collectSchemaIssues(value, branch, loc).length === 0)) {
      return [issue(loc, "Input does not match any allowed variant", "anyOf", value)];
    }
  }

  const expectedType = typeof type === "string" ? type : typeName(value);
  if (expectedType === "string" && typeof value === "string") {
    const minLength = schema.minLength;
    if (typeof minLength === "number" && value.length < minLength) {
      issues.push(issue(loc, `String should have at least ${minLength} characters`, "string_too_short", value));
    }
    const pattern = schema.pattern;
    if (typeof pattern === "string" && !new RegExp(pattern).test(value)) {
      issues.push(issue(loc, `String should match pattern '${pattern}'`, "string_pattern_mismatch", value));
    }
  }
  if ((expectedType === "number" || expectedType === "integer") && typeof value === "number") {
    const minimum = schema.minimum;
    if (typeof minimum === "number" && value < minimum) {
      issues.push(issue(loc, `Input should be greater than or equal to ${minimum}`, "greater_than_equal", value));
    }
  }

  const enumValues = schema.enum;
  if (Array.isArray(enumValues)) {
    const allowed = enumValues.map((candidate) => JSON.stringify(candidate)).join(" | ");
    if (!enumValues.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) {
      issues.push(issue(loc, `Input should be one of: ${allowed}`, "enum", value));
    }
  }

  if (Array.isArray(value)) {
    const minItems = schema.minItems;
    if (typeof minItems === "number" && value.length < minItems) {
      issues.push(issue(loc, `Array should have at least ${minItems} items`, "too_short", value));
    }
    const items = schema.items;
    if (isSchema(items)) {
      value.forEach((element, index) => {
        issues.push(...collectSchemaIssues(element, items, [...loc, index]));
      });
    }
  }

  if (isSchema(value) && (isSchema(schema.properties) || schema.required !== undefined)) {
    const properties = isSchema(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const field of schema.required) {
        if (typeof field === "string" && value[field] === undefined) {
          issues.push(issue([...loc, field], "Field required", "missing"));
        }
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          issues.push(
            issue(
              [...loc, key],
              `Extra inputs are not permitted; allowed fields: ${Object.keys(properties).join(", ")}`,
              "extra_forbidden",
              value[key],
            ),
          );
        }
      }
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (value[key] !== undefined && isSchema(propertySchema)) {
        issues.push(...collectSchemaIssues(value[key], propertySchema, [...loc, key]));
      }
    }
  }

  return issues;
}

/**
 * Validate tool arguments against the tool's parameter schema. Throws
 * {@link ArgumentValidationError} carrying FastAPI-style `detail` issues when
 * invalid; returns silently when the arguments conform.
 */
export function validateToolArgumentsOrThrow(
  argumentsValue: unknown,
  schema: object,
): void {
  const issues = collectSchemaIssues(argumentsValue, isSchema(schema) ? schema : {});
  if (issues.length > 0) {
    throw new ArgumentValidationError(issues.slice(0, 20));
  }
}
