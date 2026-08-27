/**
 * Phase 4 step 1 (contracts) parity checks: prove the TypeScript contract
 * parsers accept and reproduce exactly the JSON Python V2 serializes in the
 * golden migration fixtures (tests/migration/golden/<outcome>/fixture.json).
 *
 * This module is deliberately free of vitest/fs imports so the same checks
 * can run both under vitest and as a plain Node script.
 */

import {
  parseDatasetExecutionSpec,
  parseDatasetManifest,
  parseDatasetPublication,
  parseValidationResult,
} from "../src/dataset/contracts/index.js";

type Parser<T> = (value: unknown) => T;

export interface GoldenFixture {
  spec: unknown;
  validation_result: unknown | null;
  manifest: unknown | null;
  publication: unknown | null;
}

/** Order-insensitive deep equality over JSON-compatible values. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  const aKeys = Object.keys(a as Record<string, unknown>).sort();
  const bKeys = Object.keys(b as Record<string, unknown>).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let index = 0; index < aKeys.length; index += 1) {
    if (aKeys[index] !== bKeys[index]) return false;
    const aValue = (a as Record<string, unknown>)[aKeys[index]];
    const bValue = (b as Record<string, unknown>)[bKeys[index]];
    if (!deepEqual(aValue, bValue)) return false;
  }
  return true;
}

function checkRoundTrip<T>(
  name: string,
  raw: unknown,
  parse: Parser<T>,
  issues: string[],
): void {
  if (raw === null || raw === undefined) return;
  let parsed: T;
  try {
    parsed = parse(raw);
  } catch (error) {
    issues.push(
      `${name} failed to parse: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  if (!deepEqual(parsed, raw)) {
    issues.push(`${name} round-trip mismatch after parsing`);
  }
}

/** Returns empty array when the fixture satisfies every contract parity check. */
export function checkContractParity(fixture: GoldenFixture): string[] {
  const issues: string[] = [];
  checkRoundTrip("spec", fixture.spec, parseDatasetExecutionSpec, issues);
  checkRoundTrip(
    "validation_result",
    fixture.validation_result,
    parseValidationResult,
    issues,
  );
  checkRoundTrip("manifest", fixture.manifest, parseDatasetManifest, issues);
  checkRoundTrip("publication", fixture.publication, parseDatasetPublication, issues);
  return issues;
}
