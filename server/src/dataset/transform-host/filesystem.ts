import type { Stats } from "node:fs";
import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { TransformHostError } from "./errors.js";

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export interface FileSystemIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly birthtimeMs: number;
}

export interface SecureFilePath {
  readonly rootPath: string;
  readonly absolutePath: string;
  readonly metadata: Stats;
  readonly rootIdentity: FileSystemIdentity;
}

export async function ensureSecureDirectory(root: string): Promise<FileSystemIdentity> {
  const resolved = path.resolve(root);
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  return inspectSecureDirectory(resolved);
}

export async function inspectSecureDirectory(root: string): Promise<FileSystemIdentity> {
  const resolved = path.resolve(root);
  const base = path.basename(resolved);
  if (base.length > 0) {
    assertPortablePathSegment(base, "directory name");
    await assertNoCaseCollision(path.dirname(resolved), base);
  }
  const metadata = await lstat(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw violation("Host root must be a real directory, not a symlink or junction");
  }
  const canonical = await realpath(resolved);
  if (!sameCanonicalPath(canonical, resolved)) {
    throw violation("Host root contains a symlink or junction alias");
  }
  await assertNoDirectoryCaseCollisions(resolved);
  return identityOf(metadata);
}

export async function inspectSecureFileUnderRoot(
  root: string,
  relativePath: string,
): Promise<SecureFilePath> {
  const rootPath = path.resolve(root);
  const rootIdentity = await inspectSecureDirectory(rootPath);
  const segments = validatePortableRelativePath(relativePath);
  let current = rootPath;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    await assertNoDirectoryCaseCollisions(current);
    await assertNoCaseCollision(current, segment);
    current = path.join(current, segment);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      throw violation(`Path component ${segment} is a symlink or junction`);
    }
    const canonical = await realpath(current);
    if (!sameCanonicalPath(canonical, current)) {
      throw violation(`Path component ${segment} resolves through a symlink or junction`);
    }
    if (index < segments.length - 1) {
      if (!metadata.isDirectory()) throw violation(`Path parent ${segment} is not a directory`);
      continue;
    }
    if (!metadata.isFile()) throw violation("Registered input must be a regular file");
    if (metadata.nlink > 1) throw violation("Registered input hardlinks are forbidden");
    await assertDirectoryIdentity(rootPath, rootIdentity);
    return { rootPath, absolutePath: current, metadata, rootIdentity };
  }
  throw violation("Registered input path must identify a file");
}

export async function assertDirectoryIdentity(
  directory: string,
  expected: FileSystemIdentity,
): Promise<void> {
  const current = await lstat(directory);
  if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(identityOf(current), expected)) {
    throw violation("Host root identity changed after validation");
  }
  const canonical = await realpath(directory);
  if (!sameCanonicalPath(canonical, path.resolve(directory))) {
    throw violation("Host root was replaced by a symlink or junction");
  }
}

export function assertPortablePathSegment(value: string, label: string): void {
  if (
    value.length === 0
    || value === "."
    || value === ".."
    || value.endsWith(".")
    || value.endsWith(" ")
    || value.includes(":")
    || value.includes("/")
    || value.includes("\\")
    || WINDOWS_RESERVED.test(value)
  ) {
    throw violation(`${label} is not a portable, unambiguous file name`);
  }
}

export function identityOf(metadata: Stats): FileSystemIdentity {
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    birthtimeMs: metadata.birthtimeMs,
  };
}

export function sameIdentity(left: FileSystemIdentity, right: FileSystemIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeMs === right.birthtimeMs;
}

export function sameCanonicalPath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.normalize(value).replace(/^\\\\\?\\/, "");
    return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
  };
  return normalize(left) === normalize(right);
}

async function assertNoCaseCollision(parent: string, requested: string): Promise<void> {
  const folded = requested.toLocaleLowerCase("en-US");
  const matches = (await readdir(parent)).filter(
    (entry) => entry.toLocaleLowerCase("en-US") === folded,
  );
  if (matches.length !== 1 || matches[0] !== requested) {
    throw violation(`Path component ${requested} has a missing or case-colliding directory entry`);
  }
}

async function assertNoDirectoryCaseCollisions(directory: string): Promise<void> {
  const seen = new Set<string>();
  for (const entry of await readdir(directory)) {
    assertPortablePathSegment(entry, "directory entry");
    const folded = entry.toLocaleLowerCase("en-US");
    if (seen.has(folded)) {
      throw violation(`Directory ${path.basename(directory)} contains case-colliding entries`);
    }
    seen.add(folded);
  }
}

function validatePortableRelativePath(relativePath: string): string[] {
  if (path.isAbsolute(relativePath) || relativePath.length === 0) {
    throw violation("Registered input path must be a non-empty relative path");
  }
  const segments = relativePath.split(/[\\/]/u);
  for (const segment of segments) assertPortablePathSegment(segment, "input path component");
  return segments;
}

function violation(message: string): TransformHostError {
  return new TransformHostError("quarantine_violation", message);
}
