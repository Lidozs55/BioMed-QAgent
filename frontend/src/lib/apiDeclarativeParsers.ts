/* ------------------------------------------------------------------ */
/*  Declarative manifest validators — extracted from apiEnvelopeParsers */
/* ------------------------------------------------------------------ */

import { APIError } from "@/api/errors";
import type { DeclarativeSkillManifest } from "@biomed/contracts";
import {
  assertString, assertBoolean, assertNumber, assertObject, assertArray,
  assertJsonRecord, assertJsonValue,
} from "@biomed/contracts";

export function assertHttpMethod(v: unknown, path: string): "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" {
  if (v === "GET") return "GET";
  if (v === "POST") return "POST";
  if (v === "PUT") return "PUT";
  if (v === "PATCH") return "PATCH";
  if (v === "DELETE") return "DELETE";
  if (v === "HEAD") return "HEAD";
  if (v === "OPTIONS") return "OPTIONS";
  throw new APIError(502, `Expected HTTP method at ${path}, got ${String(v)}`);
}

export function assertOrigin(v: unknown, path: string): "builtin" | "package" {
  if (v === "builtin") return "builtin";
  if (v === "package") return "package";
  throw new APIError(502, `Expected "builtin"|"package" at ${path}, got ${String(v)}`);
}

function assertAuthSource(v: unknown, path: string): "env" {
  if (v === "env") return "env";
  throw new APIError(502, `Expected "env" at ${path}, got ${String(v)}`);
}

function assertAuthLocation(v: unknown, path: string): "header" | "query" {
  if (v === "header") return "header";
  if (v === "query") return "query";
  throw new APIError(502, `Expected "header"|"query" at ${path}, got ${String(v)}`);
}

function assertOptionalPrefix(v: unknown, path: string): string | undefined {
  if (typeof v === "string") return v;
  if (v === undefined) return undefined;
  throw new APIError(502, `Expected string|undefined at ${path}, got ${typeof v}`);
}

function assertAuthReference(v: unknown, path: string): {
  source: "env"; reference: string; location: "header" | "query"; name: string; prefix?: string;
} | null | undefined {
  if (v === null) return null;
  if (v === undefined) return undefined;
  const obj = assertObject(v, path);
  return {
    source: assertAuthSource(Reflect.get(obj, "source"), `${path}.source`),
    reference: assertAuthReferencePattern(Reflect.get(obj, "reference"), `${path}.reference`),
    location: assertAuthLocation(Reflect.get(obj, "location"), `${path}.location`),
    name: assertString(Reflect.get(obj, "name"), `${path}.name`),
    prefix: assertOptionalPrefix(Reflect.get(obj, "prefix"), `${path}.prefix`),
  };
}

function assertOperationName(v: unknown, path: string): string {
  const s = assertString(v, path);
  if (!/^[a-z][a-z0-9_]*$/.test(s)) throw new APIError(502, `Expected operation name matching ^[a-z][a-z0-9_]*$ at ${path}, got "${s}"`);
  return s;
}

function assertExtractPattern(v: unknown, path: string): string | null {
  if (v === null) return null;
  const s = assertString(v, path);
  if (!/^[A-Za-z0-9_.-]+$/.test(s)) throw new APIError(502, `Expected extract matching ^[A-Za-z0-9_.-]+$ at ${path}, got "${s}"`);
  return s;
}

function assertOperationTimeout(v: unknown, path: string): number {
  const n = assertNumber(v, path);
  if (n <= 0 || n > 120) throw new APIError(502, `Expected timeout_seconds in (0,120] at ${path}, got ${n}`);
  return n;
}

function assertAuthReferencePattern(v: unknown, path: string): string {
  const s = assertString(v, path);
  if (!/^[A-Z][A-Z0-9_]*$/.test(s)) throw new APIError(502, `Expected auth reference matching ^[A-Z][A-Z0-9_]*$ at ${path}, got "${s}"`);
  return s;
}

function assertSafeUrl(v: unknown, path: string): string {
  const s = assertString(v, path);
  if (s.length === 0) throw new APIError(502, `Expected non-empty URL at ${path}`);
  try {
    const url = new URL(s);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new APIError(502, `Expected HTTP(S) URL at ${path}, got ${url.protocol}`);
    }
    if (url.username || url.password) {
      throw new APIError(502, `URL must not contain credentials at ${path}`);
    }
    if (url.hostname.toLowerCase() === "localhost") {
      throw new APIError(502, `URL must use a public hostname at ${path}`);
    }
  } catch (e) {
    if (e instanceof APIError) throw e;
    throw new APIError(502, `Invalid URL at ${path}: ${String(s)}`);
  }
  return s;
}

