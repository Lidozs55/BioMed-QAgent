import { mkdir } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";

import { APIError } from "@biomed/contracts";
import path from "node:path";

import { BRIDGE_OP, DatabaseBridgeError } from "../persistence/db-client.js";
import { readJsonFile, writeJsonAtomic } from "../persistence/atomic-json.js";
import { HttpError } from "../http/error.js";
import { readJsonBody } from "../http/body.js";
import { sendError, sendJson, sendNoContent } from "../http/response.js";
import { asRecord } from "../http/validation.js";
import { BuildStore, BuildStoreError } from "./build-store.js";
import { DurableBuildStore, DurableBuildStoreError } from "../runtime/durable-build-store.js";
import {
  parseCancelDatasetBuildRequest,
  parseStartDatasetBuildRequest,
} from "../runtime/contracts.js";
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
  const value = await readJsonFile<unknown>(file);
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fallback;
  return personality(value as Record<string, unknown>, fallback);
}

async function writePersonalization(file: string, value: Personalization): Promise<void> {
  await writeJsonAtomic(file, value, { private: true });
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

/** Stream a verified artifact from the immutable publication root (A7). */
function attachmentStream(response: ServerResponse, value: {
  stream: import("node:stream").Readable;
  sizeBytes: number;
  mediaType: string;
  name: string;
}): void {
  response.writeHead(200, {
    "content-type": value.mediaType,
    "content-length": String(value.sizeBytes),
    "content-disposition": `attachment; filename="${value.name.replaceAll('"', "")}"`,
  });
  value.stream.on("error", (error) => {
    if (!response.headersSent && !response.destroyed) {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  });
  value.stream.pipe(response);
}

export async function createProductApi(options: ProductApiOptions): Promise<{
  handle: (request: IncomingMessage, response: ServerResponse) => boolean;
}> {
  const builds = new BuildStore(options.tasksRoot);
  const durableBuilds = new DurableBuildStore(options.tasksRoot);
  await durableBuilds.recoverExpiredLeases();
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
      sendJson(response, 200, {
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
        options.database.call<Array<Record<string, unknown>>>(BRIDGE_OP.DATABASE_LIST, {}),
        options.database.call<{ disabled: string[] }>(BRIDGE_OP.DATABASE_DISABLED, {}),
      ]);
      const disabled = new Set(disabledState.disabled);
      sendJson(response, 200, {
        databases: [
          ...listBuiltinDatabases(disabled),
          ...userEntries,
        ],
      });
      return;
    }
    if (method === "POST" && pathname === "/api/v1/databases") {
      const manifest = asRecord(await readJsonBody(request));
      if (typeof manifest.name === "string" && BUILTIN_DATABASE_NAMES.has(manifest.name)) {
        sendError(
          response,
          422,
          `database name conflicts with a builtin database: ${manifest.name}`,
        );
        return;
      }
      sendJson(response, 201, await options.database.call(BRIDGE_OP.DATABASE_SAVE, { manifest }));
      return;
    }
    const databaseMatch = /^\/api\/v1\/databases\/([^/]+)$/.exec(pathname);
    if (databaseMatch !== null) {
      const name = decodeURIComponent(databaseMatch[1]!);
      if (method === "GET") {
        const builtin = BUILTIN_DATABASE_NAMES.has(name);
        if (builtin) {
          const disabledState = await options.database.call<{ disabled: string[] }>(
            BRIDGE_OP.DATABASE_DISABLED,
            {},
          );
          const entry = getBuiltinDatabase(name, new Set(disabledState.disabled));
          if (entry === null) sendError(response, 404, "Database not found");
          else sendJson(response, 200, entry);
          return;
        }
        const value = await options.database.call(BRIDGE_OP.DATABASE_GET, { name });
        if (value === null) sendError(response, 404, "Database not found");
        else sendJson(response, 200, value);
        return;
      }
      if (method === "PUT") {
        if (BUILTIN_DATABASE_NAMES.has(name)) {
          sendError(response, 403, "builtin databases are immutable");
          return;
        }
        sendJson(response, 200, await options.database.call(BRIDGE_OP.DATABASE_PATCH, {
          name,
          patch: asRecord(await readJsonBody(request)),
        }));
        return;
      }
      if (method === "DELETE") {
        if (BUILTIN_DATABASE_NAMES.has(name)) {
          sendError(response, 403, "builtin databases cannot be deleted");
          return;
        }
        await options.database.call(BRIDGE_OP.DATABASE_DELETE, { name });
        sendNoContent(response);
        return;
      }
    }
    const toggleMatch = /^\/api\/v1\/databases\/([^/]+)\/(enable|disable)$/.exec(pathname);
    if (method === "POST" && toggleMatch !== null) {
      const name = decodeURIComponent(toggleMatch[1]!);
      const enabled = toggleMatch[2] === "enable";
      sendJson(response, 200, await options.database.call(BRIDGE_OP.DATABASE_SET_ENABLED, { name, enabled }));
      return;
    }
    if (pathname === "/api/v1/personalization") {
      const current = await readPersonalization(personalizationFile);
      if (method === "GET") {
        sendJson(response, 200, current);
        return;
      }
      if (method === "PUT") {
        const updated = personality(asRecord(await readJsonBody(request)), current);
        await writePersonalization(personalizationFile, updated);
        sendJson(response, 200, updated);
        return;
      }
    }
    if (method === "POST" && pathname === "/api/v1/builds") {
      const startRequest = parseStartDatasetBuildRequest(await readJsonBody(request));
      sendJson(response, 202, await durableBuilds.start(startRequest));
      return;
    }
    if (method === "GET" && pathname === "/api/v1/builds") {
      const requested = Number(url.searchParams.get("limit") ?? 50);
      if (!Number.isInteger(requested) || requested < 1 || requested > 200) {
        sendError(response, 422, "limit must be between 1 and 200");
        return;
      }
      sendJson(response, 200, await builds.list(requested));
      return;
    }
    const buildMatch = /^\/api\/v1\/builds\/([^/]+)$/.exec(pathname);
    if (method === "GET" && buildMatch !== null) {
      const buildId = decodeURIComponent(buildMatch[1]!);
      const durable = await durableBuilds.get(buildId);
      if (durable !== null) {
        sendJson(response, 200, { schema_version: "1.0", build: durable });
        return;
      }
      const value = await builds.detail(
        buildId,
        parameter(url, "task_id"),
      );
      if (value === null) sendError(response, 404, "Build not found");
      else sendJson(response, 200, value);
      return;
    }
    const cancelMatch = /^\/api\/v1\/builds\/([^/]+)\/cancel$/.exec(pathname);
    if (method === "POST" && cancelMatch !== null) {
      const value = await durableBuilds.cancel(
        parseCancelDatasetBuildRequest(await readJsonBody(request)),
        decodeURIComponent(cancelMatch[1]!),
      );
      sendJson(response, 202, value);
      return;
    }
    const buildArtifactMatch = /^\/api\/v1\/builds\/([^/]+)\/artifacts\/([^/]+)$/.exec(pathname);
    if (method === "GET" && buildArtifactMatch !== null) {
      const value = await builds.artifact(
        decodeURIComponent(buildArtifactMatch[1]!),
        decodeURIComponent(buildArtifactMatch[2]!),
        parameter(url, "task_id"),
      );
      if (value === null) sendError(response, 404, "Artifact not found");
      else attachmentStream(response, value);
      return;
    }
    if (method === "GET" && pathname === "/api/v1/cache/datasets") {
      const requested = Number(url.searchParams.get("limit") ?? 50);
      if (!Number.isInteger(requested) || requested < 1 || requested > 200) {
        sendError(response, 422, "limit must be between 1 and 200");
        return;
      }
      sendJson(response, 200, await cache.list(
        parameter(url, "namespace"),
        parameter(url, "keyword"),
        requested,
      ));
      return;
    }
    if (method === "DELETE" && pathname === "/api/v1/cache/datasets") {
      sendJson(response, 200, { deleted: await cache.clear() });
      return;
    }
    const cacheMatch = /^\/api\/v1\/cache\/datasets\/([^/]+)$/.exec(pathname);
    if (cacheMatch !== null && (method === "GET" || method === "DELETE")) {
      const namespace = parameter(url, "namespace");
      const datasetId = decodeURIComponent(cacheMatch[1]!);
      if (method === "DELETE") {
        const deleted = await cache.delete(datasetId, namespace);
        if (!deleted) sendError(response, 404, "Dataset not found");
        else sendJson(response, 200, { deleted: true });
        return;
      }
      const value = await cache.detail(datasetId, namespace);
      if (value === null) sendError(response, 404, "Dataset not found");
      else sendJson(response, 200, value);
      return;
    }
    const cacheArtifactMatch = /^\/api\/v1\/cache\/datasets\/([^/]+)\/artifacts\/([^/]+)$/.exec(pathname);
    if (method === "GET" && cacheArtifactMatch !== null) {
      const namespace = parameter(url, "namespace");
      const datasetId = decodeURIComponent(cacheArtifactMatch[1]!);
      const artifactId = decodeURIComponent(cacheArtifactMatch[2]!);
      const value = await cache.artifact(datasetId, namespace, artifactId)
        ?? await cache.asset(datasetId, namespace, artifactId);
      if (value === null) sendError(response, 404, "Artifact not found");
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
    sendError(response, 405, "Method not allowed");
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
        if (dispatchError instanceof HttpError) {
          sendError(response, dispatchError.status, dispatchError.message);
        } else if (dispatchError instanceof APIError) {
          sendJson(response, 422, {
            schema_version: "1.0",
            code: "invalid_build_request",
            message: dispatchError.message,
            retryable: false,
            task_id: null,
            run_id: null,
            build_id: null,
            current_status: null,
            details: {},
          });
        } else if (dispatchError instanceof SyntaxError || dispatchError instanceof URIError) {
          sendError(response, 422, "Invalid request");
        } else if (dispatchError instanceof DatabaseBridgeError) {
          const status = dispatchError.code === "not_found"
            ? 404
            : dispatchError.code === "forbidden"
              ? 403
              : dispatchError.code === "validation"
                ? 422
                : 503;
          sendError(response, status, dispatchError.message);
        } else if (dispatchError instanceof DurableBuildStoreError) {
          sendJson(response, dispatchError.httpStatus, dispatchError.api);
        } else if (dispatchError instanceof BuildStoreError) {
          sendError(response, 409, dispatchError.message);
        } else {
          console.error("product_api.request_failed", dispatchError);
          sendError(response, 500, "Internal server error");
        }
      });
      return true;
    },
  };
}
