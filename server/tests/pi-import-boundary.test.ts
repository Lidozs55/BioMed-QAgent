import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "vitest";

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const resolved = path.join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(resolved);
      return entry.isFile() && entry.name.endsWith(".ts") ? [resolved] : [];
    }),
  );
  return nested.flat();
}

test("only the pi adapter package imports Pi-owned packages", async () => {
  const sourceRoot = path.resolve(process.cwd(), "src");
  // The adapter package lives in src/agent/pi/ with the stable public entry
  // src/agent/pi-adapter.ts (pure re-export barrel).
  const piPackageRoot = path.join(sourceRoot, "agent", "pi");
  const violations: string[] = [];
  for (const file of await sourceFiles(sourceRoot)) {
    if (file.startsWith(piPackageRoot + path.sep)) continue;
    if (file === path.join(sourceRoot, "agent", "pi-adapter.ts")) continue;
    const contents = await readFile(file, "utf8");
    if (/[@]earendil-works\/pi-(?:coding-agent|agent-core|ai|tui)/.test(contents)) {
      violations.push(path.relative(sourceRoot, file));
    }
  }
  expect(violations).toEqual([]);
});
