/**
 * Qwen-VL client for the TS processing tier (Python ``agent_loop/vl_model.py``
 * parity): one-shot OpenAI-compatible ``chat.completions.create`` POST with a
 * base64 image_url content part through the P5-D1 ``PublicHttpClient`` (URL
 * policy + pinned DNS + redirect revalidation).
 *
 * Credentials come from injected config with ``DASHSCOPE_API_KEY`` /
 * ``DASHSCOPE_BASE_URL`` env fallbacks; the default model is
 * ``qwen-vl-max`` (Python ``VL_MODEL_NAME``).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import type { PublicHttpClient } from "../../external/network/http-client.js";
import { ChartExtractionError } from "./chart-json.js";

/** Visual model name (Python ``VL_MODEL_NAME``). */
export const VL_MODEL_NAME = "qwen-vl-max";

/** Default DashScope OpenAI-compatible base URL. */
export const DEFAULT_DASHSCOPE_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";

/** Hard cap on image bytes sent inline (DashScope ~10MB, Python parity). */
export const MAX_VLM_IMAGE_BYTES = 10 * 1024 * 1024;

/** Per-request timeout (Python ``call_vl_model`` default). */
export const VLM_TIMEOUT_MS = 60_000;

export interface VlmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

const SUPPORTED_IMAGE_MIMES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

function inferMime(filePath: string): string {
  return SUPPORTED_IMAGE_MIMES[path.extname(filePath).toLowerCase()] ?? "image/png";
}

/** Read an image and return its base64 payload (oversize → explicit error). */
export async function encodeImageBase64(filePath: string): Promise<string> {
  const raw = await readFile(filePath);
  if (raw.byteLength > MAX_VLM_IMAGE_BYTES) {
    throw new ChartExtractionError(
      `image ${filePath} is ${raw.byteLength} bytes (> ${MAX_VLM_IMAGE_BYTES}) ` +
        "and no downsampling backend is available (spike degradation D3: the TS tier " +
        "does not ship Pillow-style resize; re-capture the figure at lower resolution)",
    );
  }
  return raw.toString("base64");
}

export interface VlmClient {
  call(imagePath: string, prompt: string, signal?: AbortSignal): Promise<string>;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
}

/**
 * Build a VLM client. ``resolveVlmConfig`` fills env fallbacks; the caller
 * may inject a pre-configured ``PublicHttpClient`` (fixture servers use the
 * fake-resolver + local-executor pattern, see tests/phase5/helpers.ts).
 */
export function createVlmClient(
  config: VlmConfig,
  httpClient: PublicHttpClient,
): VlmClient {
  return {
    call: async (imagePath, prompt, signal) => {
      if (config.apiKey.trim() === "") {
        throw new ChartExtractionError(
          "DASHSCOPE_API_KEY (VLM credential) is missing; cannot call qwen-vl-max",
        );
      }
      const mime = inferMime(imagePath);
      const base64 = await encodeImageBase64(imagePath);
      const endpoint = new URL(`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`);
      const payload = JSON.stringify({
        model: config.model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } },
            ],
          },
        ],
        temperature: 0.1,
      });
      const response = await httpClient.request(endpoint.toString(), {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
        },
        body: payload,
        signal: AbortSignal.any([
          signal ?? new AbortController().signal,
          AbortSignal.timeout(httpClient.timeoutMs ?? VLM_TIMEOUT_MS),
        ]),
        validateRedirect: () => {
          throw new Error("VLM endpoint must not redirect");
        },
      });
      if (response.status < 200 || response.status >= 300) {
        await response.discard();
        throw new ChartExtractionError(
          `qwen-vl-max call failed for ${imagePath}: HTTP ${response.status}`,
        );
      }
      const chunks: Buffer[] = [];
      for await (const chunk of response.body) chunks.push(chunk as Buffer);
      let parsed: ChatCompletionResponse;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatCompletionResponse;
      } catch (error) {
        throw new ChartExtractionError(
          `qwen-vl-max returned non-JSON HTTP body for ${imagePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const content = parsed.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content === "") {
        throw new ChartExtractionError(`qwen-vl-max returned empty content for ${imagePath}`);
      }
      return content;
    },
  };
}
