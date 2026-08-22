import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

type ImportUse = {
  source: string;
  clause: string;
  typeOnly: boolean;
};

type Violation = {
  file: string;
  reason: string;
};

const TRANSFORM_HOST = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "dataset",
  "transform-host",
);

/** Remove comments while retaining strings, so policy terms in comments cannot trigger the guard. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1 ");
}

function parseStaticImports(source: string): ImportUse[] {
  const code = withoutComments(source);
  const imports: ImportUse[] = [];
  const importPattern = /\bimport\s+(type\s+)?([\s\S]*?\s+from\s+)?["']([^"']+)["']/g;
  for (const match of code.matchAll(importPattern)) {
    imports.push({
      source: match[3],
      clause: match[2] ?? "",
      typeOnly: Boolean(match[1]),
    });
  }
  const sideEffectImportPattern = /\bimport\s*["']([^"']+)["']/g;
  for (const match of code.matchAll(sideEffectImportPattern)) {
    imports.push({ source: match[1], clause: "", typeOnly: false });
  }
  const requirePattern = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of code.matchAll(requirePattern)) {
    imports.push({ source: match[1], clause: "require", typeOnly: false });
  }
  return imports;
}

function checkSource(file: string, source: string): Violation[] {
  const code = withoutComments(source);
  const violations: Violation[] = [];
  const add = (reason: string): void => {
    violations.push({ file, reason });
  };

  if (/\bimport\s*\(/.test(code)) add("dynamic import is not allowed");
  for (const use of parseStaticImports(source)) {
    const normalized = use.source.replaceAll("\\", "/").toLowerCase();
    if (normalized === "node:vm" || normalized === "vm") add("node:vm import");
    if (normalized === "worker_threads" || normalized === "node:worker_threads") add("worker_threads import");
    if (normalized.includes("child_process") || normalized.includes("process-exec") || normalized.includes("workspace/exec")) {
      add("process execution import");
    }
    if (/(^|[/_-])(settings?|secrets?)([/_.-]|$)/.test(normalized)) add("settings/secrets import");
    if (normalized.includes("task-repository") || normalized.includes("/runtime") || normalized.endsWith("runtime")) {
      add("task repository/Core runtime import");
    }
    if (normalized.includes("publisher") || /(^|[/_.-])publication([/_.-]|$)/.test(normalized)) {
      add("Publisher/publication import");
    }
    if (/^@biomed\/contracts(?:\/|$)/.test(normalized) && /\bPublicationCandidate\b/.test(use.clause)) {
      add("PublicationCandidate import");
    }
  }

  const hasBackendRegistry = /(?:backendRegistry|sandboxBackend|register(?:Sandbox|Execution)?Backend|productionBackend)/i.test(code);
  const hasEnabledBackend = /\b(?:enabled|available|active)\s*:\s*true\b/i.test(code);
  if (hasBackendRegistry && hasEnabledBackend && /\b(?:child_process|exec|spawn|fork|node:vm|worker_threads)\b/i.test(code)) {
    add("unsafe process backend is enabled or exposed");
  }

  const windowsCapability = /(?:win32|windows)/i.test(code) && hasEnabledBackend;
  if (windowsCapability) {
    const hasJobObject = /job\s*object/i.test(code);
    const hasAcl = /(?:low[- ]priv(?:ilege)?|service\s+account|acl)/i.test(code);
    const hasNetworkIsolation = /(?:network\s+(?:deny|isolation|isolat)|deny\s+network|networkDenied)/i.test(code);
    if (!hasJobObject || !hasAcl || !hasNetworkIsolation) {
      add("Windows capability is enabled without Job Object, low-privilege ACL, and network isolation");
    }
  }
  return violations;
}

async function collectSources(): Promise<string[]> {
  try {
    const sources: string[] = [];
    async function walk(directory: string): Promise<void> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (/\.(?:ts|tsx|mts|cts)$/.test(entry.name)) sources.push(full);
      }
    }
    await walk(TRANSFORM_HOST);
    return sources;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function scanTransformHost(): Promise<Violation[]> {
  const violations: Violation[] = [];
  for (const file of await collectSources()) {
    violations.push(...checkSource(path.relative(TRANSFORM_HOST, file), await readFile(file, "utf8")));
  }
  return violations;
}

describe("Transform Host architecture guard", () => {
  test("does not confuse comments or safe type-only contracts imports with violations", () => {
    expect(checkSource("safe.ts", `// node:vm and Publisher\nimport type { DatasetTransform } from "@biomed/contracts";`)).toEqual([]);
  });

  test("fixture helper catches forbidden node:vm, worker_threads, and Publisher imports", () => {
    const violations = checkSource(
      "bad-imports.ts",
      `import vm from "node:vm";\nimport "worker_threads";\nimport { Publisher } from "./publisher.js";`,
    );
    expect(violations).toHaveLength(3);
    expect(violations.map((violation) => violation.reason)).toEqual(
      expect.arrayContaining(["node:vm import", "worker_threads import", "Publisher/publication import"]),
    );
  });

  test("fixture helper catches a pseudo-enabled unsafe Windows backend", () => {
    const violations = checkSource(
      "bad-backend.ts",
      `const sandboxBackend = { platform: "win32", enabled: true, implementation: "child_process.exec" };`,
    );
    expect(violations.map((violation) => violation.reason)).toEqual([
      "unsafe process backend is enabled or exposed",
      "Windows capability is enabled without Job Object, low-privilege ACL, and network isolation",
    ]);
  });

  test("active transform-host sources satisfy the fail-closed policy", async () => {
    expect(await scanTransformHost()).toEqual([]);
  });
});
