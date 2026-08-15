import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

/**
 * Unified path normalization (plan §13–§14).
 *
 * All file tools accept relative and absolute paths:
 *
 * - relative paths are anchored at the current task workspace;
 * - absolute paths enter the normalizer instead of being rejected.
 *
 * Comparison must canonicalize first: a naive
 * ``requestedPath.startsWith(workspace)`` misjudges ``C:\work`` vs
 * ``C:\workspace-evil`` and misses junctions/symlinks on Windows.
 */

export interface NormalizedPath {
  /** Canonical absolute path (realpath of the nearest existing ancestor). */
  canonical: string;
  /** Original absolute path before canonicalization. */
  absolute: string;
  /** True when the requested path itself already exists. */
  exists: boolean;
}

export class PathNormalizationError extends Error {
  constructor(
    readonly code: "INVALID" | "NOT_FOUND",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PathNormalizationError";
  }
}

const RESERVED_WINDOWS_NAME = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Walk up from a target until an existing ancestor is found and canonicalize it. */
export async function canonicalizeWithAncestor(target: string): Promise<string> {
  let candidate = target;
  for (;;) {
    try {
      await lstat(candidate);
      return await realpath(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

function rejectUnsafe(raw: string, anchor: string): string {
  if (raw.includes("\0")) {
    throw new PathNormalizationError("INVALID", "Path must not contain NUL bytes");
  }
  if (!path.isAbsolute(raw)) {
    if (/^[A-Za-z]:[^\\/]/.test(raw)) {
      throw new PathNormalizationError("INVALID", "Drive-relative paths are ambiguous");
    }
    const anchored = path.resolve(anchor, raw);
    if (!isPathWithin(path.resolve(anchor), anchored)) {
      throw new PathNormalizationError("INVALID", "Relative path escapes the workspace");
    }
    const parts = anchored.split(/[\\/]+/).filter((part) => part !== "");
    for (const part of parts) {
      if (part.endsWith(".") || part.endsWith(" ") || RESERVED_WINDOWS_NAME.test(part)) {
        throw new PathNormalizationError("INVALID", "Reserved path aliases are forbidden");
      }
    }
    return anchored;
  }
  const normalized = path.normalize(raw);
  const parts = normalized.split(/[\\/]+/).filter((part) => part !== "");
  for (const part of parts) {
    if (part.endsWith(".") || part.endsWith(" ") || RESERVED_WINDOWS_NAME.test(part)) {
      throw new PathNormalizationError("INVALID", "Reserved path aliases are forbidden");
    }
  }
  return normalized;
}

/**
 * Normalize an input path (relative → workspace-anchored; absolute → as-is),
 * then canonicalize it through its nearest existing ancestor.
 */
export async function normalizeAgentPathFor(
  input: string,
  workspaceAnchor: string,
): Promise<NormalizedPath> {
  if (typeof input !== "string" || input.length === 0) {
    throw new PathNormalizationError("INVALID", "Path must be a non-empty string");
  }
  const absolute = rejectUnsafe(input.replaceAll("\\", "/"), workspaceAnchor);
  const canonical = await canonicalizeWithAncestor(absolute);
  const exists = await lstat(absolute).then(
    () => true,
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    },
  );
  return { canonical, absolute, exists };
}

/** Pure containment check on already-canonical paths. */
export function canonicalIsWithin(root: string, candidate: string): boolean {
  return isPathWithin(path.resolve(root), path.resolve(candidate));
}
