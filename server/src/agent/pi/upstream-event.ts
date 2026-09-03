/**
 * Pi ``AgentSessionEvent`` → ``PiUpstreamEvent`` translation (the only place
 * raw Pi event shapes leak into the adapter's union type).
 */

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import { boundedText, toModelCallUsage } from "./bounded.js";
import type { PiUpstreamEvent } from "./types.js";

export function toUpstreamEvent(
  event: AgentSessionEvent,
  compactionTargetTokens?: number,
): PiUpstreamEvent {
  switch (event.type) {
    case "message_end":
      return {
        type: event.type,
        assistantStopReason:
          event.message.role === "assistant"
            ? event.message.stopReason
            : undefined,
        usage:
          event.message.role === "assistant"
            ? toModelCallUsage(event.message.usage)
            : undefined,
      };
    case "message_update":
      return {
        type: event.type,
        assistantMessageEvent: event.assistantMessageEvent,
      };
    case "tool_execution_start":
      return {
        type: event.type,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      };
    case "tool_execution_update":
      return {
        type: event.type,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        partialResult: event.partialResult,
      };
    case "tool_execution_end":
      return {
        type: event.type,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: event.result,
        isError: event.isError === true,
      };
    case "compaction_end":
      return {
        type: event.type,
        reason: event.reason,
        compactionResult:
          event.result === undefined
            ? undefined
            : {
                summary: event.result.summary,
                tokensBefore: event.result.tokensBefore,
                ...(event.result.estimatedTokensAfter === undefined
                  ? {}
                  : { estimatedTokensAfter: event.result.estimatedTokensAfter }),
                ...(compactionTargetTokens === undefined
                  ? {}
                  : { targetTokens: compactionTargetTokens }),
                ...(event.result.usage === undefined
                  ? {}
                  : { summaryTokens: event.result.usage.output }),
              },
        aborted: event.aborted,
        errorMessage:
          event.errorMessage === undefined
            ? undefined
            : boundedText(event.errorMessage),
        usage:
          event.result === undefined || event.result.usage === undefined
            ? undefined
            : toModelCallUsage(event.result.usage),
      };
    default:
      return { type: event.type };
  }
}
