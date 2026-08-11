import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import type { WorkspaceContext } from "./context.js";
import { WorkspacePolicyError } from "./types.js";

const READ_ROOTS = new Set([
  "source_assets",
  "parsed",
  "normalized",
  "staging",
  "artifacts",
  "state",
  "logs",
]);
const RESERVED_WINDOWS_NAME = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;
const STATE_READ_ALLOWLIST = new Set(["state/task_snapshot.json"]);

export interface ResolvedWorkspacePath {
  relativePath: string;
  absolutePath: string;
}

function platformName(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function normalizeAgentPath(input: string): string {
  if (typeof input !== "string" || input.length === 0 || input.includes("\0")) {
    throw new WorkspacePolicyError("INVALID_PATH", "Path must be a non-empty string");
  }
  const slashPath = input.replaceAll("\\", "/");
  if (
    slashPath.startsWith("/") ||
    slashPath.startsWith("//") ||
    /^[A-Za-z]:/.test(slashPath)
  ) {
    throw new WorkspacePolicyError("INVALID_PATH", "Absolute and device paths are forbidden");
  }
  const rawParts = slashPath.split("/");
  if (rawParts.some((part) => part === "..")) {
    throw new WorkspacePolicyError("INVALID_PATH", "Parent traversal is forbidden");
  }
  const parts = rawParts.filter((part) => part !== "" && part !== ".");
  if (parts.length === 0) {
    throw new WorkspacePolicyError("INVALID_PATH", "Path must identify a Task resource");
  }
  for (const part of parts) {
    if (part.endsWith(".") || part.endsWith(" ") || RESERVED_WINDOWS_NAME.test(part)) {
      throw new WorkspacePolicyError("INVALID_PATH", "Reserved path aliases are forbidden");
    }
  }
  return parts.join("/");
}

async function canonicalExistingAncestor(target: string): Promise<string> {
  let candidate = target;
  while (true) {
    try {
      await lstat(candidate);
      return realpath(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

async function ensureCanonicalContainment(
  context: WorkspaceContext,
  absolutePath: string,
): Promise<void> {
  let canonical: string;
  try {
    canonical = await canonicalExistingAncestor(absolutePath);
  } catch (error) {
    throw new WorkspacePolicyError("NOT_FOUND", "Workspace path does not exist", {
      cause: error,
    });
  }
  if (!isContained(context.canonicalRoot, canonical)) {
    throw new WorkspacePolicyError("PATH_ESCAPE", "Resolved path escapes Task Workspace");
  }
}

function allowsRead(relativePath: string, directoryContainer: boolean): boolean {
  const parts = relativePath.split("/");
  const top = platformName(parts[0] ?? "");
  if (!READ_ROOTS.has(top)) return false;
  if (top === "staging") {
    return platformName(parts[1] ?? "") === "agent";
  }
  if (top === "state") {
    if (directoryContainer && parts.length === 1) return true;
    const key = process.platform === "win32" ? relativePath.toLowerCase() : relativePath;
    return STATE_READ_ALLOWLIST.has(key);
  }
  return true;
}

export function isWorkspaceReadPathAllowed(
  relativePath: string,
  directoryContainer = false,
): boolean {
  return allowsRead(relativePath, directoryContainer);
}

function allowsWrite(relativePath: string): boolean {
  const parts = relativePath.split("/").map(platformName);
  return parts[0] === "staging" && parts[1] === "agent" && parts.length >= 3;
}

export async function resolveWorkspacePath(
  context: WorkspaceContext,
  input: string,
  operation: "read" | "write" | "container",
): Promise<ResolvedWorkspacePath> {
  const relativePath = normalizeAgentPath(input);
  const absolutePath = path.resolve(context.root, ...relativePath.split("/"));
  if (!isContained(context.root, absolutePath)) {
    throw new WorkspacePolicyError("PATH_ESCAPE", "Path escapes Task Workspace");
  }
  const allowed =
    operation === "write"
      ? allowsWrite(relativePath)
      : allowsRead(relativePath, operation === "container");
  if (!allowed) {
    throw new WorkspacePolicyError(
      "PATH_NOT_ALLOWED",
      `${operation === "write" ? "Write" : "Read"} is not allowed for this Task path`,
    );
  }
  await ensureCanonicalContainment(context, absolutePath);
  return { relativePath, absolutePath };
}

export async function verifyCanonicalPath(
  context: WorkspaceContext,
  absolutePath: string,
): Promise<void> {
  await ensureCanonicalContainment(context, absolutePath);
}
