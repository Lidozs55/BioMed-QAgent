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

/**
 * Canonicalize a target path through its nearest existing ancestor, then
 * re-append the missing suffix.
 *
 * ``realpath`` requires the path to exist; for a not-yet-created target
 * (typical for writes) we walk up to the nearest existing ancestor, resolve
 * it, and glue the remaining (missing) segments back on. Without the
 * re-append step, ``D:\datasets\new-project\result.csv`` would collapse to
 * ``D:\datasets`` and a later "always allow this directory" grant would
 * silently cover ``D:\datasets\**`` — an unintended privilege expansion
 * (audit fix).
 */
export async function canonicalizeWithAncestor(target: string): Promise<string> {
  const walk: string[] = [];
  let candidate = target;
  for (;;) {
    try {
      const canonicalAncestor = await realpath(candidate);
      if (walk.length === 0) return canonicalAncestor;
      const suffix = walk.reverse().map((segment) => path.basename(segment));
      return path.join(canonicalAncestor, ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      walk.push(candidate);
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
    // Relative paths are anchored at the workspace but may freely escape it:
    // ``../outside/file.txt`` resolves to an absolute path and then flows
    // through scope classification + PermissionBroker like any other path
    // (ADR-026 §2) — an escape is a scope decision, not an input error.
    const anchored = path.resolve(anchor, raw);
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
