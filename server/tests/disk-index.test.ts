import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { OperationAbortedError } from "../src/dataset/cooperative.js";
import {
  checkRelationIndexes,
  createTupleIndex,
  DiskIndexOwnershipError,
  DiskIndexPoisonedError,
  DiskIndexResourceLimitError,
  encodeTupleKey,
  type DiskIndexOwner,
  type Tuple,
} from "../src/dataset/validation/disk-index.js";

const TEST_OWNER: DiskIndexOwner = { taskId: "task_disk_index", generation: 7 };
const TEST_DISK_QUOTA_BYTES = 64 * 1024 * 1024;
const indexes: Array<Awaited<ReturnType<typeof createTupleIndex>>> = [];
const directories: string[] = [];

async function makeIndex(
  mode: "memory" | "disk",
  options: {
    owner?: DiskIndexOwner;
    batchSize?: number;
    quotaBytes?: number;
    directory?: string;
  } = {},
) {
  const index = await createTupleIndex({
    mode,
    owner: options.owner ?? TEST_OWNER,
    batchSize: options.batchSize,
    quotaBytes: mode === "disk" ? (options.quotaBytes ?? TEST_DISK_QUOTA_BYTES) : options.quotaBytes,
    directory: options.directory,
  });
  indexes.push(index);
  return index;
}

afterEach(async () => {
  await Promise.all(indexes.splice(0).map((index) => index.cleanup()));
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 })));
});

