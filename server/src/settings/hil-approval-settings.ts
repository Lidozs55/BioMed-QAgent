/**
 * HIL approval settings — public surface.
 *
 * ```text
 * GET /api/v1/settings/hil-approval
 * PUT /api/v1/settings/hil-approval   { default_mode?, review_modes? }
 * ```
 *
 * ``review_modes`` assigns one of three approval tiers per scope
 * (``permission`` plus every HIL review type): ``human_review`` (classic
 * human approval), ``llm_pre_review`` (model reviews first, only failures
 * reach a human), ``auto_approve`` (no review). Scopes omitted from the map
 * fall back to ``default_mode``. Human-mandatory scopes (publication
 * boundary) reject non-human modes.
 */
import { readJsonBody, type ApiSurface } from "../http/body.js";
import { sendJson } from "../http/response.js";
import {
  HIL_APPROVAL_MODES,
  HIL_APPROVAL_SCOPES,
  type HILApprovalMode,
  type HILApprovalScope,
} from "@biomed/contracts";

import {
  type HilApprovalSettingsPatch,
  type HILApprovalPolicyStore,
} from "../runtime/hil-approval-store.js";

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Request body must be an object");
  }
  return value as Record<string, unknown>;
}

function approvalMode(value: unknown, name: string): HILApprovalMode {
  if (typeof value !== "string" || !(HIL_APPROVAL_MODES as readonly string[]).includes(value)) {
    throw new TypeError(`${name} must be one of ${HIL_APPROVAL_MODES.join(", ")}`);
  }
  return value as HILApprovalMode;
}

export function createHilApprovalSettingsApi(
  policyStore: HILApprovalPolicyStore,
): ApiSurface {
  return {
    handle(request, response) {
      const pathname = new URL(request.url ?? "/", "http://application-host").pathname;
      if (pathname !== "/api/v1/settings/hil-approval") return false;
      void (async () => {
        if (request.method === "GET") {
          sendJson(response, 200, await policyStore.getSettings());
          return;
        }
        if (request.method === "PUT") {
          const body = asRecord(await readJsonBody(request));
          const patch: HilApprovalSettingsPatch = {};
          if (body["default_mode"] !== undefined) {
            patch.default_mode = approvalMode(body["default_mode"], "default_mode");
          }
          if (body["review_modes"] !== undefined) {
            const rawModes = asRecord(body["review_modes"]);
            const reviewModes: Partial<Record<HILApprovalScope, HILApprovalMode>> = {};
            for (const [scope, mode] of Object.entries(rawModes)) {
              if (!(HIL_APPROVAL_SCOPES as readonly string[]).includes(scope)) {
                throw new TypeError(`review_modes key '${scope}' is not a HIL approval scope`);
              }
              reviewModes[scope as HILApprovalScope] =
                mode === null ? undefined : approvalMode(mode, `review_modes.${scope}`);
            }
            patch.review_modes = reviewModes;
          }
          sendJson(response, 200, await policyStore.setSettings(patch));
          return;
        }
        sendJson(response, 405, { detail: "Method Not Allowed" });
      })().catch((error: unknown) => {
        const status = error instanceof TypeError ? 422 : 500;
        sendJson(response, status, {
          detail: (error as Error).message ?? "HIL approval settings failed",
        });
      });
      return true;
    },
  };
}
