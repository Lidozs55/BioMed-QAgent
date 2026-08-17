/**
 * User declarative database HTTP tools (Python
 * ``app/databases/declarative.py`` parity, P5-D8/P5-D9/P5-11).
 *
 * Manifests are persisted by the Python DB bridge (named ops); ALL HTTP
 * execution happens in TS. Credential-protected operations pass through the
 * durable ToolApprovalGate — the secret value itself never enters the model
 * context and is only ever read server-side.
 */

import type { BioMedAgentTool } from "../contracts.js";
import { PublicHttpClient } from "../../external/network/http-client.js";
import { validatePublicHttpUrl } from "../../external/network/url-policy.js";
import type { DatabaseClient } from "../../persistence/db-client.js";
import { noopHooks, type ToolApprovalGate, type ToolHooks } from "./tool-hooks.js";

export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const PLACEHOLDER = /\{([a-z][a-z0-9_]*)\}/;
const PLACEHOLDER_G = /\{([a-z][a-z0-9_]*)\}/g;
const OPERATION_NAME = /^[a-z][a-z0-9_]*$/;
const MANIFEST_NAME = /^[a-z][a-z0-9_]*$/;
const SECRET_REFERENCE = /^[A-Z][A-Z0-9_]*$/;
const EXTRACT_PATH = /^[A-Za-z0-9_.-]+$/;

export class DatabaseValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseValidationError";
  }
}

export interface HttpAuthReference {
  source: "env";
  reference: string;
  location: "header" | "query";
  name: string;
  prefix: string;
}

export interface HttpOperationManifest {
  name: string;
  description: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
  url: string;
  query: Record<string, unknown>;
  headers: Record<string, unknown>;
  body: unknown;
  timeout_seconds: number;
  auth: HttpAuthReference | null;
  extract: string | null;
}

export interface DeclarativeDatabaseManifest {
  schema_version: "1.0";
  name: string;
  display_name: string;
  version: string;
  category: string;
  description: string;
  supported_sources: string[];
  operations: HttpOperationManifest[];
  enabled: boolean;
  user_selectable: boolean;
  pipeline_supported: false;
  requirements: string[];
}

function assertString(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) {
    throw new DatabaseValidationError(`${field} must be a non-empty string`);
  }
  return value;
}

/** Manifest validation mirroring the Python Pydantic model. */
export function parseDeclarativeManifest(raw: Record<string, unknown>): DeclarativeDatabaseManifest {
  if (raw.schema_version !== "1.0") {
    throw new DatabaseValidationError("schema_version must be '1.0'");
  }
  const name = assertString(raw.name, "name");
  if (!MANIFEST_NAME.test(name)) {
    throw new DatabaseValidationError(`database name must match ${MANIFEST_NAME.source}`);
  }
  const category = assertString(raw.category, "category");
  if (!["discovery", "acquisition", "processing", "analysis"].includes(category)) {
    throw new DatabaseValidationError(`invalid category: ${category}`);
  }
  const operationsRaw = raw.operations;
  if (!Array.isArray(operationsRaw)) {
    throw new DatabaseValidationError("operations must be an array");
  }
  const operations = operationsRaw.map((operation, index) => parseOperation(operation as Record<string, unknown>, index));
  const names = operations.map((operation) => operation.name);
  if (new Set(names).size !== names.length) {
    throw new DatabaseValidationError("operation names must be unique");
  }
  const requirements = raw.requirements;
  if (Array.isArray(requirements) && requirements.length > 0) {
    throw new DatabaseValidationError("declarative databases cannot declare Python requirements");
  }
  return {
    schema_version: "1.0",
    name,
    display_name: assertString(raw.display_name, "display_name"),
    version: assertString(raw.version, "version"),
    category,
    description: assertString(raw.description, "description"),
    supported_sources: Array.isArray(raw.supported_sources)
      ? raw.supported_sources.filter((source): source is string => typeof source === "string")
      : [],
    operations,
    enabled: raw.enabled !== false,
    user_selectable: raw.user_selectable !== false,
    pipeline_supported: false,
    requirements: [],
  };
}