describe("B3 tuple index primitive", () => {
  it("uses canonical ordered bytes without Unicode normalization or sentinel collisions", () => {
    const variants: readonly Tuple[] = [
      ["😀"],
      ["\0"],
      ["é"],
      ["e\u0301"],
      [""],
      [null],
      [undefined],
      [],
    ];
    const keys = variants.map((tuple) => encodeTupleKey(tuple));

    expect(keys.every((key) => Buffer.isBuffer(key))).toBe(true);
    expect(new Set(keys.map((key) => key.toString("hex"))).size).toBe(variants.length);
    expect(encodeTupleKey(["a", "bc"]).equals(encodeTupleKey(["a", "bc"]))).toBe(true);
    expect(encodeTupleKey(["a", "bc"]).equals(encodeTupleKey(["ab", "c"]))).toBe(false);
    expect(encodeTupleKey(["left", "right"]).equals(encodeTupleKey(["right", "left"]))).toBe(false);
    expect(() => encodeTupleKey(["\ud800"])).toThrow(/lone UTF-16 surrogate/);
    expect(() => encodeTupleKey(["\udc00"])).toThrow(/lone UTF-16 surrogate/);
  });

  it("stores tuple keys as SQLite BLOBs and binds the store to task/generation", async () => {
    const owner = { taskId: "task_blob_owner", generation: 3 } as const;
    const index = await makeIndex("disk", { owner });
    await index.addBatch([["😀"], ["\0"], ["é"], ["e\u0301"], [""], [null], [undefined], []]);
    const storagePath = index.storagePath();
    if (storagePath === null) throw new Error("disk index must expose a storage path");

    const reader = new DatabaseSync(storagePath, { readOnly: true });
    try {
      expect(reader.prepare(
        "SELECT COUNT(*) AS count FROM tuples WHERE typeof(key) != 'blob'",
      ).get()).toEqual({ count: 0 });
      expect(reader.prepare("SELECT COUNT(*) AS count FROM tuples").get()).toEqual({ count: 8 });
      expect(reader.prepare(
        "SELECT task_id, generation FROM index_owner WHERE singleton = 1",
      ).get()).toEqual({ task_id: owner.taskId, generation: owner.generation });
    } finally {
      reader.close();
    }
  });

  it.each(["memory", "disk"] as const)(
    "keeps PK/FK/cardinality/missing-policy parity in %s mode",
    async (mode) => {
      const parent = await makeIndex(mode);
      const child = await makeIndex(mode);
      await parent.addBatch([["p1"], ["p2"]]);
      await child.addBatch([["p1"], ["p1"], ["missing"]]);

      expect(parent.primaryKeyCheck()).toEqual({
        duplicateKeys: 0,
        nullOrBlankRows: 0,
        passed: true,
      });
      expect(child.primaryKeyCheck()).toEqual({
        duplicateKeys: 1,
        nullOrBlankRows: 0,
        passed: false,
      });
      expect(await checkRelationIndexes(child, parent, {
        cardinality: "many_to_one",
        missingPolicy: "reject",
      })).toEqual({
        foreignKeyMissing: 1,
        fromDuplicateKeys: 1,
        toDuplicateKeys: 0,
        missingPolicyPassed: false,
        cardinalityPassed: true,
        passed: false,
      });
      expect(await checkRelationIndexes(child, parent, {
        cardinality: "many_to_one",
        missingPolicy: "allow_missing",
      })).toEqual(expect.objectContaining({
        missingPolicyPassed: true,
        cardinalityPassed: true,
        passed: true,
      }));
      expect(await checkRelationIndexes(child, parent, {
        cardinality: "one_to_one",
        missingPolicy: "allow_missing",
      })).toEqual(expect.objectContaining({ cardinalityPassed: false, passed: false }));
      expect(await checkRelationIndexes(child, parent, {
        cardinality: "one_to_many",
        missingPolicy: "allow_missing",
      })).toEqual(expect.objectContaining({ cardinalityPassed: false, passed: false }));
      expect(await checkRelationIndexes(child, parent, {
        cardinality: "many_to_many",
        missingPolicy: "allow_missing",
      })).toEqual(expect.objectContaining({ cardinalityPassed: true, passed: true }));

      const invalidPrimary = await makeIndex(mode);
      await invalidPrimary.addBatch([["ok"], [""], [null], [undefined]]);
      expect(invalidPrimary.primaryKeyCheck()).toEqual({
        duplicateKeys: 0,
        nullOrBlankRows: 3,
        passed: false,
      });

      const emptyReferenced = await makeIndex(mode);
      expect(await checkRelationIndexes(child, emptyReferenced, {
        cardinality: "many_to_one",
        missingPolicy: "allow_empty",
      })).toEqual(expect.objectContaining({
        foreignKeyMissing: 3,
        missingPolicyPassed: true,
        passed: true,
      }));
      expect(await checkRelationIndexes(child, emptyReferenced, {
        cardinality: "many_to_one",
        missingPolicy: null,
      })).toEqual(expect.objectContaining({ missingPolicyPassed: false, passed: false }));
    },
  );

  it("streams SQLite relation keys instead of materializing them with StatementSync.all", async () => {
    const source = await readFile(
      new URL("../src/dataset/validation/disk-index.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain(".iterate()");
    expect(source).not.toContain(".all(");
  });

  it("poisons the index after cancellation and rejects every later query", async () => {
    const index = await makeIndex("disk", { batchSize: 2 });
    const controller = new AbortController();
    controller.abort();

    await expect(index.addBatch([["not-written"]], controller.signal)).rejects
      .toBeInstanceOf(OperationAbortedError);
    expect(() => index.count(["not-written"])).toThrow(DiskIndexPoisonedError);
    expect(() => index.has(["not-written"])).toThrow(DiskIndexPoisonedError);
    expect(() => index.primaryKeyCheck()).toThrow(DiskIndexPoisonedError);
    expect(() => index.stats()).toThrow(DiskIndexPoisonedError);
  });

  it("enforces a SQLite page hard cap, rolls back, and poisons on quota failure", async () => {
    const quotaBytes = 32 * 1024;
    const index = await makeIndex("disk", { batchSize: 128, quotaBytes });
    const storagePath = index.storagePath();
    if (storagePath === null) throw new Error("disk index must expose a storage path");
    const values = function* (): Generator<Tuple> {
      for (let index = 0; index < 64; index += 1) yield [`${index}:${"x".repeat(1024)}`];
    };

    await expect(index.addBatch(values())).rejects.toBeInstanceOf(DiskIndexResourceLimitError);
    expect(() => index.count(["anything"])).toThrow(DiskIndexPoisonedError);
    expect(() => index.stats()).toThrow(DiskIndexPoisonedError);

    const reader = new DatabaseSync(storagePath, { readOnly: true });
    try {
      expect(reader.prepare("SELECT COUNT(*) AS count FROM tuples").get()).toEqual({ count: 0 });
      await expect(stat(storagePath)).resolves
        .toEqual(expect.objectContaining({ size: expect.any(Number) }));
    } finally {
      reader.close();
    }
  });

  it("poisons both relation indexes after iterator cancellation", async () => {
    const from = await makeIndex("disk", { batchSize: 1 });
    const to = await makeIndex("disk", { batchSize: 1 });
    await from.addBatch([["a"], ["b"]]);
    await to.add(["a"]);
    const controller = new AbortController();
    controller.abort();

    await expect(checkRelationIndexes(from, to, {
      cardinality: "many_to_one",
      missingPolicy: "reject",
      signal: controller.signal,
    })).rejects.toBeInstanceOf(OperationAbortedError);
    expect(() => from.count(["a"])).toThrow(DiskIndexPoisonedError);
    expect(() => to.count(["a"])).toThrow(DiskIndexPoisonedError);
  });

  it("poisons owner-mismatched indexes instead of crossing task generations", async () => {
    const current = await makeIndex("disk", {
      owner: { taskId: "task-owner", generation: 1 },
    });
    const stale = await makeIndex("disk", {
      owner: { taskId: "task-owner", generation: 0 },
    });

    await expect(checkRelationIndexes(current, stale, {
      cardinality: "many_to_one",
      missingPolicy: "reject",
    })).rejects.toBeInstanceOf(DiskIndexOwnershipError);
    expect(() => current.stats()).toThrow(DiskIndexPoisonedError);
    expect(() => stale.stats()).toThrow(DiskIndexPoisonedError);
  });

  it("poisons after tuple encoding errors", async () => {
    const index = await makeIndex("memory");
    await expect(index.add(["\ud800"])).rejects.toThrow(/lone UTF-16 surrogate/);
    expect(() => index.count(["safe"])).toThrow(DiskIndexPoisonedError);
  });

  it("retries Windows lock cleanup and remains idempotent", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "biomed-b3-parent-"));
    directories.push(directory);
    const index = await makeIndex("disk", { directory });
    await index.add(["held"]);
    const storagePath = index.storagePath();
    if (storagePath === null) throw new Error("disk index must expose a storage path");
    const reader = new DatabaseSync(storagePath, { readOnly: true });
    let readerClosed = false;
    const release = setTimeout(() => {
      reader.close();
      readerClosed = true;
    }, 75);

    try {
      await index.cleanup();
    } finally {
      clearTimeout(release);
      if (!readerClosed) reader.close();
    }
    await index.cleanup();
    await expect(access(storagePath)).rejects.toThrow();
  });

  it("streams one million unique keys without constructing a million-element input", async () => {
    // Test-only capacity for the measured fixture; this is not a production threshold claim.
    const fixtureQuotaBytes = 256 * 1024 * 1024;
    const index = await makeIndex("disk", {
      batchSize: 8192,
      quotaBytes: fixtureQuotaBytes,
    });
    const tuples = function* (): Generator<Tuple> {
      for (let value = 0; value < 1_000_000; value += 1) yield [`unique-${value.toString(36)}`];
    };

    await index.addBatch(tuples());

    expect(index.stats()).toEqual(expect.objectContaining({
      mode: "disk",
      rows: 1_000_000,
      batches: 123,
    }));
    expect(index.stats().bytes).toBeLessThanOrEqual(fixtureQuotaBytes);
    expect(index.count(["unique-0"])).toBe(1);
    expect(index.count([`unique-${(1_000_000 - 1).toString(36)}`])).toBe(1);
    expect(index.duplicateKeyCount()).toBe(0);
  }, 240_000);
});
