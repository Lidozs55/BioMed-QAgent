/**
 * Phase 8 architecture guard (P8-07).
 *
 * Static scan proving the active source tree no longer contains the retired
 * legacy Python runtime / rollback topology:
 *   - no FastAPI spawn or legacy backend client code in server/src
 *   - no experimental Phase 1 Pi surface
 *   - no legacy feature-flag parsing
 *
 * Historical docs (docs/archive, docs/migration/phase*.md) may mention the
 * retired terms — this guard only scans the active runtime.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const SERVER_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

const FORBIDDEN_PATTERNS: Array<[RegExp, string]> = [
  [/createLegacyBackend/, "legacy backend spawn"],
  [/needsLegacyBackend/, "legacy backend condition"],
  [/legacyTarget/, "legacy target routing"],
  [/\bbridgeSecret\b/, "legacy bridge secret"],
  [/PI_DATASET_BRIDGE_SECRET/, "Python Dataset Core bridge secret"],
  [/LEGACY_BACKEND_/, "legacy backend env var"],
  [/createPhase1ExperimentalRuntime/, "experimental Pi composition"],
  [/\/experimental\/pi/, "experimental Pi HTTP surface"],
  [/agentRuntime\s*===?\s*["']legacy/, "legacy agent runtime check"],
  [/datasetCore\s*===?\s*["']python/, "python dataset core check"],
  [/piExperimental/, "PI_EXPERIMENTAL flag"],
  [/uvicorn/, "uvicorn spawn"],
];

async function collectSources(): Promise<string[]> {
  const sources: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".ts")) sources.push(full);
    }
  }
  await walk(SERVER_SRC);
  return sources;
}

describe("Phase 8 architecture guard", () => {
  test("active server runtime contains no legacy Python / rollback references", async () => {
    const sources = await collectSources();
    expect(sources.length).toBeGreaterThan(50);
    const violations: Array<[string, string]> = [];
    for (const source of sources) {
      const text = await readFile(source, "utf8");
      for (const [pattern, label] of FORBIDDEN_PATTERNS) {
        if (pattern.test(text)) {
          violations.push([path.relative(SERVER_SRC, source), label]);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
