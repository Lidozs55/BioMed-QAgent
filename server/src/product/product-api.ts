import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import { DatabaseBridgeError } from "../persistence/db-client.js";
import { BuildStore, BuildStoreError } from "./build-store.js";
import { CacheApi } from "./cache-api.js";
import {
  BUILTIN_DATABASE_NAMES,
  getBuiltinDatabase,
  listBuiltinDatabases,
} from "./builtin-databases.js";

export interface ProductDatabaseClient {
  call<T>(op: string, args: Record<string, unknown>): Promise<T>;
}

export interface ProductApiOptions {
  tasksRoot: string;
  cacheDir: string;
  settingsDir: string;
  database: ProductDatabaseClient;
}

interface Personalization {
  custom_instructions: string;
  personality: "pragmatic" | "warm" | "rigorous";
  personality_label: string;
}

const LABELS = {
  pragmatic: "务实",
  warm: "亲和",
  rigorous: "严谨",
} as const;

function json(response: ServerResponse, status: number, value: unknown): void {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": bytes.length,
  });
  response.end(bytes);
}

function error(response: ServerResponse, status: number, detail: string): void {
  json(response, status, { detail });
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 1_048_576) throw new Error("Request body is too large");
    chunks.push(bytes);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be an object");
  }
  return value as Record<string, unknown>;
}

function parameter(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key);
  return value === null || value === "" ? undefined : value;
}

function personality(value: Record<string, unknown>, current: Personalization): Personalization {
  const personalityValue = value.personality ?? current.personality;
  const instructions = value.custom_instructions ?? current.custom_instructions;
  if (
    personalityValue !== "pragmatic" &&
    personalityValue !== "warm" &&
    personalityValue !== "rigorous"
  ) {
    throw new Error("personality must be pragmatic, warm, or rigorous");
  }
  if (typeof instructions !== "string" || instructions.length > 20_000) {
    throw new Error("custom_instructions must be a string up to 20000 characters");
  }
  return {
    custom_instructions: instructions,
    personality: personalityValue,
    personality_label: LABELS[personalityValue],
  };
}

async function readPersonalization(file: string): Promise<Personalization> {
  const fallback = personality({}, {
    custom_instructions: "",
    personality: "pragmatic",
    personality_label: LABELS.pragmatic,
  });
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return fallback;
    return personality(value as Record<string, unknown>, fallback);
  } catch (readError) {
    if ((readError as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    return fallback;
  }
}

async function writePersonalization(file: string, value: Personalization): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
}

function attachment(response: ServerResponse, value: {
  bytes: Buffer;
  mediaType: string;
  name: string;
}): void {
  response.writeHead(200, {
    "content-type": value.mediaType,
    "content-length": value.bytes.length,
    "content-disposition": `attachment; filename="${value.name.replaceAll('"', "")}"`,
  });
  response.end(value.bytes);
}