function parseOperation(raw: Record<string, unknown>, index: number): HttpOperationManifest {
  const name = assertString(raw.name, `operations[${index}].name`);
  if (!OPERATION_NAME.test(name)) {
    throw new DatabaseValidationError(`operation name must match ${OPERATION_NAME.source}`);
  }
  const method = raw.method;
  if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(String(method))) {
    throw new DatabaseValidationError(`operations[${index}].method must be one of GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS`);
  }
  const url = assertString(raw.url, `operations[${index}].url`);
  validateUrlTemplate(url);
  const timeout = raw.timeout_seconds === undefined ? 30 : Number(raw.timeout_seconds);
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 120) {
    throw new DatabaseValidationError(`operations[${index}].timeout_seconds must be in (0, 120]`);
  }
  const headers = raw.headers;
  if (headers === undefined || typeof headers !== "object" || Array.isArray(headers) || headers === null) {
    throw new DatabaseValidationError(`operations[${index}].headers must be an object`);
  }
  for (const [headerName, value] of Object.entries(headers as Record<string, unknown>)) {
    if (PLACEHOLDER.test(headerName) || headerName.includes("\r") || headerName.includes("\n")) {
      throw new DatabaseValidationError("header names must be fixed manifest values");
    }
    void value;
  }
  let auth: HttpAuthReference | null = null;
  if (raw.auth !== undefined && raw.auth !== null) {
    const authRaw = raw.auth as Record<string, unknown>;
    if (authRaw.source !== "env" || (authRaw.location !== "header" && authRaw.location !== "query")) {
      throw new DatabaseValidationError(`operations[${index}].auth must reference an env secret in header or query`);
    }
    const reference = assertString(authRaw.reference, "auth.reference");
    if (!SECRET_REFERENCE.test(reference)) {
      throw new DatabaseValidationError(`auth.reference must match ${SECRET_REFERENCE.source}`);
    }
    auth = {
      source: "env",
      reference,
      location: authRaw.location,
      name: assertString(authRaw.name, "auth.name"),
      prefix: typeof authRaw.prefix === "string" ? authRaw.prefix : "",
    };
  }
  let extract: string | null = null;
  if (raw.extract !== undefined && raw.extract !== null) {
    extract = assertString(raw.extract, "extract");
    if (!EXTRACT_PATH.test(extract)) {
      throw new DatabaseValidationError(`extract must match ${EXTRACT_PATH.source}`);
    }
  }
  return {
    name,
    description: assertString(raw.description, `operations[${index}].description`),
    method: method as HttpOperationManifest["method"],
    url,
    query: asStringMap(raw.query, "query"),
    headers: asStringMap(headers, "headers"),
    body: raw.body === undefined ? null : raw.body,
    timeout_seconds: timeout,
    auth,
    extract,
  };
}

function asStringMap(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new DatabaseValidationError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function validateUrlTemplate(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DatabaseValidationError("operation URL must be an absolute HTTP(S) URL");
  }
  if (PLACEHOLDER.test(parsed.host)) {
    throw new DatabaseValidationError("operation URL authority cannot contain placeholders");
  }
  let rendered: URL;
  try {
    rendered = new URL(url.replace(PLACEHOLDER_G, "placeholder"));
  } catch {
    throw new DatabaseValidationError("operation URL must be an absolute HTTP(S) URL");
  }
  if (rendered.protocol !== "http:" && rendered.protocol !== "https:") {
    throw new DatabaseValidationError("operation URL must be an absolute HTTP(S) URL");
  }
  if (rendered.username !== "" || rendered.password !== "") {
    throw new DatabaseValidationError("operation URL credentials are not allowed");
  }
  if (rendered.hostname.toLowerCase() === "localhost") {
    throw new DatabaseValidationError("operation URL must use a public hostname");
  }
}

function collectPlaceholders(value: unknown, seen: Set<string>): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(PLACEHOLDER_G)) {
      if (match[1] !== undefined) seen.add(match[1]);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) collectPlaceholders(item, seen);
  } else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) collectPlaceholders(item, seen);
  }
}

