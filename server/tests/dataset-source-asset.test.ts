import { describe, expect, test } from "vitest";

import { parseFileAsset, parseSourceAsset } from "../src/dataset/contracts/index.js";
import { checkSourceAssetParity } from "./source-asset-parity.js";

const SHA256 = "ab".repeat(32);

function downloadAsset(): Record<string, unknown> {
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
  };
}

describe("Phase 4 step 3 SourceAsset parity", () => {
  test("SourceAsset invariants mirror the Python contract tests", () => {
    expect(checkSourceAssetParity()).toEqual([]);
  });

  test("parsed SourceAsset keeps every field and schema_version 1.0", () => {
    const parsed = parseSourceAsset(downloadAsset());
    expect(parsed.schema_version).toBe("1.0");
    expect(parsed.kind).toBe("source");
    expect(parsed.data_level).toBe("repository_processed");
    expect(parsed.successful_attempt_id).toBe("attempt_1");
    expect(parsed.derived_from_asset_id).toBeNull();
    expect(parsed.generated_by_step_id).toBeNull();
  });

  test("FileAsset round-trips through the shared parser", () => {
    const raw = {
      schema_version: "1.0",
      asset_id: `asset_${SHA256}`,
      kind: "parsed",
      relative_path: "parsed/counts.tsv",
      sha256: SHA256,
      size_bytes: 10,
      media_type: "text/tab-separated-values",
      generated_by_step_id: "step_parse_v1",
    };
    expect(parseFileAsset(raw)).toEqual(raw);
  });
});