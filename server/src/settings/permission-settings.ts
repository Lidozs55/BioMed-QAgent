/**
 * Agent permission settings — public surface (plan §35–§36).
 *
 * Routes:
 *
 * ```text
 * GET    /api/v1/settings/agent-permissions
 * PUT    /api/v1/settings/agent-permissions        { preset }
 * POST   /api/v1/settings/agent-permissions/rules  { capability, path, recursive, policy }
 * DELETE /api/v1/settings/agent-permissions/rules/{ruleId}
 * ```
 *
 * The same policy store instance is shared with the runtime brokers so rule
 * edits take effect immediately for every task.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { readJsonBody, type ApiSurface } from "../http/body.js";
import { sendJson } from "../http/response.js";
import type {
  FilePermissionRule,
  PermissionPreset,
} from "../agent/permissions/types.js";
import type { PermissionPolicyStore } from "../agent/permissions/policy-store.js";

const PRESETS: readonly PermissionPreset[] = ["restricted", "ask_when_needed", "full_access"];

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Request body must be an object");
  }
  return value as Record<string, unknown>;
}

function requiredString(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

export function createPermissionSettingsApi(
  policyStore: PermissionPolicyStore,
): ApiSurface {
  async function dispatch(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
  ): Promise<void> {
    if (pathname === "/api/v1/settings/agent-permissions") {
      if (request.method === "GET") {
        sendJson(response, 200, await policyStore.getSettings());
        return;
      }
      if (request.method === "PUT") {
        const body = asRecord(await readJsonBody(request));
        const preset = requiredString(body, "preset");
        if (!PRESETS.includes(preset as PermissionPreset)) {
          throw new TypeError("preset must be restricted, ask_when_needed, or full_access");
        }
        sendJson(response, 200, await policyStore.setPreset(preset as PermissionPreset));
        return;
      }
      sendJson(response, 405, { detail: "Method Not Allowed" });
      return;
    }
    if (pathname === "/api/v1/settings/agent-permissions/rules") {
      if (request.method === "POST") {
        const body = asRecord(await readJsonBody(request));
        const capability = requiredString(body, "capability");
        if (capability !== "fs.read" && capability !== "fs.write" && capability !== "fs.edit") {
          throw new TypeError("capability must be fs.read, fs.write, or fs.edit");
        }
        const pathValue = requiredString(body, "path");
        const policy = requiredString(body, "policy");
        if (policy !== "allow" && policy !== "ask" && policy !== "deny") {
          throw new TypeError("policy must be allow, ask, or deny");
        }
        const rule = await policyStore.addRule({
          capability,
          path: pathValue,
          recursive: body["recursive"] === true,
          policy,
        });
        const added = rule.rules.at(-1) as FilePermissionRule | undefined;
        sendJson(response, 201, { rule: added ?? null, settings: rule });
        return;
      }
      sendJson(response, 405, { detail: "Method Not Allowed" });
      return;
    }
    const ruleMatch = /^\/api\/v1\/settings\/agent-permissions\/rules\/([^/]+)$/.exec(pathname);
    if (request.method === "DELETE" && ruleMatch !== null) {
      const ruleId = decodeURIComponent(ruleMatch[1] ?? "");
      sendJson(response, 200, await policyStore.removeRule(ruleId));
      return;
    }
    throw new TypeError("Not Found");
  }

  return {
    handle(request, response) {
      const pathname = new URL(request.url ?? "/", "http://application-host").pathname;
      if (
        pathname !== "/api/v1/settings/agent-permissions" &&
        !pathname.startsWith("/api/v1/settings/agent-permissions/")
      ) {
        return false;
      }
      void dispatch(request, response, pathname).catch((error: unknown) => {
        const status = error instanceof TypeError ? 422 : 500;
        sendJson(response, status, { detail: (error as Error).message ?? "Permission settings failed" });
      });
      return true;
    },
  };
}
