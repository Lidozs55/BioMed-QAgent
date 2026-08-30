// Guard: every runtime value import in server/src must be declared as a
// production dependency of @biomed/server.
//
// Repro context: `ws` and `typescript` were declared as devDependencies while
// being imported at runtime (durable-agent-runtime, transform-host admission
// transpiling). Dev installs mask this; pruned production installs
// (pnpm deploy --prod, npm prune) crash with ERR_MODULE_NOT_FOUND at startup.

import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface PackageManifest {
  dependencies?: Record<string, string>;
}

function listRuntimeSourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...listRuntimeSourceFiles(full));
      continue;
    }
    const isSource = entry.name.endsWith(".ts");
    const isTest = entry.name.endsWith(".test.ts") || entry.name.endsWith(".d.ts");
    if (isSource && !isTest) found.push(full);
  }
  return found;
}

// Replaces comments and string/template-literal contents with spaces (keeping
// newlines and the quote delimiters, preserving offsets 1:1) so statement
// scanning only sees real code. Prose like `from ","` inside a string must not
// look like an import statement.
function maskNonCode(source: string): string {
  let out = "";
  let mode: "code" | "line-comment" | "block-comment" | "single" | "double" | "template" = "code";
  let index = 0;
  while (index < source.length) {
    const ch = source[index];
    const next = source[index + 1];
    if (mode === "code") {
      if (ch === "/" && next === "/") {
        mode = "line-comment";
        out += "  ";
        index += 2;
        continue;
      }
      if (ch === "/" && next === "*") {
        mode = "block-comment";
        out += "  ";
        index += 2;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") {
        mode = ch === "'" ? "single" : ch === '"' ? "double" : "template";
        out += ch;
        index += 1;
        continue;
      }
      out += ch;
      index += 1;
      continue;
    }
    if (mode === "line-comment") {
      if (ch === "\n") mode = "code";
      out += ch === "\n" ? "\n" : " ";
      index += 1;
      continue;
    }
    if (mode === "block-comment") {
      if (ch === "*" && next === "/") {
        mode = "code";
        out += "  ";
        index += 2;
        continue;
      }
      out += ch === "\n" ? "\n" : " ";
      index += 1;
      continue;
    }
    // String modes: mask contents, honor escape sequences, keep newlines.
    if (ch === "\\") {
      out += "  ";
      index += 2;
      continue;
    }
    if ((mode === "single" && ch === "'") || (mode === "double" && ch === '"') || (mode === "template" && ch === "`")) {
      mode = "code";
      out += ch;
      index += 1;
      continue;
    }
    out += ch === "\n" ? "\n" : " ";
    index += 1;
  }
  return out;
}

// Reads a string literal from the original source, given the offset of its
// opening quote. Returns the raw content and the offset just after the closing
// quote. Import specifiers must be extracted from the original text because
// the masked view blanks out their content.
function readStringLiteral(original: string, openQuoteIndex: number): { value: string; endIndex: number } {
  const quote = original[openQuoteIndex];
  let index = openQuoteIndex + 1;
  while (index < original.length) {
    const ch = original[index];
    if (ch === "\\") {
      index += 2;
      continue;
    }
    if (ch === quote) {
      return { value: original.slice(openQuoteIndex + 1, index), endIndex: index + 1 };
    }
    index += 1;
  }
  return { value: original.slice(openQuoteIndex + 1), endIndex: original.length };
}

// Locates import statements on the masked view (no false hits inside strings
// or comments), then re-reads the true specifier from the original source.
// Static `import type` is erased at compile time and therefore skipped.
const STATEMENT_FROM = /\b(?:import|export)\s+(type\s+)?[\s\S]*?\bfrom\s*["']/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']/g;
const SIDE_EFFECT_IMPORT = /\bimport\s*["']/g;

function collectRuntimeImportSpecifiers(masked: string, original: string): string[] {
  const specifiers: string[] = [];
  const patterns = [STATEMENT_FROM, DYNAMIC_IMPORT, SIDE_EFFECT_IMPORT];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const match of masked.matchAll(pattern)) {
      if (pattern === STATEMENT_FROM && match[1] !== undefined) continue;
      const openQuote = match.index + match[0].length - 1;
      const literal = readStringLiteral(original, openQuote);
      specifiers.push(literal.value);
    }
  }
  return specifiers;
}

// Returns the package name of a bare specifier, or null when the specifier
// cannot hit node_modules (builtins, relative paths, workspace packages).
function externalPackageName(specifier: string): string | null {
  if (specifier.startsWith("node:") || specifier.startsWith(".") || specifier.startsWith("/")) {
    return null;
  }
  if (specifier.startsWith("@biomed/")) return null;
  return specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0] ?? null;
}

describe("runtime dependency manifest", () => {
  it("declares every runtime value import of server/src as a production dependency", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(serverRoot, "package.json"), "utf8"),
    ) as PackageManifest;
    const declared = new Set(Object.keys(manifest.dependencies ?? {}));
    const builtins = new Set(builtinModules);

    const violations: string[] = [];
    for (const file of listRuntimeSourceFiles(path.join(serverRoot, "src"))) {
      const original = readFileSync(file, "utf8");
      const masked = maskNonCode(original);
      for (const specifier of collectRuntimeImportSpecifiers(masked, original)) {
        const name = externalPackageName(specifier);
        if (name === null || declared.has(name) || builtins.has(name)) continue;
        violations.push(`${path.relative(serverRoot, file)} imports "${specifier}"`);
      }
    }

    expect(violations).toEqual([]);
  });
});
