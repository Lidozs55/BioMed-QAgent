import type { DeclarativeSkillManifest } from "@/hooks/useAPI";

/* ------------------------------------------------------------------ */
/*  Database draft state                                                */
/* ------------------------------------------------------------------ */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export function parseHttpMethod(raw: string): HttpMethod {
  const upper = raw.trim().toUpperCase();
  switch (upper) {
    case "GET": case "POST": case "PUT": case "PATCH": case "DELETE": case "HEAD": case "OPTIONS":
      return upper;
    default:
      return "GET";
  }
}

/** Check if raw string represents a valid HTTP method without coercion. */
export function isValidHttpMethod(raw: string): boolean {
  const upper = raw.trim().toUpperCase();
  return upper === "GET" || upper === "POST" || upper === "PUT" || upper === "PATCH"
    || upper === "DELETE" || upper === "HEAD" || upper === "OPTIONS";
}

export function parseJsonTemplate(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      // Copy known string keys without assertion
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(parsed)) {
        result[key] = Reflect.get(parsed, key);
      }
      return result;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Parse a validated JSON body string. Caller must validate first with validateJsonBody;
 * this assumes the input is syntactically valid JSON. Returns undefined for blank
 * (validated state: blank is rejected by validateJsonBody).
 */
export function parseJsonBody(raw: string): unknown {
  const t = raw.trim();
  if (!t) return undefined;
  return JSON.parse(t);
}

export interface DatabaseDraft {
  name: string;
  displayName: string;
  description: string;
  url: string;
  operation: string;
  /** Raw string draft — parsed to HttpMethod at save boundary via parseHttpMethod. */
  method: string;
  query: string;
  headers: string;
  body: string;
}

export const EMPTY_DATABASE: DatabaseDraft = {
  name: "",
  displayName: "",
  description: "",
  url: "",
  operation: "search",
  method: "GET",
  query: "{}",
  headers: "{}",
  body: "null",
};

/* ------------------------------------------------------------------ */
/*  Database validation (adjacent field errors)                        */
/* ------------------------------------------------------------------ */

export interface DatabaseValidation {
  method: string | null;  // null = valid, string = error message
  query: string | null;
  headers: string | null;
  body: string | null;
}

function validateJsonObject(raw: string): string | null {
  if (!raw.trim()) return "Required — enter a JSON object";
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return "Must be a JSON object, not an array or primitive";
    }
    return null;
  } catch {
    return "Invalid JSON syntax";
  }
}

function validateJsonBody(raw: string): string | null {
  if (!raw.trim()) return "Body is required — enter valid JSON or \"null\" for empty body";
  try {
    JSON.parse(raw);
    return null;
  } catch {
    return "Invalid JSON syntax";
  }
}

/** Validate a database draft for adjacent field-level errors. */
export function validateDatabaseDraft(draft: DatabaseDraft): DatabaseValidation {
  const method = draft.method.trim();
  return {
    method: !method ? "HTTP method is required"
      : isValidHttpMethod(draft.method) ? null
      : `Invalid method "${method}". Use GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS`,
    query: validateJsonObject(draft.query),
    headers: validateJsonObject(draft.headers),
    body: validateJsonBody(draft.body),
  };
}

/** True when at least one database field has a validation error. */
export function hasDatabaseErrors(v: DatabaseValidation): boolean {
  return v.method !== null || v.query !== null || v.headers !== null || v.body !== null;
}

export function databaseManifest(
  draft: DatabaseDraft,
  version = "1.0.0",
): DeclarativeSkillManifest {
  return {
    schema_version: "1.0",
    name: draft.name,
    display_name: draft.displayName,
    version,
    category: "discovery",
    description: draft.description,
    supported_sources: [draft.name],
    user_selectable: true,
    pipeline_supported: false,
    enabled: true,
    requirements: [],
    operations: [
      {
        name: draft.operation,
        description: `Search ${draft.displayName}`,
        method: parseHttpMethod(draft.method),
        url: draft.url,
        query: parseJsonTemplate(draft.query),
        headers: parseJsonTemplate(draft.headers),
        body: parseJsonBody(draft.body),
        timeout_seconds: 30,
        extract: null,
        auth: null,
      },
    ],
  };
}
