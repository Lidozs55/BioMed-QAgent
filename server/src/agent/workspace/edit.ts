import { readFile } from "node:fs/promises";

import type { WorkspaceContext } from "./context.js";
import { resolveWorkspacePath } from "./path-policy.js";
import { WorkspacePolicyError, type WorkspaceEditResult } from "./types.js";
import { writeWorkspaceText } from "./write.js";

function countOccurrences(text: string, value: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const found = text.indexOf(value, offset);
    if (found === -1) return count;
    count += 1;
    offset = found + value.length;
  }
}
export async function editWorkspaceText(
  context: WorkspaceContext,
  input: {
    path: string;
    oldText: string;
    newText: string;
    expectedOccurrences: number;
  },
): Promise<WorkspaceEditResult> {
  if (
    typeof input.oldText !== "string" ||
    input.oldText.length === 0 ||
    typeof input.newText !== "string" ||
    !Number.isSafeInteger(input.expectedOccurrences) ||
    input.expectedOccurrences <= 0
  ) {
    throw new WorkspacePolicyError("PRECONDITION_FAILED", "Edit precondition is invalid");
  }
  const resolved = await resolveWorkspacePath(context, input.path);
  const bytes = await readFile(resolved.absolutePath);
  if (bytes.length > context.limits.maxWriteBytes) {
    throw new WorkspacePolicyError("LIMIT_EXCEEDED", "Edit target exceeds Workspace limit");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new WorkspacePolicyError("NOT_TEXT", "Edit target is not UTF-8 text", {
      cause: error,
    });
  }
  const occurrences = countOccurrences(text, input.oldText);
  if (occurrences !== input.expectedOccurrences) {
    throw new WorkspacePolicyError(
      "PRECONDITION_FAILED",
      `Edit expected ${input.expectedOccurrences} occurrence(s), found ${occurrences}`,
    );
  }
  const updated = text.split(input.oldText).join(input.newText);
  const result = await writeWorkspaceText(context, {
    path: resolved.relativePath,
    content: updated,
  });
  return { path: result.path, replacements: occurrences, bytes: result.bytes };
}
