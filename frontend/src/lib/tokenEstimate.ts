/**
 * Frontend-side token usage estimation from conversation items.
 *
 * The backend does not currently emit per-turn token usage events,
 * so we estimate based on character count of conversation content
 * plus fixed overhead (system prompt + tool schemas).
 *
 * Key heuristics:
 * - Mixed CJK/English text: ~2 characters per token (Chinese chars are
 *   typically 1-2 tokens each, English ~4 chars/token; blended ~2)
 * - Fixed overhead per request: system prompt (~1500 tokens) +
 *   8 tool JSON schemas (~3500 tokens) ≈ 5000 tokens baseline
 * - Message wrapper overhead: ~20% on top of content tokens
 */

import type { ConversationItem } from "@/runtime/types";

/** Blended chars-per-token for mixed CJK/English biomedical text. */
const CHARS_PER_TOKEN = 2;

/**
 * Fixed token overhead sent with every API request regardless of
 * conversation length: system prompt (INSTRUCTIONS ~2870 chars) +
 * serialized tool schemas for 8 tools (~14KB source → ~3500 tokens).
 */
const FIXED_OVERHEAD_TOKENS = 5_000;

/** Estimate total tokens consumed by a list of conversation items. */
export function estimateContextTokens(items: ConversationItem[]): number {
  let chars = 0;
  for (const item of items) {
    switch (item.kind) {
      case "user_message":
        chars += item.content.length;
        break;
      case "assistant_segment":
        chars += item.content.length;
        break;
      case "reasoning":
        chars += item.content.length;
        break;
      case "tool_call":
        // Tool name + arguments + output all consume context
        chars += item.toolName.length;
        if (item.arguments) chars += JSON.stringify(item.arguments).length;
        if (item.output) chars += item.output.length;
        break;
      case "warning":
        chars += item.message.length;
        break;
      default:
        // stage, progress, artifact — negligible token cost
        break;
    }
  }
  // Content tokens with 20% message-wrapper overhead + fixed baseline
  const contentTokens = Math.ceil((chars / CHARS_PER_TOKEN) * 1.2);
  return FIXED_OVERHEAD_TOKENS + contentTokens;
}
