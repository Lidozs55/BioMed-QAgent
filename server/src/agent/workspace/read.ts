import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";

import type { WorkspaceContext } from "./context.js";
import { resolveAgentPath } from "./path-policy.js";
import {
  WorkspacePolicyError,
  type WorkspaceListEntry,
  type WorkspaceListResult,
  type WorkspaceReadResult,
  type WorkspaceSearchResult,
} from "./types.js";

function decodeUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new WorkspacePolicyError("NOT_TEXT", "Workspace file is not valid UTF-8 text", {
      cause: error,
    });
  }
}

export async function readWorkspaceText(
  context: WorkspaceContext,
  input: { path: string; offset?: number; length?: number },
): Promise<WorkspaceReadResult> {
  const resolved = await resolveAgentPath(context, input.path, "fs.read");
  const offset = input.offset ?? 0;
  const length = input.length ?? context.limits.maxReadCharacters;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0) {
    throw new WorkspacePolicyError("LIMIT_EXCEEDED", "Read offset and length are invalid");
  }
  // IO follows the requested path (symlinks included); the permission check
  // above already classified the canonical target.
  const handle = await open(resolved.absolutePath, "r");
  try {
    const buffer = Buffer.alloc(context.limits.maxReadBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const byteTruncated = bytesRead > context.limits.maxReadBytes;
    const text = decodeUtf8(buffer.subarray(0, Math.min(bytesRead, context.limits.maxReadBytes)));
    const selected = text.slice(offset, offset + Math.min(length, context.limits.maxReadCharacters));
    return {
      path: resolved.displayPath,
      text: selected,
      offset,
      characters: selected.length,
      truncated:
        byteTruncated ||
        offset + selected.length < text.length ||
        length > context.limits.maxReadCharacters,
    };
  } finally {
    await handle.close();
  }
}

export async function listWorkspace(
  context: WorkspaceContext,
  input: { path: string; depth?: number },
): Promise<WorkspaceListResult> {
  const resolved = await resolveAgentPath(context, input.path, "fs.read");
  const requestedDepth = input.depth ?? 1;
  if (!Number.isSafeInteger(requestedDepth) || requestedDepth <= 0) {
    throw new WorkspacePolicyError("LIMIT_EXCEEDED", "List depth is invalid");
  }
  const maxDepth = Math.min(requestedDepth, context.limits.maxListDepth);
  const entries: WorkspaceListEntry[] = [];
  let truncated = requestedDepth > maxDepth;

  async function visit(directory: string, relativeDirectory: string, depth: number): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const child of children) {
      if (entries.length >= context.limits.maxListEntries) {
        truncated = true;
        return;
      }
      const childAbsolute = path.join(directory, child.name);
      const childRelative = (relativeDirectory === ""
        ? child.name
        : `${relativeDirectory}/${child.name}`).replaceAll("\\", "/");
      if (child.isSymbolicLink()) {
        // Links are listed but never followed into another scope; reads
        // through them go through the permission system.
        entries.push({ path: childRelative, type: "link" });
        continue;
      }
      const info = await lstat(childAbsolute);
      entries.push({
        path: childRelative,
        type: info.isDirectory() ? "directory" : "file",
        ...(info.isFile() ? { size: info.size } : {}),
      });
      if (info.isDirectory() && depth < maxDepth) {
        await visit(childAbsolute, childRelative, depth + 1);
      }
    }
  }

  await visit(resolved.absolutePath, resolved.displayPath, 1);
  return { path: resolved.displayPath, entries, truncated };
}

export async function searchWorkspace(
  context: WorkspaceContext,
  input: { path: string; query: string },
): Promise<WorkspaceSearchResult> {
  if (typeof input.query !== "string" || input.query.length === 0 || input.query.length > 1_000) {
    throw new WorkspacePolicyError("LIMIT_EXCEEDED", "Search query is invalid");
  }
  const resolved = await resolveAgentPath(context, input.path, "fs.read");
  const files: Array<{ absolute: string; relative: string }> = [];
  let truncated = false;

  async function collect(directory: string, relativeDirectory: string, depth: number): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const child of children) {
      if (files.length >= context.limits.maxSearchFiles) {
        truncated = true;
        return;
      }
      if (child.isSymbolicLink()) continue;
      const absolute = path.join(directory, child.name);
      const relative = (relativeDirectory === ""
        ? child.name
        : `${relativeDirectory}/${child.name}`).replaceAll("\\", "/");
      if (child.isDirectory() && depth < context.limits.maxListDepth) {
        await collect(absolute, relative, depth + 1);
      } else if (child.isFile()) {
        files.push({ absolute, relative });
      }
    }
  }

  await collect(resolved.absolutePath, resolved.displayPath, 1);
  const matches: WorkspaceSearchResult["matches"] = [];
  let outputCharacters = 0;
  for (const file of files) {
    const handle = await open(file.absolute, "r");
    const buffer = Buffer.alloc(context.limits.maxSearchFileBytes + 1);
    let bytesRead: number;
    try {
      ({ bytesRead } = await handle.read(buffer, 0, buffer.length, 0));
    } finally {
      await handle.close();
    }
    if (bytesRead > context.limits.maxSearchFileBytes) {
      truncated = true;
      continue;
    }
    const bytes = buffer.subarray(0, bytesRead);
    let text: string;
    try {
      text = decodeUtf8(bytes);
    } catch (error) {
      if (error instanceof WorkspacePolicyError && error.code === "NOT_TEXT") continue;
      throw error;
    }
    for (const [index, line] of text.split(/\r?\n/u).entries()) {
      if (!line.includes(input.query)) continue;
      const bounded = line.slice(0, context.limits.maxSearchLineChars);
      if (
        matches.length >= context.limits.maxSearchResults ||
        outputCharacters + bounded.length > context.limits.maxSearchOutputChars
      ) {
        truncated = true;
        break;
      }
      matches.push({ path: file.relative, line: index + 1, text: bounded });
      outputCharacters += bounded.length;
      if (bounded.length < line.length) truncated = true;
      if (matches.length >= context.limits.maxSearchResults) truncated = true;
    }
    if (matches.length >= context.limits.maxSearchResults) break;
  }
  return {
    path: resolved.displayPath,
    query: input.query,
    matches,
    filesScanned: files.length,
    truncated,
  };
}
