/**
 * Family-Host architecture guard (family-host/05 §7, family-host/07 §5.9).
 *
 * Static scan proving the generic Dataset Core stays family/provider-agnostic.
 * The family-host plan retires per-family static dispatch: generic Core modules
 * (runtime, integrator, validation, publish, assessment, derive, confidence,
 * compat, canonicalizer, review, schema, service, ...) must not grow new
 * `family.id === ...` branches, switch-on-family/provider-id dispatch, or direct
 * imports of individual `families/<family>/*` modules.
 *
 * Scan scope is deliberately limited so the guard stays robust:
 *   - `families/**` is the family modules themselves (their own files naturally
 *     contain family definitions and registry wiring) and is never scanned.
 *   - a tiny explicit allowlist covers the legacy "registered multi-table"
 *     static compatibility facade that family-host/07 migrates to retrieval
 *     examples; those are the only files where generic Core may still hold
 *     family/provider-specific dispatch today. The allowlist is file-level and
 *     explicit (no fragile per-reference regex allowlist).
 *   - comments/doc strings are stripped before dispatch matching, so a comment
 *     mentioning a forbidden shape never trips the guard.
 *
 * Only `server/src/dataset` is inspected; docs/ and examples/ are out of scope.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const SERVER_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const DATASET_SRC = path.join(SERVER_SRC, "dataset");

/**
 * Legacy "registered multi-table" static compatibility facade (family-host/07).
 * These are the only files where generic Core may still hold family/provider
 * dispatch today; the plan retires them capability-by-capability before legacy
 * is removed. Kept to the current minimum.
 */
// Keys use forward slashes to match the normalized relative path from
// path.relative(...).replace(/\\/g, "/") on every platform.
const STATIC_COMPATIBILITY_FACADE = new Set([
  "runtime/registered-multitable.ts",
  "assembly/registered-multitable.ts",
  "adapters/registered/default-registry.ts",
]);

/** Dispatch signals that generic Core modules must not grow. */
const DISPATCH_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\bfamily\.id\s*(?:===|!==)/, "family.id equality branch"],
  [/switch\s*\(\s*(?:family|provider)\w*(?:\.\w+)?\s*\)/, "switch on family/provider id"],
  [/\bfamilyId\s*(?:===|!==)\s*["']/, "familyId string-literal dispatch"],
  [/\bproviderId\s*(?:===|!==)\s*["']/, "providerId string-literal dispatch"],
];

/** Import specifiers that appear in `from "…"` / `import("…")` / `require("…")`. */
const IMPORT_SPECIFIER_RE = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)(["'])([^"']+)\1/g;

interface Violation {
  file: string;
  label: string;
}

/**
 * Remove line and block comments, preserving string literals and newlines.
 * String literals are kept verbatim so dispatch inside real code is never
 * masked by template-literal desync; comments are stripped so doc strings can
 * never trip the guard.
 */
function stripComments(text: string): string {
  let out = "";
  let index = 0;
  let inBlock = false;
  let inLine = false;
  let inString: string | null = null;
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    if (inBlock) {
      if (char === "*" && next === "/") {
        inBlock = false;
        out += "  ";
        index += 2;
      } else {
        out += char === "\n" ? "\n" : " ";
        index += 1;
      }
      continue;
    }
    if (inLine) {
      if (char === "\n") {
        inLine = false;
        out += "\n";
        index += 1;
      } else {
        out += " ";
        index += 1;
      }
      continue;
    }
    if (inString !== null) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        index += 2;
      } else {
        if (char === inString) inString = null;
        index += 1;
      }
      continue;
    }
    if (char === "/" && next === "*") {
      inBlock = true;
      out += "  ";
      index += 2;
      continue;
    }
    if (char === "/" && next === "/") {
      inLine = true;
      out += "  ";
      index += 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      inString = char;
    }
    out += char;
    index += 1;
  }
  return out;
}

/**
 * A `families/…` import is forbidden only when it points at an individual family
 * module. The registry barrel (`families/index`, `families/registry`) is the
 * intended composition root and stays allowed.
 */
function isForbiddenFamilyImport(specifier: string): boolean {
  const match = /\bfamilies\/(.+)$/.exec(specifier);
  if (match === null) return false;
  const rest = match[1].replace(/\.js$/, "");
  return rest !== "index" && rest !== "registry";
}

/** Scan one module for family/provider-specific dispatch in generic Core. */
function scanModule(relativePath: string, text: string): Violation[] {
  const violations: Violation[] = [];
  const code = stripComments(text);
  for (const [pattern, label] of DISPATCH_PATTERNS) {
    if (pattern.test(code)) violations.push({ file: relativePath, label });
  }
  for (const match of text.matchAll(IMPORT_SPECIFIER_RE)) {
    const specifier = match[2];
    if (specifier !== undefined && isForbiddenFamilyImport(specifier)) {
      violations.push({ file: relativePath, label: `direct family submodule import (${specifier})` });
    }
  }
  return violations;
}

/** All `.ts` files under `server/src/dataset` that must stay generic, skipping
 * the `families/` tree and the legacy static compatibility facade. */
async function collectGenericCoreSources(): Promise<string[]> {
  const sources: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "families") continue;
        await walk(full);
      } else if (entry.name.endsWith(".ts")) {
        const relative = path.relative(DATASET_SRC, full).replace(/\\/g, "/");
        if (STATIC_COMPATIBILITY_FACADE.has(relative)) continue;
        sources.push(full);
      }
    }
  }
  await walk(DATASET_SRC);
  return sources;
}

