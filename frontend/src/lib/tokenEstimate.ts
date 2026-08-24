/**
 * Frontend-side token usage estimation from conversation items.
 *
 * This fallback is used only before the Pi runtime reports authoritative
 * context usage. It intentionally estimates the retained conversation rather
 * than guessing provider-specific system prompts and tool serialization.
 *
 * Mixed CJK/English text is approximated at ~2 characters per token, with a
 * 20% message-wrapper allowance.
 */

import type { ConversationItem } from "@/runtime/types";

/** Blended chars-per-token for mixed CJK/English biomedical text. */
const CHARS_PER_TOKEN = 2;

/**
 * The UI cannot know the provider's system prompt/tool serialization. The
 * runtime reports the authoritative Pi context usage when available, so the
 * fallback intentionally estimates conversation content only.
 */
const FIXED_OVERHEAD_TOKENS = 0;

/** Estimate total tokens consumed by a list of conversation items. */
export function estimateContextTokens(
  items: readonly ConversationItem[],
  afterSequence = 0,
): number {
  let chars = 0;
  for (const item of items) {
    if (item.sequence <= afterSequence) continue;
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
