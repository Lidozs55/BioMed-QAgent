import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_ROOT = path.resolve(SERVER_ROOT, "..");
const ACTIVE_SOURCE_ROOTS = [path.join(SERVER_ROOT, "src"), path.join(REPOSITORY_ROOT, "frontend", "src")];
const EXAMPLES_ROOT = path.join(REPOSITORY_ROOT, "examples");
const CODE_EXTENSIONS = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);

function removeComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

function importedSpecifiers(source: string): string[] {
  const code = removeComments(source);
  const specifiers: string[] = [];
  const staticImport = /\b(?:import|export)\s+(?:[^\n;]*?\s+from\s+)?["']([^"']+)["']/g;
  const dynamicImport = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  const requireCall = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const pattern of [staticImport, dynamicImport, requireCall]) {
    for (const match of code.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

function hasExampleImport(source: string): boolean {
  return importedSpecifiers(source).some((specifier) => /(?:^|[\\/])examples(?:[\\/]|$)/i.test(specifier));
}

function hasExampleFilesystemScan(source: string): boolean {
  const code = removeComments(source);
  return /\b(?:readdir(?:Sync)?|opendir(?:Sync)?|glob(?:Sync)?|readFile(?:Sync)?)\s*\([^;\n]*\bexamples(?:[\\/]|['"\s),])/i.test(code)
    || /\bpath\.(?:join|resolve)\s*\([^;\n]*["']examples["']/i.test(code);
}

function hasForbiddenExampleProductionUsage(source: string, sourcePath: string): boolean {
  const code = removeComments(source);
  const importsProductionTypes = /\b(?:import|export)\s+(?:type\s+)?(?:\{[^}]*\b(?:OperationResult(?:Manifest)?|PublicationCandidate|Publication)\b[^}]*\}|(?:OperationResult(?:Manifest)?|PublicationCandidate|Publication)\b)/.test(code);
  const importsProductionInternals = importedSpecifiers(code).some((specifier) => {
    const normalized = specifier.replaceAll("\\", "/");
    return /(?:^|\/)server\/src\/(?:dataset\/contracts\/(?:operation-result|publication-candidate)|dataset\/publish(?:\/|$))/i.test(normalized)
      || /@biomed\/server(?:\/|$)/i.test(normalized)
      || /(?:^|\/)(?:operation-result|publication-candidate|publisher)(?:\.[cm]?[jt]sx?)?$/i.test(normalized);
  });
  const constructsProductionResults = /\bnew\s+(?:OperationResult(?:Manifest)?|PublicationCandidate|Publication)\s*\(/.test(code);
  return importsProductionTypes || importsProductionInternals || (constructsProductionResults && CODE_EXTENSIONS.has(path.extname(sourcePath).toLowerCase()));
}

async function collectFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else if (CODE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(fullPath);
    }
  }
  await walk(root);
  return files;
}

async function scanRoots(roots: string[], check: (source: string, file: string) => boolean): Promise<string[]> {
  const violations: string[] = [];
  for (const root of roots) {
    for (const file of await collectFiles(root)) {
      if (check(await readFile(file, "utf8"), file)) violations.push(path.relative(REPOSITORY_ROOT, file));
    }
  }
  return violations;
}

describe("family examples isolation architecture guard", () => {
  test("active server and frontend sources do not import examples or scan them", async () => {
    const importViolations = await scanRoots(ACTIVE_SOURCE_ROOTS, (source) => hasExampleImport(source));
    const scanViolations = await scanRoots(ACTIVE_SOURCE_ROOTS, (source) => hasExampleFilesystemScan(source));
    expect(importViolations).toEqual([]);
    expect(scanViolations).toEqual([]);
  });

  test("examples cannot import or construct production result internals", async () => {
    const violations = await (async () => {
      try {
        return await scanRoots([EXAMPLES_ROOT], hasForbiddenExampleProductionUsage);
      } catch (error: unknown) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
        throw error;
      }
    })();
    expect(violations).toEqual([]);
  });

  test("matches real code imports while ignoring documentation JSON text", () => {
    expect(hasExampleImport("const note = '{\"import\": \"examples/families/gene-expression\"}';")).toBe(false);
    expect(hasExampleImport("import family from \"../examples/families/gene-expression/family-spec.example.json\";")).toBe(true);
    expect(hasExampleImport("const family = await import(\"../../examples/families/family\");")).toBe(true);
    expect(hasExampleFilesystemScan("const text = '{\"path\": \"examples/families\"}';")).toBe(false);
    expect(hasExampleFilesystemScan("await readdir(path.join(root, \"examples\", \"families\"));")).toBe(true);
    expect(hasForbiddenExampleProductionUsage("const note = '{\"type\": \"OperationResult\"}';", "README.md")).toBe(false);
    expect(hasForbiddenExampleProductionUsage("import type { OperationResult } from \"../../../server/src/dataset/contracts/operation-result.js\";", "transform.ts")).toBe(true);
    expect(hasForbiddenExampleProductionUsage("import type { OperationResultManifest } from \"@biomed/contracts\";", "transform.ts")).toBe(true);
    expect(hasForbiddenExampleProductionUsage("const result = new PublicationCandidate(input);", "transform.ts")).toBe(true);
  });
});
