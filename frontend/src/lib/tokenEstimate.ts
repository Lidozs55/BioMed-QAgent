/**
 * Frontend-side token usage estimation from conversation items.
 *
 * The backend does not currently emit per-turn token usage events,
 * so we estimate based on character count of conversation content.
 * Heuristic: ~4 characters per token for mixed CJK/English text.
 */

import type { ConversationItem } from "@/runtime/types";

const CHARS_PER_TOKEN = 4;

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
  // Add ~15% overhead for message wrappers, system prompt, tool schemas
  return Math.ceil((chars / CHARS_PER_TOKEN) * 1.15);
}
