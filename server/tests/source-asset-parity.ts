/**
 * Phase 4 step 3 (SourceAsset) parity checks: mirror the invariants in
 * ``backend/tests/contracts/test_source_contracts.py`` plus the source-path
 * and lineage rules in ``app.domain.contracts.source``. Vitest-free so the
 * same checks run under vitest and as a plain Node script.
 */

import { deepEqual } from "./contract-parity.js";
import {
  parseFileAsset,
  parseSourceAsset,
  parseSourceLocator,
} from "../src/dataset/contracts/index.js";

const SHA256 = "ab".repeat(32);

function sourceAsset(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "1.0",
    asset_id: `asset_${SHA256}`,
    kind: "source",
    relative_path: "source_assets/GSE178352_counts.txt.gz",
    sha256: SHA256,
    size_bytes: 1024,
    media_type: "application/gzip",
    generated_by_step_id: null,
    source_id: "src_geo",
    successful_attempt_id: "attempt_1",
    derived_from_asset_id: null,
    data_level: "repository_processed",
    ...overrides,
  };
}

function checkThrows(
  issues: string[],
  name: string,
  fn: () => unknown,
  messagePattern?: RegExp,
): void {
  try {
    fn();
    issues.push(`${name}: expected a TypeError but none was thrown`);
  } catch (error) {
    if (!(error instanceof TypeError)) {
      issues.push(`${name}: expected TypeError, got ${String(error)}`);
    } else if (messagePattern !== undefined && !messagePattern.test(error.message)) {
      issues.push(
        `${name}: message '${error.message}' does not match ${messagePattern}`,
      );
    }
  }
}

function check(issues: string[], condition: boolean, message: string): void {
  if (!condition) issues.push(message);
}

/** SourceAsset + FileAsset + SourceLocator invariants. */
export function checkSourceAssetParity(): string[] {
  const issues: string[] = [];

  // 1. A valid download-lineage asset parses and round-trips.
  const download = sourceAsset();
  try {
    const parsed = parseSourceAsset(download);
    check(issues, deepEqual(parsed, download), "download asset round-trip mismatch");
    check(
      issues,
      parsed.data_level === "repository_processed",
      "data_level must survive parsing",
    );
    check(issues, parsed.kind === "source", "kind must stay 'source'");
  } catch (error) {
    issues.push(
      `valid download asset failed to parse: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // 2. A valid derived-lineage asset parses and round-trips.
  const derived = sourceAsset({
    successful_attempt_id: null,
    derived_from_asset_id: `asset_${"cd".repeat(32)}`,
    generated_by_step_id: "step_normalize_v1",
  });
  try {
    const parsed = parseSourceAsset(derived);
    check(issues, deepEqual(parsed, derived), "derived asset round-trip mismatch");
    check(issues, parsed.successful_attempt_id === null, "derived asset must have null attempt");
  } catch (error) {
    issues.push(
      `valid derived asset failed to parse: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // 3. kind must be 'source'.
  checkThrows(issues, "kind parsed rejected", () =>
    parseSourceAsset(sourceAsset({ kind: "parsed" })),
  );

  // 4. Path must stay inside source_assets.
  checkThrows(issues, "path outside source_assets rejected", () =>
    parseSourceAsset(sourceAsset({ relative_path: "parsed/counts.tsv" })),
    /source_assets/,
  );

  // 5. FileAsset rejects absolute/escaping paths, including Windows drive-absolute.
  const fileAssetBase = {
    schema_version: "1.0",
    asset_id: `asset_${SHA256}`,
    kind: "parsed",
    relative_path: "parsed/counts.tsv",
    sha256: SHA256,
    size_bytes: 1,
    media_type: "text/tab-separated-values",
    generated_by_step_id: null,
  };
  for (const path of [
    "/source_assets/file.gz",
    "../file.gz",
    "source_assets/../../file.gz",
    "C:/file.gz",
  ]) {
    checkThrows(issues, `FileAsset path '${path}' rejected`, () =>
      parseFileAsset({ ...fileAssetBase, relative_path: path }),
    );
  }
  // 5b. Unknown fields are rejected (Python ContractModel extra="forbid").
  checkThrows(issues, "FileAsset unknown field rejected", () =>
    parseFileAsset({ ...fileAssetBase, smuggled: 1 }),
  );
  checkThrows(issues, "SourceAsset unknown field rejected", () =>
    parseSourceAsset(sourceAsset({ smuggled: 1 })),
  );

  // 6. Exactly one download or derivation lineage.
  checkThrows(issues, "no lineage rejected", () =>
    parseSourceAsset(
      sourceAsset({ successful_attempt_id: null, derived_from_asset_id: null }),
    ),
    /exactly one/,
  );
  checkThrows(issues, "both lineages rejected", () =>
    parseSourceAsset(
      sourceAsset({
        successful_attempt_id: "attempt_1",
        derived_from_asset_id: `asset_${"cd".repeat(32)}`,
        generated_by_step_id: "step_normalize_v1",
      }),
    ),
    /exactly one/,
  );

  // 7. Derived asset must not reference itself.
  checkThrows(issues, "derived self-reference rejected", () =>
    parseSourceAsset(
      sourceAsset({
        successful_attempt_id: null,
        derived_from_asset_id: `asset_${SHA256}`,
        generated_by_step_id: "step_normalize_v1",
      }),
    ),
    /cannot reference itself/,
  );

  // 8. Derived asset requires generated_by_step_id.
  checkThrows(issues, "derived without step id rejected", () =>
    parseSourceAsset(
      sourceAsset({
        successful_attempt_id: null,
        derived_from_asset_id: `asset_${"cd".repeat(32)}`,
        generated_by_step_id: null,
      }),
    ),
    /requires generated_by_step_id/,
  );

  // 9. FileAsset rejects invalid sha256 and empty optional min_length fields.
  checkThrows(issues, "invalid sha256 rejected", () =>
    parseSourceAsset(sourceAsset({ sha256: "bad" })),
  );
  checkThrows(issues, "empty successful_attempt_id rejected", () =>
    parseSourceAsset(sourceAsset({ successful_attempt_id: "" })),
  );

  // 10. DataLevel must be a known level.
  checkThrows(issues, "unknown data_level rejected", () =>
    parseSourceAsset(sourceAsset({ data_level: "raw" })),
    /must be one of/,
  );

  // 11. SourceLocator precise physical coordinates (Python test_source_contracts).
  const locatorBase = {
    schema_version: "1.0",
    asset_id: `asset_${SHA256}`,
    logical_file: "GSE178352_tximportCounts.txt",
    source_line_number: 2,
    source_column_index: 1,
    source_column_name: "GSM5419701",
    raw_value: "17.25",
  };
  const parsedLocator = parseSourceLocator(locatorBase);
  check(issues, deepEqual(parsedLocator, locatorBase), "source locator round-trip mismatch");
  checkThrows(issues, "locator line 0 rejected", () =>
    parseSourceLocator({ ...locatorBase, source_line_number: 0 }),
  );
  checkThrows(issues, "locator column -1 rejected", () =>
    parseSourceLocator({ ...locatorBase, source_column_index: -1 }),
  );
  checkThrows(issues, "locator escaping logical_file rejected", () =>
    parseSourceLocator({ ...locatorBase, logical_file: "../counts.txt" }),
  );
  checkThrows(issues, "locator non-string raw_value rejected", () =>
    parseSourceLocator({ ...locatorBase, raw_value: 3.14 }),
  );

  return issues;
}