import {
  parseDatasetIdentity,
  parseSampleIdentity,
  type DatasetIdentity,
} from "@biomed/contracts";
import { describe, expect, it } from "vitest";

import {
  createDatasetId,
  createDatasetIdentityRecords,
  createDatasetRevisionId,
  createSampleIdentity,
  validateAssetId,
  validateDatasetId,
  validateDatasetIdentity,
  validateDatasetRevisionId,
  validateSampleIdentity,
} from "../src/dataset/identity/index.js";

const ASSET_A = `asset_${"a".repeat(64)}`;
const ASSET_B = `asset_${"b".repeat(64)}`;

const DATASET_KEY = {
  sourceNamespace: " geo ",
  canonicalAccessions: [" GSE100 ", "GSE200", "GSE100"],
} as const;

const REVISION = {
  revisionToken: " 2026-08-21 ",
  providerSnapshot: " GEO snapshot 2026-08-21 ",
  carrierAssetIds: [ASSET_B, ASSET_A, ASSET_B],
} as const;

describe("Family Host dataset identity primitives", () => {
  it("canonicalizes, sorts, and deduplicates the accession and carrier closures", () => {
    const datasetId = createDatasetId(DATASET_KEY);
    const revisionId = createDatasetRevisionId({ datasetId, ...REVISION });

    expect(datasetId).toBe(
      "ds_0c42e104ed8ff4db0f2d3b236cfe7426026627be2434d27fcfe7ca4ce1d8b352",
    );
    expect(revisionId).toBe(
      "dsrev_a4edb655b0763b9abb1e2206b65f4c119b193639a2f8aa6cab29b9fba017829b",
    );

    expect(createDatasetId({
      sourceNamespace: "GEO",
      canonicalAccessions: ["GSE200", "GSE100"],
    })).toBe(datasetId);
    expect(createDatasetRevisionId({
      datasetId,
      revisionToken: "2026-08-21",
      providerSnapshot: "GEO snapshot 2026-08-21",
      carrierAssetIds: [ASSET_A, ASSET_B],
    })).toBe(revisionId);
  });

  it("is sensitive to revision, provider snapshot, and carrier bytes", () => {
    const datasetId = createDatasetId(DATASET_KEY);
    const baseline = createDatasetRevisionId({ datasetId, ...REVISION });

    expect(createDatasetRevisionId({ datasetId, ...REVISION, revisionToken: "2026-08-22" }))
      .not.toBe(baseline);
    expect(createDatasetRevisionId({ datasetId, ...REVISION, providerSnapshot: "snapshot-2" }))
      .not.toBe(baseline);
    expect(createDatasetRevisionId({
      datasetId,
      ...REVISION,
      carrierAssetIds: [ASSET_A, `asset_${"c".repeat(64)}`],
    })).not.toBe(baseline);
    expect(createDatasetRevisionId({ datasetId, ...REVISION, revisionToken: null }))
      .not.toBe(baseline);
  });

  it("is sensitive to namespace and accession closure", () => {
    const baseline = createDatasetId(DATASET_KEY);

    expect(createDatasetId({ ...DATASET_KEY, sourceNamespace: "gdc" })).not.toBe(baseline);
    expect(createDatasetId({ ...DATASET_KEY, canonicalAccessions: ["GSE100"] })).not.toBe(baseline);
    expect(createDatasetId({ ...DATASET_KEY, canonicalAccessions: ["gse100", "GSE200"] }))
      .not.toBe(baseline);
  });

  it("emits one frozen-contract DatasetIdentity record per sorted unique carrier", () => {
    const records = createDatasetIdentityRecords({ ...DATASET_KEY, ...REVISION });

    expect(records).toHaveLength(2);
    expect(records.map((record) => record.asset_id)).toEqual([ASSET_A, ASSET_B]);
    for (const record of records) {
      expect(parseDatasetIdentity(record, "identity")).toEqual(record);
      expect(validateDatasetIdentity(record)).toEqual(record);
    }
  });

  it("does not include buildId in dataset or revision identity", () => {
    const first = { ...DATASET_KEY, buildId: "build_first" };
    const second = { ...DATASET_KEY, buildId: "build_second" };
    const firstRevision = { ...REVISION, datasetId: createDatasetId(first), buildId: first.buildId };
    const secondRevision = { ...REVISION, datasetId: createDatasetId(second), buildId: second.buildId };

    expect(createDatasetId(first)).toBe(createDatasetId(second));
    expect(createDatasetRevisionId(firstRevision)).toBe(createDatasetRevisionId(secondRevision));
  });

  it("constructs revision-scoped sample composite identity without build identity", () => {
    const datasetId = createDatasetId(DATASET_KEY);
    const datasetRevisionId = createDatasetRevisionId({ datasetId, ...REVISION });
    const first = { datasetRevisionId, sampleId: " S1 ", buildId: "build_first" };
    const second = { datasetRevisionId, sampleId: "S1", buildId: "build_second" };

    const identity = createSampleIdentity(first);
    expect(identity).toEqual({
      dataset_revision_id: datasetRevisionId,
      sample_id: "S1",
    });
    expect(createSampleIdentity(second)).toEqual(identity);
    expect(parseSampleIdentity(identity, "sample_identity")).toEqual(identity);
    expect(validateSampleIdentity(identity)).toEqual(identity);
  });

  it.each([
    ["blank namespace", () => createDatasetId({ sourceNamespace: " ", canonicalAccessions: ["GSE1"] })],
    ["invalid namespace", () => createDatasetId({ sourceNamespace: "geo/source", canonicalAccessions: ["GSE1"] })],
    ["empty accession closure", () => createDatasetId({ sourceNamespace: "geo", canonicalAccessions: [] })],
    ["blank accession", () => createDatasetId({ sourceNamespace: "geo", canonicalAccessions: ["GSE1", " "] })],
    ["blank revision token", () => createDatasetRevisionId({
      datasetId: `ds_${"a".repeat(64)}`,
      revisionToken: " ",
      providerSnapshot: "snapshot",
      carrierAssetIds: [ASSET_A],
    })],
    ["blank provider snapshot", () => createDatasetRevisionId({
      datasetId: `ds_${"a".repeat(64)}`,
      revisionToken: null,
      providerSnapshot: " ",
      carrierAssetIds: [ASSET_A],
    })],
    ["empty carrier closure", () => createDatasetRevisionId({
      datasetId: `ds_${"a".repeat(64)}`,
      revisionToken: null,
      providerSnapshot: "snapshot",
      carrierAssetIds: [],
    })],
    ["uppercase asset digest", () => validateAssetId(`asset_${"A".repeat(64)}`)],
    ["short asset digest", () => validateAssetId("asset_abc")],
    ["non-asset ID", () => validateAssetId(`build_${"a".repeat(64)}`)],
  ])("rejects invalid identity input: %s", (_name, action) => {
    expect(action).toThrow();
  });

  it("validates strict ID schemes and rejects build IDs", () => {
    const datasetId = createDatasetId(DATASET_KEY);
    const datasetRevisionId = createDatasetRevisionId({ datasetId, ...REVISION });

    expect(validateDatasetId(datasetId)).toBe(datasetId);
    expect(validateDatasetRevisionId(datasetRevisionId)).toBe(datasetRevisionId);
    expect(() => validateDatasetId("build_execution_1")).toThrow(/dataset ID/);
    expect(() => validateDatasetRevisionId(`ds_${"a".repeat(64)}`)).toThrow(/revision ID/);

    const invalid: DatasetIdentity = {
      dataset_id: datasetId,
      dataset_revision_id: datasetRevisionId,
      asset_id: `asset_${"A".repeat(64)}`,
    };
    expect(() => validateDatasetIdentity(invalid)).toThrow(/asset ID/);
  });
});
