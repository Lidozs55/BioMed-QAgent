import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "vitest";

const REPOSITORY_ROOT = path.resolve(process.cwd(), "..");
const ACTIVE_ROOTS = [
  path.join(REPOSITORY_ROOT, "packages", "contracts", "src"),
  path.join(REPOSITORY_ROOT, "packages", "contracts", "tests"),
  path.join(REPOSITORY_ROOT, "server", "src"),
  path.join(REPOSITORY_ROOT, "server", "tests"),
  path.join(REPOSITORY_ROOT, "frontend", "src"),
  path.join(REPOSITORY_ROOT, ".pi", "skills"),
];

const FORBIDDEN: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bBuildResult\b/u, "BuildResult contract"],
  [/\bDatasetOutcome(?:Status)?\b/u, "renamed BuildResult contract"],
  [/\bdataset_outcome\b/u, "renamed BuildResult payload"],
  [/\bDurableBuild[A-Za-z]*\b/u, "durable Build state machine"],
  [/\bDatasetBuildSpec\b/u, "DatasetBuildSpec contract"],
  [/\bBuildSpec(?:2|Resolution|Proposal|Registered|Capability)[A-Za-z]*\b/u, "BuildSpec compatibility alias"],
  [/\bDynamicFamilyBuild[A-Za-z]*\b/u, "Dynamic Family Build alias"],
  [/\bBuildLock[A-Za-z]*\b/u, "Build lock alias"],
  [/\bbuild_proposal\b/u, "Build proposal wire field"],
  [/\bbuild_id\b/u, "Build identity"],
  [/\/api\/v1\/builds(?:\/|["'`])/u, "Build HTTP API"],
  [/\bdatasets_build\b/u, "legacy Build storage"],
  [/\bdataset_executions\b/u, "requirement-only execution storage"],
  [/\b_durable_builds\b/u, "durable Build storage"],
];

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(resolved);
    return entry.isFile() && /\.(?:md|ts|tsx)$/u.test(entry.name) ? [resolved] : [];
  }));
  return nested.flat();
}

test("active product code contains no retired Build domain", async () => {
  const violations: Array<{ file: string; label: string }> = [];
  for (const root of ACTIVE_ROOTS) {
    for (const file of await sourceFiles(root)) {
      if (file === import.meta.filename) continue;
      const contents = await readFile(file, "utf8");
      for (const [pattern, label] of FORBIDDEN) {
        if (pattern.test(contents)) {
          violations.push({
            file: path.relative(REPOSITORY_ROOT, file),
            label,
          });
        }
      }
    }
  }
  expect(violations).toEqual([]);
});
