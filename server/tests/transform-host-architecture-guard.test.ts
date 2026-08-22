import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
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

const SERVER_SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
);
const TRANSFORM_HOST = path.join(SERVER_SRC, "dataset", "transform-host");
const STAGED_FAMILY_HOST_ROOTS = [
  TRANSFORM_HOST,
  path.join(SERVER_SRC, "dataset", "transform-admission"),
  path.join(SERVER_SRC, "dataset", "family-catalog"),
  path.join(SERVER_SRC, "dataset", "family-spec-admission"),
  path.join(SERVER_SRC, "dataset", "family-spec-topology"),
  path.join(SERVER_SRC, "dataset", "shadow-parity"),
  path.join(SERVER_SRC, "dataset", "relations"),
  path.join(SERVER_SRC, "dataset", "validation", "disk-index.ts"),
] as const;
const UNIQUELY_NAMED_STAGED_MODULE = /(?:^|[\\/])(?:transform-host|transform-admission|family-catalog|family-spec-admission|family-spec-topology|shadow-parity)(?:[\\/]|$)/;

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
  const exportPattern = /\bexport\s+(type\s+)?[\s\S]*?\s+from\s+["']([^"']+)["']/g;
  for (const match of code.matchAll(exportPattern)) {
    imports.push({ source: match[2], clause: "export", typeOnly: Boolean(match[1]) });
  }
  const requirePattern = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of code.matchAll(requirePattern)) {
    imports.push({ source: match[1], clause: "require", typeOnly: false });
  }
  return imports;
}

function dynamicImportSpecifiers(source: string): Array<string | null> {
  const sourceFile = ts.createSourceFile(
    "architecture-guard-input.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const specifiers: Array<string | null> = [];
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const argument = node.arguments[0];
      specifiers.push(
        argument !== undefined && ts.isStringLiteralLike(argument)
          ? argument.text
          : null,
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return specifiers;
}

function parseRuntimeModuleSpecifiers(source: string): string[] {
  return [
    ...parseStaticImports(source)
      .filter((use) => !use.typeOnly)
      .map((use) => use.source),
    ...dynamicImportSpecifiers(source).filter(
      (specifier): specifier is string => specifier !== null,
    ),
  ];
}

function stripModuleExtension(value: string): string {
  return value.replace(/\.(?:c|m)?(?:j|t)s$/u, "");
}

function moduleTarget(importingFile: string, specifier: string): string | null {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return path.resolve(path.dirname(importingFile), specifier);
  }
  if (specifier.startsWith("@/")) {
    return path.resolve(SERVER_SRC, specifier.slice(2));
  }
  return null;
}

function targetsStagedFamilyHostRoot(importingFile: string, specifier: string): boolean {
  if (UNIQUELY_NAMED_STAGED_MODULE.test(specifier)) return true;
  const target = moduleTarget(importingFile, specifier);
  if (target === null) return false;
  const targetWithoutExtension = stripModuleExtension(target);
  return STAGED_FAMILY_HOST_ROOTS.some((root) => {
    const rootWithoutExtension = stripModuleExtension(root);
    return targetWithoutExtension === rootWithoutExtension
      || target.startsWith(`${root}${path.sep}`);
  });
}

function importsStagedFamilyHostModule(source: string, importingFile: string): boolean {
  return parseRuntimeModuleSpecifiers(source).some((specifier) =>
    targetsStagedFamilyHostRoot(importingFile, specifier),
  );
}

function checkSource(file: string, source: string): Violation[] {
  const code = withoutComments(source);
  const violations: Violation[] = [];
  const add = (reason: string): void => {
    violations.push({ file, reason });
  };

  if (dynamicImportSpecifiers(source).length > 0) add("dynamic import is not allowed");
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

async function collectSources(root: string): Promise<string[]> {
  try {
    const sources: string[] = [];
    async function walk(directory: string): Promise<void> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (/\.(?:ts|tsx|mts|cts)$/.test(entry.name)) sources.push(full);
      }
    }
    await walk(root);
    return sources;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function scanTransformHost(): Promise<Violation[]> {
  const violations: Violation[] = [];
  for (const file of await collectSources(TRANSFORM_HOST)) {
    violations.push(...checkSource(path.relative(TRANSFORM_HOST, file), await readFile(file, "utf8")));
  }
  return violations;
}

function isInsideStagedFamilyHostRoot(file: string): boolean {
  return STAGED_FAMILY_HOST_ROOTS.some((root) =>
    file === root || file.startsWith(`${root}${path.sep}`),
  );
}

async function scanInboundFamilyHostImports(): Promise<Violation[]> {
  const violations: Violation[] = [];
  for (const file of await collectSources(SERVER_SRC)) {
    if (isInsideStagedFamilyHostRoot(file)) continue;
    if (importsStagedFamilyHostModule(await readFile(file, "utf8"), file)) {
      violations.push({
        file: path.relative(SERVER_SRC, file),
        reason: "staged Family Host module is imported by production server source",
      });
    }
  }
  return violations;
}

describe("Transform Host architecture guard", () => {
  test("does not confuse comments, strings, or safe type-only imports with violations", () => {
    expect(checkSource(
      "safe.ts",
      `// node:vm and Publisher\nimport type { DatasetTransform } from "@biomed/contracts";\nconst message = "Dynamic import() is forbidden";`,
    )).toEqual([]);
    expect(checkSource("bad-dynamic.ts", 'await import("./worker.js");')).toEqual([
      { file: "bad-dynamic.ts", reason: "dynamic import is not allowed" },
    ]);
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

  test("fixture helper catches inbound static, export, and dynamic staging wiring", () => {
    const fixtureFile = path.join(SERVER_SRC, "service", "guard-fixture.ts");
    for (const moduleName of [
      "transform-host",
      "transform-admission",
      "family-catalog",
      "family-spec-admission",
      "family-spec-topology",
      "shadow-parity",
      "relations",
    ]) {
      expect(importsStagedFamilyHostModule(
        `import { staged } from "../dataset/${moduleName}/index.js";`,
        fixtureFile,
      )).toBe(true);
      expect(importsStagedFamilyHostModule(
        `export { staged } from "../dataset/${moduleName}/index.js";`,
        fixtureFile,
      )).toBe(true);
      expect(importsStagedFamilyHostModule(
        `await import("@/dataset/${moduleName}/index.js");`,
        fixtureFile,
      )).toBe(true);
    }
    expect(importsStagedFamilyHostModule(
      'import { openDiskIndex } from "../dataset/validation/disk-index.js";',
      fixtureFile,
    )).toBe(true);
    expect(importsStagedFamilyHostModule(
      'import { geoRelation } from "../dataset/adapters/geo/relations.js";',
      fixtureFile,
    )).toBe(false);
    expect(importsStagedFamilyHostModule(
      'import type { HostReceipt } from "../dataset/transform-host/protocol.js";',
      fixtureFile,
    )).toBe(false);
    expect(importsStagedFamilyHostModule(
      '// import "../dataset/transform-host/index.js";',
      fixtureFile,
    )).toBe(false);
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

  test("production server sources do not wire staged Family Host modules", async () => {
    expect(await scanInboundFamilyHostImports()).toEqual([]);
  });
});