export async function createProductApi(options: ProductApiOptions): Promise<{
  handle: (request: IncomingMessage, response: ServerResponse) => boolean;
}> {
  const builds = new BuildStore(options.tasksRoot);
  const cache = new CacheApi(options.cacheDir, options.database);
  const personalizationFile = path.join(options.settingsDir, "personalization.json");
  await mkdir(options.settingsDir, { recursive: true });

  async function dispatch(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    const method = request.method ?? "GET";
    const pathname = url.pathname;
    if (method === "GET" && pathname === "/api/v1/health") {
      json(response, 200, {
        status: "ok",
        app_host: "ts",
        agent_runtime: "pi",
        dataset_core: "ts",
      });
      return;
    }
    if (method === "GET" && pathname === "/api/v1/databases") {
      // Phase 8: builtin catalogue is TS-owned; the bridge persists only user
      // manifests + the enabled/disabled state.
      const [userEntries, disabledState] = await Promise.all([
        options.database.call<Array<Record<string, unknown>>>("database.list", {}),
        options.database.call<{ disabled: string[] }>("database.disabled", {}),
      ]);
      const disabled = new Set(disabledState.disabled);
      json(response, 200, {
        databases: [
          ...listBuiltinDatabases(disabled),
          ...userEntries,
        ],
      });
      return;
    }
    if (method === "POST" && pathname === "/api/v1/databases") {
      const manifest = (await body(request)) as { name?: unknown };
      if (typeof manifest.name === "string" && BUILTIN_DATABASE_NAMES.has(manifest.name)) {
        error(
          response,
          422,
          `database name conflicts with a builtin database: ${manifest.name}`,
        );
        return;
      }
      json(response, 201, await options.database.call("database.save", { manifest }));
      return;
    }
    const databaseMatch = /^\/api\/v1\/databases\/([^/]+)$/.exec(pathname);
    if (databaseMatch !== null) {
      const name = decodeURIComponent(databaseMatch[1]!);
      if (method === "GET") {
        const builtin = BUILTIN_DATABASE_NAMES.has(name);
        if (builtin) {
          const disabledState = await options.database.call<{ disabled: string[] }>(
            "database.disabled",
            {},
          );
          const entry = getBuiltinDatabase(name, new Set(disabledState.disabled));
          if (entry === null) error(response, 404, "Database not found");
          else json(response, 200, entry);
          return;
        }
        const value = await options.database.call("database.get", { name });
        if (value === null) error(response, 404, "Database not found");
        else json(response, 200, value);
        return;
      }
      if (method === "PUT") {
        if (BUILTIN_DATABASE_NAMES.has(name)) {
          error(response, 403, "builtin databases are immutable");
          return;
        }
        json(response, 200, await options.database.call("database.patch", {
          name,
          patch: await body(request),
        }));
        return;
      }
      if (method === "DELETE") {
        if (BUILTIN_DATABASE_NAMES.has(name)) {
          error(response, 403, "builtin databases cannot be deleted");
          return;
        }
        await options.database.call("database.delete", { name });
        response.writeHead(204).end();
        return;
      }
    }
    const toggleMatch = /^\/api\/v1\/databases\/([^/]+)\/(enable|disable)$/.exec(pathname);
    if (method === "POST" && toggleMatch !== null) {
      const name = decodeURIComponent(toggleMatch[1]!);
      const enabled = toggleMatch[2] === "enable";
      json(response, 200, await options.database.call("database.set_enabled", { name, enabled }));
      return;
    }
    if (pathname === "/api/v1/personalization") {
      const current = await readPersonalization(personalizationFile);
      if (method === "GET") {
        json(response, 200, current);
        return;
      }
      if (method === "PUT") {
        const updated = personality(await body(request), current);
        await writePersonalization(personalizationFile, updated);
        json(response, 200, updated);
        return;
      }
    }
    if (method === "GET" && pathname === "/api/v1/builds") {
      const requested = Number(url.searchParams.get("limit") ?? 50);
      if (!Number.isInteger(requested) || requested < 1 || requested > 200) {
        error(response, 422, "limit must be between 1 and 200");
        return;
      }
      json(response, 200, await builds.list(requested));
      return;
    }
    const buildMatch = /^\/api\/v1\/builds\/([^/]+)$/.exec(pathname);
    if (method === "GET" && buildMatch !== null) {
      const value = await builds.detail(
        decodeURIComponent(buildMatch[1]!),
        parameter(url, "task_id"),
      );
      if (value === null) error(response, 404, "Build not found");
      else json(response, 200, value);
      return;
    }
    const buildArtifactMatch = /^\/api\/v1\/builds\/([^/]+)\/artifacts\/([^/]+)$/.exec(pathname);
    if (method === "GET" && buildArtifactMatch !== null) {
      const value = await builds.artifact(
        decodeURIComponent(buildArtifactMatch[1]!),
        decodeURIComponent(buildArtifactMatch[2]!),
        parameter(url, "task_id"),
      );
      if (value === null) error(response, 404, "Artifact not found");
      else attachment(response, value);
      return;
    }
    if (method === "GET" && pathname === "/api/v1/cache/datasets") {
      const requested = Number(url.searchParams.get("limit") ?? 50);
      if (!Number.isInteger(requested) || requested < 1 || requested > 200) {
        error(response, 422, "limit must be between 1 and 200");
        return;
      }
      json(response, 200, await cache.list(
        parameter(url, "namespace"),
        parameter(url, "keyword"),
        requested,
      ));
      return;
    }
    const cacheMatch = /^\/api\/v1\/cache\/datasets\/([^/]+)$/.exec(pathname);
    if (method === "GET" && cacheMatch !== null) {
      const namespace = parameter(url, "namespace");
      const value = await cache.detail(decodeURIComponent(cacheMatch[1]!), namespace);
      if (value === null) error(response, 404, "Dataset not found");
      else json(response, 200, value);
      return;
    }
    const cacheArtifactMatch = /^\/api\/v1\/cache\/datasets\/([^/]+)\/artifacts\/([^/]+)$/.exec(pathname);
    if (method === "GET" && cacheArtifactMatch !== null) {
      const namespace = parameter(url, "namespace");
      const value = await cache.artifact(
        decodeURIComponent(cacheArtifactMatch[1]!),
        namespace,
        decodeURIComponent(cacheArtifactMatch[2]!),
      );
      if (value === null) error(response, 404, "Artifact not found");
      else attachment(response, value);
      return;
    }
    if (method === "GET" && pathname === "/api/v1/cache/export") {
      const bytes = await cache.exportZip();
      response.writeHead(200, {
        "content-type": "application/zip",
        "content-length": bytes.length,
        "content-disposition": 'attachment; filename="cache_export.zip"',
      });
      response.end(bytes);
      return;
    }
    error(response, 405, "Method not allowed");
  }

  return {
    handle(request, response) {
      const url = new URL(request.url ?? "/", "http://application-host");
      const productPath = (
        url.pathname === "/api/v1/health" ||
        url.pathname === "/api/v1/personalization" ||
        url.pathname === "/api/v1/databases" ||
        url.pathname.startsWith("/api/v1/databases/") ||
        url.pathname === "/api/v1/builds" ||
        url.pathname.startsWith("/api/v1/builds/") ||
        url.pathname === "/api/v1/cache/export" ||
        url.pathname === "/api/v1/cache/datasets" ||
        url.pathname.startsWith("/api/v1/cache/datasets/")
      );
      if (!productPath) return false;
      void dispatch(request, response, url).catch((dispatchError: unknown) => {
        if (response.headersSent) {
          response.destroy(dispatchError instanceof Error ? dispatchError : undefined);
          return;
        }
        if (dispatchError instanceof SyntaxError || dispatchError instanceof URIError) {
          error(response, 422, "Invalid request");
        } else if (dispatchError instanceof DatabaseBridgeError) {
          const status = dispatchError.code === "not_found"
            ? 404
            : dispatchError.code === "forbidden"
              ? 403
              : dispatchError.code === "validation"
                ? 422
                : 503;
          error(response, status, dispatchError.message);
        } else if (dispatchError instanceof BuildStoreError) {
          error(response, 409, dispatchError.message);
        } else {
          console.error("product_api.request_failed", dispatchError);
          error(response, 500, "Internal server error");
        }
      });
      return true;
    },
  };
}