function renderValue(value: unknown, argumentsValue: Record<string, string>): unknown {
  if (typeof value === "string") {
    return value.replace(PLACEHOLDER_G, (match, name: string) => argumentsValue[name] ?? match);
  }
  if (Array.isArray(value)) {
    return value.map((item) => renderValue(item, argumentsValue));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, renderValue(item, argumentsValue)]),
    );
  }
  return value;
}

function strictPercentEncode(value: string): string {
  // Python quote(safe="") parity: uppercase hex, everything except
  // unreserved characters encoded.
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9_.~-]/.test(ch)) out += ch;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

function renderUrl(url: string, argumentsValue: Record<string, string>): string {
  // Percent-encode path placeholders (Python quote(safe="") parity). Only the
  // PATH portion is rendered — URL query placeholders are left verbatim,
  // mirroring Python's _render_url which renders parsed.path only.
  const match = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)([^?#]*)([\s\S]*)$/i.exec(url);
  if (match === null) {
    throw new DatabaseValidationError("operation URL must be an absolute HTTP(S) URL");
  }
  let missing: string | null = null;
  const path = (match[2] ?? "").replace(PLACEHOLDER_G, (raw, name: string) => {
    if (!(name in argumentsValue)) {
      missing = name;
      return raw;
    }
    return strictPercentEncode(argumentsValue[name]);
  });
  if (missing !== null) {
    throw new DatabaseValidationError(`missing template argument: ${missing}`);
  }
  return `${match[1]}${path}${match[3] ?? ""}`;
}

function extractResponse(payload: unknown, extract: string | null): unknown {
  if (extract === null) return payload;
  let current: unknown = payload;
  for (const part of extract.split(".")) {
    if (typeof current !== "object" || current === null || !(part in (current as Record<string, unknown>))) {
      throw new DatabaseValidationError(`extraction path not found: ${extract}`);
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export interface DeclarativeDatabaseToolDeps {
  db: DatabaseClient;
  /** Credential approval gate; required for auth-protected operations. */
  approval?: ToolApprovalGate;
  /** Server-side secrets keyed by reference (defaults to BIOMED_SKILL_SECRET_* env). */
  secrets?: Readonly<Record<string, string>>;
  hooks?: ToolHooks;
  /** Injectable HTTP client (tests). */
  client?: PublicHttpClient;
  timeoutMs?: number;
}

export function collectEnvSecrets(): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("BIOMED_SKILL_SECRET_") && value !== undefined) {
      secrets[key.slice("BIOMED_SKILL_SECRET_".length)] = value;
    }
  }
  return secrets;
}

/** Load enabled user declarative manifests via the DB bridge (named ops). */
export async function loadDeclarativeManifests(db: DatabaseClient): Promise<DeclarativeDatabaseManifest[]> {
  const raw = await db.call<Array<Record<string, unknown>>>("database.tool_manifests", {});
  return raw.map((entry) => parseDeclarativeManifest(entry));
}

export function buildOperationTool(
  operation: HttpOperationManifest,
  deps: Required<Pick<DeclarativeDatabaseToolDeps, "db" | "client" | "secrets">> & Pick<DeclarativeDatabaseToolDeps, "approval" | "hooks" | "timeoutMs">,
): BioMedAgentTool {
  const hooks = noopHooks(deps.hooks);
  const parameters = [...(() => {
    const seen = new Set<string>();
    collectPlaceholders(
      { url: operation.url, query: operation.query, headers: operation.headers, body: operation.body },
      seen,
    );
    return seen;
  })()].sort();
  const client = deps.client;

  return {
    name: operation.name,
    label: operation.name,
    description: operation.description,
    parameters: {
      type: "object",
      properties: Object.fromEntries(parameters.map((name) => [name, { type: "string" }])),
      required: parameters,
      additionalProperties: false,
    },
    execute: async (argumentsValue, signal, context) => {
      try {
        const argumentsRecord = argumentsValue as Record<string, unknown> | null;
        if (typeof argumentsRecord !== "object" || argumentsRecord === null || Array.isArray(argumentsRecord)) {
          throw new DatabaseValidationError("arguments must be an object");
        }
        hooks.onQueryStarted(operation.name, operation.name);
        if (operation.auth !== null) {
          const gate = deps.approval;
          if (gate === undefined) {
            throw new DatabaseValidationError(
              `Operation '${operation.name}' requires HIL approval before credentials can be used.`,
            );
          }
          const decision = await gate.request(operation.name, signal, context?.toolCallId);
          if (decision !== "approve") {
            throw new DatabaseValidationError(
              `Operation '${operation.name}': credential use was rejected by the user.`,
            );
          }
        }
        const stringArguments: Record<string, string> = {};
        for (const [key, value] of Object.entries(argumentsRecord)) {
          stringArguments[key] = String(value);
        }
        const url = renderUrl(operation.url, stringArguments);
        await validatePublicHttpUrl(url, { resolve: client.resolve });
        const query = renderValue(operation.query, stringArguments) as Record<string, unknown>;
        const headers = renderValue(operation.headers, stringArguments) as Record<string, unknown>;
        for (const value of Object.values(headers)) {
          if (typeof value === "string" && (value.includes("\r") || value.includes("\n"))) {
            throw new DatabaseValidationError("header values cannot contain CR/LF");
          }
        }
        const body = renderValue(operation.body, stringArguments);
        const stringHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(headers)) stringHeaders[key] = String(value);
        const stringQuery: Record<string, string> = {};
        for (const [key, value] of Object.entries(query)) stringQuery[key] = String(value);
        if (operation.auth !== null) {
          const secret = deps.secrets[operation.auth.reference];
          if (secret === undefined) {
            throw new DatabaseValidationError(`configured secret is unavailable: ${operation.auth.reference}`);
          }
          const value = `${operation.auth.prefix}${secret}`;
          if (operation.auth.location === "header") stringHeaders[operation.auth.name] = value;
          else stringQuery[operation.auth.name] = value;
        }
        const queryString = new URLSearchParams(stringQuery).toString();
        const requestUrl = queryString === "" ? url : `${url}${url.includes("?") ? "&" : "?"}${queryString}`;
        const response = await client.request(requestUrl, {
          method: operation.method,
          headers: stringHeaders,
          body: body === null ? undefined : JSON.stringify(body),
          signal,
          timeoutMs: deps.timeoutMs ?? Math.round(operation.timeout_seconds * 1000),
          // Python: follow_redirects=True with per-hop public URL validation
          // (cross-host hops allowed when they stay public).
          validateUrl: async (hop) => {
            await validatePublicHttpUrl(hop, { resolve: client.resolve });
          },
          validateRedirect: async () => {
            /* per-hop validateUrl above enforces publicness */
          },
        });
        if (response.status < 200 || response.status >= 300) {
          await response.discard();
          throw new DatabaseValidationError(`HTTP ${response.status} for ${requestUrl}`);
        }
        const chunks: Buffer[] = [];
        let received = 0;
        for await (const chunk of response.body) {
          received += chunk.length;
          if (received > MAX_RESPONSE_BYTES) {
            throw new DatabaseValidationError("response exceeds 10 MiB limit");
          }
          chunks.push(chunk);
        }
        let payload: unknown;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          throw new DatabaseValidationError("response is not valid JSON");
        }
        const extracted = extractResponse(payload, operation.extract);
        hooks.onQuery(operation.name, operation.name, "success");
        return { content: JSON.stringify(extracted) };
      } catch (error) {
        return {
          content: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }
    },
  };
}

export async function createDeclarativeDatabaseTools(deps: DeclarativeDatabaseToolDeps): Promise<BioMedAgentTool[]> {
  const manifests = await loadDeclarativeManifests(deps.db);
  const secrets = deps.secrets ?? collectEnvSecrets();
  const client = deps.client ?? new PublicHttpClient();
  const tools: BioMedAgentTool[] = [];
  for (const manifest of manifests) {
    for (const operation of manifest.operations) {
      tools.push(buildOperationTool(operation, {
        db: deps.db,
        approval: deps.approval,
        secrets,
        hooks: deps.hooks,
        client,
        timeoutMs: deps.timeoutMs,
      }));
    }
  }
  return tools;
}
