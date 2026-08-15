/**
 * Declarative database wire DTOs (``/api/v1/databases``).
 *
 * Canonical transport shapes for the thin declarative database store. Moved
 * out of the frontend ``hooks/settingsContracts`` module so both sides of the
 * wire share one definition.
 */

export interface AuthReference {
  source: "env";
  reference: string;
  location: "header" | "query";
  name: string;
  prefix?: string;
}

export interface DeclarativeOperation {
  name: string;
  description: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
  url: string;
  query: Record<string, unknown>;
  headers: Record<string, unknown>;
  body: unknown;
  timeout_seconds: number;
  extract: string | null;
  auth: AuthReference | null;
}

export interface DeclarativeSkillManifest {
  schema_version: "1.0";
  name: string;
  display_name: string;
  version: string;
  category: string;
  description: string;
  supported_sources: string[];
  operations: DeclarativeOperation[];
  enabled: boolean;
  user_selectable: boolean;
  pipeline_supported: false;
  requirements: string[];
}

/* ---- Database (thin declarative store) ---- */
export interface DatabaseItem {
  id: string;
  name: string;
  category: string;
  description: string;
  available?: boolean;
  enabled: boolean;
  origin: "builtin" | "package";
  version?: string;
  pipeline_supported?: boolean;
  capability?: string;
  declarative_manifest?: DeclarativeSkillManifest | null;
}

export interface DatabaseDetail extends DatabaseItem {
  declarative_manifest: DeclarativeSkillManifest | null;
}

export interface DatabaseOperationUpdatePatch {
  name: string;
  description?: string;
  method?: DeclarativeOperation["method"];
  url?: string;
  query?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  body?: unknown;
  timeout_seconds?: number;
  extract?: string | null;
}

export interface DatabaseUpdatePatch {
  display_name?: string;
  description?: string;
  operation?: DatabaseOperationUpdatePatch;
}
