/**
 * Model settings / model registry HTTP routes.
 *
 * Path matching + request-body/response plumbing for ``/api/v1/settings``,
 * ``/api/v1/vendors``, ``/api/v1/models`` and ``/api/v1/model-registry/*``.
 * All domain logic lives in the ``ModelSettingsService`` (``./service.ts``).
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import type { ModelRegistryListQuery } from "@biomed/contracts";

import { readJsonBody } from "../../http/body.js";
import { HttpError } from "../../http/error.js";
import { sendJson, sendNoContent } from "../../http/response.js";
import { asRecord, requiredString, type JsonObject } from "../../http/validation.js";
import { VENDORS } from "./catalog.js";
import type { ModelSettingsService } from "./service.js";

const MAX_PAGE_SIZE = 100;

function parseQueryInt(raw: string, name: string, minimum: number, maximum?: number): number {
  if (!/^\d+$/.test(raw)) throw new HttpError(422, `${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || (maximum !== undefined && value > maximum)) {
    throw new HttpError(422, `${name} is outside the supported range`);
  }
  return value;
}

function listQuery(url: URL): ModelRegistryListQuery | null {
  const rawPage = url.searchParams.get("page");
  const rawSize = url.searchParams.get("size");
  const rawQ = url.searchParams.get("q");
  if (rawPage === null && rawSize === null && rawQ === null) return null;
  return {
    page: rawPage === null ? undefined : parseQueryInt(rawPage, "page", 1),
    size: rawSize === null ? undefined : parseQueryInt(rawSize, "size", 1, MAX_PAGE_SIZE),
    q: rawQ === null ? undefined : rawQ,
  };
}

export function createSettingsRouter(service: ModelSettingsService): {
  handle: (request: IncomingMessage, response: ServerResponse) => boolean;
} {
  async function body(request: IncomingMessage): Promise<JsonObject> {
    return asRecord(await readJsonBody(request));
  }

  function send(response: ServerResponse, status: number, value: unknown): void {
    sendJson(response, status, value, { "cache-control": "no-store" });
  }

  async function dispatch(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    const pathname = url.pathname;
    const method = request.method ?? "GET";
    if (method === "GET" && pathname === "/api/v1/settings") {
      return send(response, 200, service.getSettings());
    }
    if (method === "PUT" && pathname === "/api/v1/settings") {
      await service.updateSettings(await body(request));
      return send(response, 200, service.getSettings());
    }
    if (method === "GET" && pathname === "/api/v1/vendors") {
      return send(response, 200, {
        vendors: VENDORS.map(([id, name, base_url, recommended]) => ({
          id, name, base_url, recommended,
          description: `${name} OpenAI-compatible API`,
        })),
      });
    }
    if (method === "POST" && pathname === "/api/v1/models") {
      const requestBody = await body(request);
      const baseUrl = requiredString(requestBody.preview_base_url, "preview_base_url");
      const apiKey = typeof requestBody.preview_api_key === "string" ? requestBody.preview_api_key : "";
      const models = await service.discover(baseUrl, apiKey,
        typeof requestBody.query === "string" ? requestBody.query : undefined);
      return send(response, 200, { models, total_count: models.length, api_source: baseUrl });
    }
    if (method === "GET" && pathname === "/api/v1/model-registry/providers") {
      const query = listQuery(url);
      return send(response, 200, query === null ? service.listProviders() : service.listProvidersPage(query));
    }
    if (method === "POST" && pathname === "/api/v1/model-registry/providers") {
      return send(response, 201, service.publicProvider(await service.createProvider(await body(request))));
    }
    const providerMatch = /^\/api\/v1\/model-registry\/providers\/([^/]+)$/.exec(pathname);
    if (providerMatch !== null && method === "PUT") {
      return send(response, 200, service.publicProvider(
        await service.updateProvider(decodeURIComponent(providerMatch[1]!), await body(request)),
      ));
    }
    if (providerMatch !== null && method === "DELETE") {
      await service.deleteProvider(decodeURIComponent(providerMatch[1]!));
      sendNoContent(response);
      return;
    }
    const discoveryMatch = /^\/api\/v1\/model-registry\/providers\/([^/]+)\/discover$/.exec(pathname);
    if (discoveryMatch !== null && method === "POST") {
      return send(response, 200, await service.discoverProviderModels(decodeURIComponent(discoveryMatch[1]!)));
    }
    const specsMatch = /^\/api\/v1\/model-registry\/providers\/([^/]+)\/param-specs$/.exec(pathname);
    if (specsMatch !== null && method === "GET") {
      return send(response, 200, service.providerParamSpecs(decodeURIComponent(specsMatch[1]!)));
    }
    if (method === "GET" && pathname === "/api/v1/model-registry/models") {
      const query = listQuery(url);
      return send(response, 200, query === null ? service.listModels() : service.listModelsPage(query));
    }
    if (method === "POST" && pathname === "/api/v1/model-registry/models") {
      return send(response, 201, service.publicModel(await service.createModel(await body(request))));
    }
    const modelMatch = /^\/api\/v1\/model-registry\/models\/([^/]+)$/.exec(pathname);
    if (modelMatch !== null && method === "PUT") {
      return send(response, 200, service.publicModel(
        await service.updateModel(decodeURIComponent(modelMatch[1]!), await body(request)),
      ));
    }
    if (modelMatch !== null && method === "DELETE") {
      await service.deleteModel(decodeURIComponent(modelMatch[1]!));
      sendNoContent(response);
      return;
    }
    const activationMatch = /^\/api\/v1\/model-registry\/models\/([^/]+)\/activate$/.exec(pathname);
    if (activationMatch !== null && method === "POST") {
      await service.activateModel(decodeURIComponent(activationMatch[1]!));
      return send(response, 200, service.getSettings());
    }
    throw new HttpError(404, "Not Found");
  }

  return {
    handle(request, response) {
      const url = new URL(request.url ?? "/", "http://application-host");
      const pathname = url.pathname;
      if (pathname !== "/api/v1/settings" && pathname !== "/api/v1/vendors" &&
          pathname !== "/api/v1/models" &&
          !pathname.startsWith("/api/v1/model-registry/")) return false;
      void dispatch(request, response, url).catch((error: unknown) => {
        const failure = error instanceof HttpError
          ? error
          : new HttpError(500, "Settings service failed");
        send(response, failure.status, { detail: failure.message });
      });
      return true;
    },
  };
}
