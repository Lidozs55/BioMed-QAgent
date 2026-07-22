import { APIError } from "@/hooks/settingsContracts";
import type { SkillDetail, SkillManifest, SkillValidation } from "@/hooks/settingsContracts";
import type { ArtifactRecord, DatabaseRecord } from "@/runtime/contracts";
import {
  assertString, assertBoolean, assertStringOrNull, assertNumber, assertObject, assertArray,
  assertJsonRecord, assertJsonValue, optBoolean,
} from "@/lib/eventValidatorHelpers";

function assertHttpMethod(v: unknown, path: string): "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" {
  if (v === "GET") return "GET";
  if (v === "POST") return "POST";
  if (v === "PUT") return "PUT";
  if (v === "PATCH") return "PATCH";
  if (v === "DELETE") return "DELETE";
  if (v === "HEAD") return "HEAD";
  if (v === "OPTIONS") return "OPTIONS";
  throw new APIError(502, `Expected HTTP method at ${path}, got ${String(v)}`);
}

function assertOrigin(v: unknown, path: string): "builtin" | "package" {
  if (v === "builtin") return "builtin";
  if (v === "package") return "package";
  throw new APIError(502, `Expected "builtin"|"package" at ${path}, got ${String(v)}`);
}

function assertPackageKind(v: unknown, path: string): "manifest" | "zip" {
  if (v === "manifest") return "manifest";
  if (v === "zip") return "zip";
  throw new APIError(502, `Expected "manifest"|"zip" at ${path}, got ${String(v)}`);
}

function assertLoadError(v: unknown, path: string): string | null | undefined {
  if (typeof v === "string") return v;
  if (v === null) return null;
  if (v === undefined) return undefined;
  throw new APIError(502, `Expected string|null|undefined at ${path}, got ${typeof v}`);
}