export function assertHeaderNames(v: unknown, path: string): Record<string, unknown> {
  const obj = assertObject(v, path);
  for (const name of Object.keys(obj)) {
    if (/\r|\n/.test(name)) throw new APIError(502, `Header name must not contain CR/LF at ${path}: ${JSON.stringify(name)}`);
    // Reject only backend-style placeholders {var} matching _PLACEHOLDER in packages.py
    if (/\{[a-z][a-z0-9_]*\}/.test(name)) throw new APIError(502, `Header names must be fixed values at ${path}: ${JSON.stringify(name)}`);
  }
  return obj;
}

export function assertDeclarativeOperation(v: unknown, path: string): {
  name: string; description: string; method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
  url: string; query: Record<string, unknown>; headers: Record<string, unknown>;
  body: unknown; timeout_seconds: number; extract: string | null; auth: { source: "env"; reference: string; location: "header" | "query"; name: string; prefix?: string } | null;
} {
  const op = assertObject(v, path);
  return {
    name: assertOperationName(Reflect.get(op, "name"), `${path}.name`),
    description: assertString(Reflect.get(op, "description"), `${path}.description`),
    method: assertHttpMethod(Reflect.get(op, "method"), `${path}.method`),
    url: assertSafeUrl(Reflect.get(op, "url"), `${path}.url`),
    query: assertJsonRecord(Reflect.get(op, "query"), `${path}.query`),
    headers: assertHeaderNames(Reflect.get(op, "headers"), `${path}.headers`),
    body: (() => { const b = Reflect.get(op, "body"); return b === undefined ? undefined : assertJsonValue(b, `${path}.body`); })(),
    timeout_seconds: assertOperationTimeout(Reflect.get(op, "timeout_seconds"), `${path}.timeout_seconds`),
    extract: assertExtractPattern(Reflect.get(op, "extract"), `${path}.extract`),
    auth: assertAuthReference(Reflect.get(op, "auth"), `${path}.auth`) ?? null,
  };
}

export function assertDeclarativeManifest(v: unknown, path: string): DeclarativeSkillManifest | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object" || Array.isArray(v)) throw new APIError(502, `Expected object|null at ${path}, got ${typeof v}`);
  const obj = assertObject(v, path);
  const rawSv = Reflect.get(obj, "schema_version");
  if (typeof rawSv !== "string") throw new APIError(502, `Expected string schema_version at ${path}.schema_version, got ${typeof rawSv}`);
  if (rawSv !== "1.0") throw new APIError(502, `Expected "1.0" at ${path}.schema_version, got ${String(rawSv)}`);
  const sv: "1.0" = rawSv;
  const ps = Reflect.get(obj, "pipeline_supported");
  if (ps !== false) throw new APIError(502, `Expected false at ${path}.pipeline_supported, got ${String(ps)}`);
  const ops = assertArray(Reflect.get(obj, "operations"), `${path}.operations`, (item, i) => assertDeclarativeOperation(item, `${path}.operations[${i}]`));
  const opNames = ops.map((o) => o.name);
  if (new Set(opNames).size !== opNames.length) throw new APIError(502, `Duplicate operation names in ${path}.operations`);
  const reqs = assertArray(Reflect.get(obj, "requirements"), `${path}.requirements`, (item, i) => assertString(item, `${path}.requirements[${i}]`));
  if (reqs.length > 0) throw new APIError(502, `Declarative skills cannot have requirements at ${path}.requirements`);
  return {
    schema_version: sv,
    name: assertOperationName(Reflect.get(obj, "name"), `${path}.name`),
    display_name: assertString(Reflect.get(obj, "display_name"), `${path}.display_name`, true),
    version: assertString(Reflect.get(obj, "version"), `${path}.version`, true),
    category: assertString(Reflect.get(obj, "category"), `${path}.category`),
    description: assertString(Reflect.get(obj, "description"), `${path}.description`, true),
    supported_sources: assertArray(Reflect.get(obj, "supported_sources"), `${path}.supported_sources`, (v) => assertString(v, `${path}.supported_sources[]`)),
    operations: ops,
    user_selectable: assertBoolean(Reflect.get(obj, "user_selectable"), `${path}.user_selectable`),
    pipeline_supported: false,
    enabled: assertBoolean(Reflect.get(obj, "enabled"), `${path}.enabled`),
    requirements: reqs,
  };
}
