/**
 * Tool-free one-shot model turns for control-plane workflows (skill
 * self-iteration), reusing the upstream-session factory while keeping
 * Pi/model-provider details inside the adapter boundary.
 */

import type { BioMedModelConfig } from "../contracts.js";
import {
  MAX_STALLED_LENGTH_CONTINUATIONS,
  MIN_PROGRESS_CHARS,
} from "./bounded.js";
import { createRealUpstreamSession } from "./upstream-session.js";

export interface OneShotTextGenerationInput {
  model: BioMedModelConfig;
  systemPrompt: string;
  prompt: string;
  cwd: string;
  signal?: AbortSignal;
}

export async function generateOneShotText(
  input: OneShotTextGenerationInput,
): Promise<string> {
  if (input.systemPrompt.trim() === "" || input.prompt.trim() === "") {
    throw new TypeError("One-shot model prompts must not be empty");
  }
  const upstream = await createRealUpstreamSession({
    taskId: "skill_iteration",
    runId: "run_skill_iteration",
    cwd: input.cwd,
    model: input.model,
    systemPrompt: input.systemPrompt,
    skillRoots: [],
    resourceRoots: [],
    tools: [],
  });
  let output = "";
  let reasoningChars = 0;
  let lengthContinuationStalls = 0;
  let stopReason: string | undefined;
  const unsubscribe = upstream.subscribe((event) => {
    const message = event.assistantMessageEvent;
    if (event.type === "message_update" && message?.type === "text_delta") {
      output += message.delta ?? "";
      if (output.length > 100_000) void upstream.abort();
    } else if (event.type === "message_update" && message?.type === "thinking_delta") {
      reasoningChars += (message.delta ?? "").length;
    } else if (event.type === "message_end") {
      stopReason = event.assistantStopReason;
    }
  });
  const abort = (): void => {
    void upstream.abort();
  };
  const isAborted = (): boolean => input.signal?.aborted === true;
  input.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (isAborted()) throw new Error("Model generation was cancelled");
    await upstream.prompt(input.prompt);
    while (stopReason === "length") {
      if (upstream.continueAfterLength === undefined) {
        throw new Error("Model generation was truncated");
      }
      const beforeOutput = output.length;
      const beforeReasoning = reasoningChars;
      stopReason = undefined;
      await upstream.continueAfterLength();
      const madeProgress =
        output.length > beforeOutput ||
        reasoningChars - beforeReasoning >= MIN_PROGRESS_CHARS;
      if (!madeProgress) {
        lengthContinuationStalls += 1;
        if (lengthContinuationStalls >= MAX_STALLED_LENGTH_CONTINUATIONS) {
          throw new Error("Model length continuation made no meaningful progress");
        }
      } else {
        lengthContinuationStalls = 0;
      }
    }
    if (isAborted()) throw new Error("Model generation was cancelled");
    if (stopReason === "error") throw new Error("Model generation failed upstream");
    if (output.length > 100_000) throw new Error("Model generation exceeded the output limit");
    if (output.trim() === "") throw new Error("Model generation returned no text");
    return output;
  } finally {
    input.signal?.removeEventListener("abort", abort);
    unsubscribe();
    upstream.dispose();
  }
}