function assertSkillManifest(json: unknown, path: string): SkillDetail["manifest"] {
  const obj = assertObject(json, path);
  return {
    name: assertString(Reflect.get(obj, "name"), `${path}.name`),
    display_name: assertString(Reflect.get(obj, "display_name"), `${path}.display_name`),
    version: assertString(Reflect.get(obj, "version"), `${path}.version`),
    category: assertString(Reflect.get(obj, "category"), `${path}.category`),
    description: assertString(Reflect.get(obj, "description"), `${path}.description`),
    origin: assertOrigin(Reflect.get(obj, "origin"), `${path}.origin`),
    supported_sources: assertArray(Reflect.get(obj, "supported_sources"), `${path}.supported_sources`, (v) => assertString(v, `${path}.supported_sources[]`)),
    operations: assertArray(Reflect.get(obj, "operations"), `${path}.operations`, (v) => assertString(v, `${path}.operations[]`)),
    enabled: assertBoolean(Reflect.get(obj, "enabled"), `${path}.enabled`),
    user_selectable: assertBoolean(Reflect.get(obj, "user_selectable"), `${path}.user_selectable`),
    pipeline_supported: assertBoolean(Reflect.get(obj, "pipeline_supported"), `${path}.pipeline_supported`),
    available: optBoolean(Reflect.get(obj, "available"), `${path}.available`),
    load_error: assertLoadError(Reflect.get(obj, "load_error"), `${path}.load_error`),
  };
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

function assertHeaderNames(v: unknown, path: string): Record<string, unknown> {
  const obj = assertObject(v, path);
  for (const name of Object.keys(obj)) {
    if (/\r|\n/.test(name)) throw new APIError(502, `Header name must not contain CR/LF at ${path}: ${JSON.stringify(name)}`);
    if (/\{/.test(name)) throw new APIError(502, `Header names must be fixed values at ${path}: ${JSON.stringify(name)}`);
  }
  return obj;
}

function assertDeclarativeOperation(v: unknown, path: string): {
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

function assertDeclarativeManifest(v: unknown, path: string): SkillDetail["declarative_manifest"] {
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

/* ---- Databases ---- */

export function parseDatabasesEnvelope(json: unknown): { databases: DatabaseRecord[] } {
  const obj = assertObject(json, "databases response");
  return {
    databases: assertArray(Reflect.get(obj, "databases"), "databases", (item, i) => {
      const dbo = assertObject(item, `databases[${i}]`);
      return {
        id: assertString(Reflect.get(dbo, "id"), `databases[${i}].id`),
        name: assertString(Reflect.get(dbo, "name"), `databases[${i}].name`),
        category: assertString(Reflect.get(dbo, "category"), `databases[${i}].category`),
        description: assertString(Reflect.get(dbo, "description"), `databases[${i}].description`),
        available: optBoolean(Reflect.get(dbo, "available"), `databases[${i}].available`),
        origin: (() => { const o = Reflect.get(dbo, "origin"); return o !== undefined ? assertOrigin(o, `databases[${i}].origin`) : undefined; })(),
        version: (() => { const v = Reflect.get(dbo, "version"); return v !== undefined ? assertString(v, `databases[${i}].version`) : undefined; })(),
        pipeline_supported: optBoolean(Reflect.get(dbo, "pipeline_supported"), `databases[${i}].pipeline_supported`),
      };
    }),
  };
}

/* ---- Artifacts ---- */

export function parseArtifactsEnvelope(json: unknown): { artifacts: ArtifactRecord[] } {
  const obj = assertObject(json, "artifacts response");
  return {
    artifacts: assertArray(Reflect.get(obj, "artifacts"), "artifacts", (item, i) => {
      const ao = assertObject(item, `artifacts[${i}]`);
      return {
        artifact_id: assertString(Reflect.get(ao, "artifact_id"), `artifacts[${i}].artifact_id`),
        name: assertString(Reflect.get(ao, "name"), `artifacts[${i}].name`),
        size: assertNumber(Reflect.get(ao, "size"), `artifacts[${i}].size`),
        sha256: assertString(Reflect.get(ao, "sha256"), `artifacts[${i}].sha256`),
        media_type: assertString(Reflect.get(ao, "media_type"), `artifacts[${i}].media_type`),
      };
    }),
  };
}

/* ---- Skills ---- */

export function parseSkillsEnvelope(json: unknown): { skills: SkillManifest[] } {
  const obj = assertObject(json, "skills response");
  return {
    skills: assertArray(Reflect.get(obj, "skills"), "skills", (item, i) => {
      const so = assertObject(item, `skills[${i}]`);
      return {
        name: assertString(Reflect.get(so, "name"), `skills[${i}].name`),
        display_name: assertString(Reflect.get(so, "display_name"), `skills[${i}].display_name`),
        version: assertString(Reflect.get(so, "version"), `skills[${i}].version`),
        category: assertString(Reflect.get(so, "category"), `skills[${i}].category`),
        description: assertString(Reflect.get(so, "description"), `skills[${i}].description`),
        origin: assertOrigin(Reflect.get(so, "origin"), `skills[${i}].origin`),
        supported_sources: assertArray(Reflect.get(so, "supported_sources"), `skills[${i}].supported_sources`, (v) => assertString(v, `skills[${i}].supported_sources[]`)),
        operations: assertArray(Reflect.get(so, "operations"), `skills[${i}].operations`, (v) => assertString(v, `skills[${i}].operations[]`)),
        enabled: assertBoolean(Reflect.get(so, "enabled"), `skills[${i}].enabled`),
        user_selectable: assertBoolean(Reflect.get(so, "user_selectable"), `skills[${i}].user_selectable`),
        pipeline_supported: assertBoolean(Reflect.get(so, "pipeline_supported"), `skills[${i}].pipeline_supported`),
        available: optBoolean(Reflect.get(so, "available"), `skills[${i}].available`),
        load_error: assertLoadError(Reflect.get(so, "load_error"), `skills[${i}].load_error`),
      };
    }),
  };
}

export function parseSkillDetail(json: unknown): SkillDetail {
  const obj = assertObject(json, "SkillDetail");
  const manifest = assertObject(Reflect.get(obj, "manifest"), "manifest");
  return {
    manifest: assertSkillManifest(manifest, "manifest"),
    current_version: assertString(Reflect.get(obj, "current_version"), "current_version"),
    versions: assertArray(Reflect.get(obj, "versions"), "versions", (v) => assertString(v, "versions[]")),
    package_kind: assertPackageKind(Reflect.get(obj, "package_kind"), "package_kind"),
    warning: assertStringOrNull(Reflect.get(obj, "warning"), "warning"),
    available: assertBoolean(Reflect.get(obj, "available"), "available"),
    load_error: assertStringOrNull(Reflect.get(obj, "load_error"), "load_error"),
    declarative_manifest: assertDeclarativeManifest(Reflect.get(obj, "declarative_manifest"), "declarative_manifest"),
  };
}

export function parseSkillValidation(json: unknown): SkillValidation {
  const obj = assertObject(json, "SkillValidation");
  const skill = assertObject(Reflect.get(obj, "skill"), "skill");
  return {
    valid: assertBoolean(Reflect.get(obj, "valid"), "valid"),
    skill: assertSkillManifest(skill, "skill"),
    warning: assertStringOrNull(Reflect.get(obj, "warning"), "warning"),
  };
}

export { assertDeclarativeManifest };
