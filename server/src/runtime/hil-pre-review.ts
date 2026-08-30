/**
 * LLM pre-review for HIL requests (大模型初审).
 *
 * ``hil_pre_review`` approval mode routes each HIL request through a text
 * chat-completion reviewer before parking it for a human: a ``pass`` verdict
 * resolves the request with the kind's affirmative decision (reviewer
 * ``model``); ``fail`` — or any transport/parsing error, treated as fail —
 * leaves the classic human-review flow untouched (fail-safe escalation).
 */
import type { HILApprovalMode, HILRequest } from "@biomed/contracts";

import type { BioMedModelConfig } from "../agent/contracts.js";
import { PublicHttpClient } from "../external/network/http-client.js";
import type { HILKind, HILReviewType } from "@biomed/contracts";
import { type HILApprovalPolicyStore } from "./hil-approval-store.js";

export interface HilModelReviewVerdict {
  verdict: "pass" | "fail";
  reason: string;
}

export interface HilModelReviewer {
  review(request: HILRequest): Promise<HilModelReviewVerdict>;
}

/** Pre-review seam consumed by ``DurableHILGate``; null disables pre-review. */
export interface HILGatePreReview {
  modeFor(kind: HILKind, reviewType: HILReviewType | null): Promise<HILApprovalMode>;
  /** Throws when the model cannot be consulted; the gate treats that as fail. */
  modelReview(request: HILRequest): Promise<HilModelReviewVerdict>;
}

const REVIEW_TIMEOUT_MS = 60_000;
const MAX_REASON_LENGTH = 500;

const SYSTEM_PROMPT = [
  "You are the first-pass reviewer in a human-in-the-loop data curation pipeline.",
  "Decide whether the proposed review batch can be accepted WITHOUT human review.",
  "Be strict: pass only when every item is clearly correct, internally consistent,",
  "and supported by its evidence. Fail the whole batch when any item is ambiguous,",
  "unsupported, low-confidence, contradicts the evidence, or has no proposed value.",
  "Also fail the batch when it proposes bypassing the system design — for example",
  "approving direct data writes through scripts or shell commands, writing into",
  "protected output paths or databases outside the deterministic pipeline, skipping",
  "validation gates, or content that contradicts the declared review_type/policy_ref.",
  'Respond with exactly one JSON object and nothing else: {"verdict":"pass" or "fail","reason":"<short justification>"}.',
].join(" ");

export function createHilModelReviewer(
  resolveModel: () => Promise<BioMedModelConfig>,
  httpClient?: PublicHttpClient,
): HilModelReviewer {
  return {
    review: async (request) => {
      const config = await resolveModel();
      const client = httpClient ?? new PublicHttpClient({ timeoutMs: REVIEW_TIMEOUT_MS });
      const endpoint = new URL(
        `${(config.baseUrl ?? "").replace(/\/+$/, "")}/chat/completions`,
      );
      const payload = JSON.stringify({
        model: config.modelId,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: JSON.stringify({
              kind: request.kind,
              review_type: request.review_type,
              policy_ref: request.policy_ref,
              summary: request.summary,
              items: request.review_items.map((item) => ({
                item_id: item.item_id,
                summary: item.summary,
                proposed_value: item.proposed_value,
                confidence_level: item.confidence_level,
                evidence: item.evidence,
              })),
            }),
          },
        ],
        temperature: 0,
      });
      const response = await client.request(endpoint.toString(), {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
        },
        body: payload,
        signal: AbortSignal.timeout(REVIEW_TIMEOUT_MS),
        validateRedirect: () => {
          throw new Error("model endpoint must not redirect");
        },
      });
      if (response.status < 200 || response.status >= 300) {
        await response.discard();
        throw new Error(`model pre-review call failed: HTTP ${response.status}`);
      }
      const chunks: Buffer[] = [];
      for await (const chunk of response.body) chunks.push(chunk as Buffer);
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch (error) {
        throw new Error("model pre-review returned a non-JSON HTTP body", { cause: error });
      }
      const content = (body as { choices?: Array<{ message?: { content?: unknown } }> })
        .choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.trim() === "") {
        throw new Error("model pre-review returned no textual content");
      }
      return parseVerdict(content);
    },
  };
}

export function parseVerdict(content: string): HilModelReviewVerdict {
  const fenced = content.replace(/```(?:json)?/gi, "");
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("model pre-review response contains no JSON object");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced.slice(start, end + 1));
  } catch (error) {
    throw new Error("model pre-review response is not valid JSON", { cause: error });
  }
  const obj = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
  if (obj === null || (obj["verdict"] !== "pass" && obj["verdict"] !== "fail")) {
    throw new Error('model pre-review verdict must be "pass" or "fail"');
  }
  const reason = typeof obj["reason"] === "string" ? obj["reason"].trim() : "";
  return {
    verdict: obj["verdict"],
    reason: reason.slice(0, MAX_REASON_LENGTH),
  };
}

/**
 * Assemble the gate seam from the shared policy store + active chat model.
 * Returns null when either piece is missing so the gate keeps the classic
 * human-only flow (production wiring passes both; tests may omit them).
 */
export function createHilGatePreReview(
  policyStore: HILApprovalPolicyStore | null,
  resolveModel: (() => Promise<BioMedModelConfig>) | null,
  httpClient?: PublicHttpClient,
): HILGatePreReview | null {
  if (policyStore === null) return null;
  const reviewer = resolveModel === null
    ? null
    : createHilModelReviewer(resolveModel, httpClient);
  return {
    modeFor: (kind, reviewType) => policyStore.modeFor(kind, reviewType),
    modelReview: async (request) => {
      if (reviewer === null) {
        return {
          verdict: "fail",
          reason: "llm_pre_review is configured but no chat model is available",
        };
      }
      return reviewer.review(request);
    },
  };
}