describe("family-host generic Core boundary", () => {
  test("generic Core modules contain no family/provider-specific dispatch", async () => {
    const sources = await collectGenericCoreSources();
    expect(sources.length).toBeGreaterThan(50);
    const violations: Violation[] = [];
    for (const source of sources) {
      const relative = path.relative(DATASET_SRC, source).replace(/\\/g, "/");
      const text = await readFile(source, "utf8");
      violations.push(...scanModule(relative, text));
    }
    expect(violations).toEqual([]);
  });

  test("guard detects representative family/provider dispatch fixtures", () => {
    const fixtures: ReadonlyArray<[string, string]> = [
      ["runtime/new-generic.ts", "if (family.id === \"bioactivity_measurement\") {}\n"],
      ["integrator/generic.ts", "switch (family.id) { case \"pdb\": break; }\n"],
      ["validation/generic.ts", "switch (providerId) { case \"chembl\": break; }\n"],
      ["publish/generic.ts", "if (familyId === \"protein_structure\") {}\n"],
      ["assessment/generic.ts", "if (providerId === \"uniprot\") {}\n"],
      ["derive/generic.ts", "import { parseProteinStructureCarrier } from \"../families/protein-structure/provider.js\";\n"],
    ];
    for (const [file, source] of fixtures) {
      expect(scanModule(file, source), `expected guard to flag ${file}`).not.toEqual([]);
    }
  });

  test("guard ignores doc strings, registry barrel imports, and legal comparisons", () => {
    const legal: ReadonlyArray<[string, string]> = [
      // Doc strings / comments that mention the forbidden shapes are stripped.
      ["runtime/generic.ts", "// Core must never add family.id === dispatch here\n"],
      ["integrator/generic.ts", "/** Documented note: switch (providerId) is forbidden in generic Core. */\n"],
      // The families registry barrel is the intended composition root.
      ["schema/registry.ts", "import { createDefaultDatasetFamilyRegistry } from \"../families/index.js\";\n"],
      // providerId null checks and identifier comparison are not dispatch.
      ["contracts/spec.ts", "if (mode === \"builtin\" && providerId === null) {}\n"],
      ["runtime/provider-bindings.ts", "binding.familyId === familyId && binding.adapterId === adapterId\n"],
    ];
    for (const [file, source] of legal) {
      expect(scanModule(file, source), `expected guard to ignore ${file}`).toEqual([]);
    }
  });
});
