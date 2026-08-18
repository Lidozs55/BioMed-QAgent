import { describe, expect, test } from "vitest";

import {
  parseFileAsset,
  parseRegisteredSourceAssetRef,
  parseSourceAsset,
  parseSourceAssetRegistrationReceipt,
} from "../src/dataset/contracts/index.js";
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

  test.each(["source", "mapping", "metadata", "carrier"] as const)(
    "registered %s asset receipt is content-addressed and task-owned",
    (role) => {
      const raw = {
        schema_version: "1.0",
        receipt_id: `receipt_${role}`,
        task_id: "task_c1",
        asset_ref: {
          schema_version: "1.0",
          asset_id: `asset_${SHA256}`,
          task_id: "task_c1",
          role,
        },
        source_id: "source_geo",
        relative_path: `source_assets/${role}.bin`,
        sha256: SHA256,
        size_bytes: 1024,
        media_type: "application/octet-stream",
        registered_at: "2026-08-18T00:00:00Z",
        path_compatibility: {
          schema_version: "1.0",
          mode: "asset_id",
          legacy_path: null,
          telemetry_event: "asset_ref_used",
        },
      };
      expect(parseSourceAssetRegistrationReceipt(raw, "task_c1")).toEqual(raw);
    },
  );

  test("registered asset contracts reject paths, cross-task refs, drift and unknown roles", () => {
    const ref = {
      schema_version: "1.0",
      asset_id: `asset_${SHA256}`,
      task_id: "task_c1",
      role: "source",
    };
    expect(() => parseRegisteredSourceAssetRef({ ...ref, asset_id: "source_assets/file.tsv" })).toThrow(/safe path|content-addressed/);
    expect(() => parseRegisteredSourceAssetRef(ref, "task_other")).toThrow(/different task/);
    expect(() => parseRegisteredSourceAssetRef({ ...ref, role: "agent_file" })).toThrow(/role/);
    const receipt = {
      schema_version: "1.0",
      receipt_id: "receipt_1",
      task_id: "task_c1",
      asset_ref: ref,
      source_id: "source_geo",
      relative_path: "source_assets/file.tsv",
      sha256: SHA256,
      size_bytes: 1,
      media_type: "text/tab-separated-values",
      registered_at: "2026-08-18T00:00:00Z",
      path_compatibility: {
        schema_version: "1.0",
        mode: "asset_id",
        legacy_path: null,
        telemetry_event: "asset_ref_used",
      },
    };
    expect(() => parseSourceAssetRegistrationReceipt({ ...receipt, sha256: "cd".repeat(32) })).toThrow(/hash/);
    expect(() => parseSourceAssetRegistrationReceipt({ ...receipt, relative_path: "../workspace/file.tsv" })).toThrow(/escape/);
    expect(() => parseSourceAssetRegistrationReceipt({ ...receipt, relative_path: "workspace/file.tsv" })).toThrow(/source_assets/);
    expect(() => parseSourceAssetRegistrationReceipt({ ...receipt, task_id: "task_other" }, "task_c1")).toThrow(/different task/);
  });

  test("legacy path compatibility is explicit telemetry and never an asset identity", () => {
    const receipt = {
      schema_version: "1.0",
      receipt_id: "receipt_legacy",
      task_id: "task_c1",
      asset_ref: { schema_version: "1.0", asset_id: `asset_${SHA256}`, task_id: "task_c1", role: "source" },
      source_id: "source_geo",
      relative_path: "source_assets/file.tsv",
      sha256: SHA256,
      size_bytes: 1,
      media_type: "text/tab-separated-values",
      registered_at: "2026-08-18T00:00:00Z",
      path_compatibility: {
        schema_version: "1.0",
        mode: "legacy_task_path",
        legacy_path: "source_assets/file.tsv",
        telemetry_event: "legacy_path_compatibility_used",
      },
    };
    expect(parseSourceAssetRegistrationReceipt(receipt).path_compatibility.mode).toBe("legacy_task_path");
    expect(() => parseSourceAssetRegistrationReceipt({
      ...receipt,
      path_compatibility: { ...receipt.path_compatibility, telemetry_event: "asset_ref_used" },
    })).toThrow(/telemetry/);
    expect(() => parseSourceAssetRegistrationReceipt({
      ...receipt,
      path_compatibility: { ...receipt.path_compatibility, legacy_path: "workspace/file.tsv" },
    })).toThrow(/source_assets/);
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