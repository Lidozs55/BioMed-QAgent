import { statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { checkpoint, throwIfAborted } from "../cooperative.js";

export type TupleValue = string | null | undefined;
export type Tuple = readonly TupleValue[];

export interface DiskIndexOwner {
  readonly taskId: string;
  readonly generation: number;
}

export interface DiskIndexOptions {
  readonly owner: DiskIndexOwner;
  readonly mode?: "memory" | "disk";
  readonly directory?: string;
  readonly quotaBytes?: number;
  readonly batchSize?: number;
}

export interface IndexStats {
  readonly rows: number;
  readonly bytes: number;
  readonly mode: "memory" | "disk";
  readonly batches: number;
}

export interface PrimaryKeyIndexCheck {
  readonly duplicateKeys: number;
  readonly nullOrBlankRows: number;
  readonly passed: boolean;
}

export type RelationCardinality = "one_to_one" | "one_to_many" | "many_to_one" | "many_to_many";
export type ResolvedRelationMissingPolicy = "reject" | "allow_empty" | "allow_missing";

export interface RelationIndexCheck {
  readonly foreignKeyMissing: number;
  readonly fromDuplicateKeys: number;
  readonly toDuplicateKeys: number;
  readonly missingPolicyPassed: boolean;
  readonly cardinalityPassed: boolean;
  readonly passed: boolean;
}

export interface RelationIndexCheckOptions {
  readonly cardinality: RelationCardinality;
  /** null represents an unresolved profile_defined policy and therefore fails closed. */
  readonly missingPolicy: ResolvedRelationMissingPolicy | null;
  readonly signal?: AbortSignal | null;
  /**
   * Memory-parity row count for the referenced table (includes malformed
   * rows, exactly like the validator's memory scan counter). When provided,
   * it replaces the inserted-row count for the allow_empty reference test so
   * memory and disk relation checks stay identical.
   */
  readonly referencedRowCount?: number;
}

interface MemoryEntry {
  count: number;
  readonly invalidPrimary: boolean;
}

interface EncodedTuple {
  readonly key: Buffer;
  readonly memoryKey: string;
  readonly invalidPrimary: boolean;
}

interface SqliteCountRow {
  readonly count: number;
}

interface SqliteTupleRow extends SqliteCountRow {
  readonly key: Uint8Array;
}

interface SqlitePrimaryKeyRow {
  readonly duplicate_keys: number;
  readonly null_or_blank_rows: number;
}

const SQLITE_PAGE_BYTES = 4096;
const SQLITE_MAX_PAGE_COUNT = 4_294_967_294;
const DEFAULT_BATCH_SIZE = 4096;
const CLEANUP_MAX_RETRIES = 8;
const CLEANUP_RETRY_DELAY_MS = 25;
const TUPLE_ENCODING_VERSION = 1;
const FIELD_MISSING = 0;
const FIELD_NULL = 1;
const FIELD_STRING = 2;
const UINT32_MAX = 0xffff_ffff;

export class DiskIndexResourceLimitError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DiskIndexResourceLimitError";
  }
}

export class DiskIndexPoisonedError extends Error {
  constructor(cause: unknown) {
    super("tuple index is poisoned by an earlier failed operation", { cause });
    this.name = "DiskIndexPoisonedError";
  }
}

export class DiskIndexOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiskIndexOwnershipError";
  }
}

function assertWellFormedUnicode(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError(`${label} contains a lone UTF-16 surrogate`);
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError(`${label} contains a lone UTF-16 surrogate`);
    }
  }
}

function checkedAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new RangeError(`${label} exceeds the safe integer range`);
  return result;
}

/**
 * Canonical tuple byte encoding used as the SQLite BLOB key.
 *
 * Layout: version:u8, field-count:u32be, then one field tag per value. String
 * fields append UTF-8-byte-length:u32be and the unchanged UTF-8 bytes. No
 * Unicode normalization is performed, so NFC and NFD remain distinct.
 */
export function encodeTupleKey(values: Tuple): Buffer {
  if (values.length > UINT32_MAX) throw new RangeError("tuple has too many fields");

  const strings: Array<Buffer | null> = [];
  let encodedLength = 5;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === undefined || value === null) {
      strings.push(null);
      encodedLength = checkedAdd(encodedLength, 1, "encoded tuple");
      continue;
    }
    assertWellFormedUnicode(value, `tuple field ${index}`);
    const bytes = Buffer.from(value, "utf8");
    if (bytes.length > UINT32_MAX) throw new RangeError(`tuple field ${index} is too large`);
    strings.push(bytes);
    encodedLength = checkedAdd(encodedLength, 5 + bytes.length, "encoded tuple");
  }

  const encoded = Buffer.allocUnsafe(encodedLength);
  encoded.writeUInt8(TUPLE_ENCODING_VERSION, 0);
  encoded.writeUInt32BE(values.length, 1);
  let offset = 5;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === undefined) {
      encoded.writeUInt8(FIELD_MISSING, offset);
      offset += 1;
    } else if (value === null) {
      encoded.writeUInt8(FIELD_NULL, offset);
      offset += 1;
    } else {
      const bytes = strings[index];
      if (bytes === null || bytes === undefined) throw new Error("tuple encoding invariant failed");
      encoded.writeUInt8(FIELD_STRING, offset);
      encoded.writeUInt32BE(bytes.length, offset + 1);
      bytes.copy(encoded, offset + 5);
      offset += 5 + bytes.length;
    }
  }
  return encoded;
}

function validateOwner(owner: DiskIndexOwner): DiskIndexOwner {
  if (typeof owner.taskId !== "string" || owner.taskId.length === 0) {
    throw new TypeError("owner.taskId must be a non-empty string");
  }
  assertWellFormedUnicode(owner.taskId, "owner.taskId");
  if (!Number.isSafeInteger(owner.generation) || owner.generation < 0) {
    throw new RangeError("owner.generation must be a non-negative safe integer");
  }
  return Object.freeze({ taskId: owner.taskId, generation: owner.generation });
}

function ownersMatch(left: DiskIndexOwner, right: DiskIndexOwner): boolean {
  return left.taskId === right.taskId && left.generation === right.generation;
}

function isSqliteFull(error: unknown): boolean {
  return typeof error === "object" && error !== null && "errcode" in error && error.errcode === 13;
}

function removeIndexDirectory(directory: string): Promise<void> {
  return rm(directory, {
    recursive: true,
    force: true,
    maxRetries: CLEANUP_MAX_RETRIES,
    retryDelay: CLEANUP_RETRY_DELAY_MS,
  });
}

/**
 * Standalone B3 tuple-index primitive. It is deliberately not wired into the
 * production multi-table validator; memory mode is a parity oracle and disk
 * mode is an owner-bound, task-local SQLite implementation.
 */
export class TupleIndex {
  private readonly mode: "memory" | "disk";
  private readonly quotaBytes: number;
  private readonly batchSize: number;
  private readonly owner: DiskIndexOwner;
  private readonly memory = new Map<string, MemoryEntry>();
  private readonly db: DatabaseSync | null;
  private readonly databasePath: string | null;
  private readonly upsertStatement: StatementSync | null;
  private readonly countStatement: StatementSync | null;
  private readonly hasStatement: StatementSync | null;
  private readonly entriesStatement: StatementSync | null;
  private rows = 0;
  private batches = 0;
  private transactionOpen = false;
  private poisoned = false;
  private poisonedCause: unknown;
  private closed = false;
  private databaseClosed = false;
  private cleanupPromise: Promise<void> | null = null;

  private constructor(options: {
    mode: "memory" | "disk";
    owner: DiskIndexOwner;
    quotaBytes: number;
    batchSize: number;
    db: DatabaseSync | null;
    databasePath: string | null;
  }) {
    this.mode = options.mode;
    this.owner = options.owner;
    this.quotaBytes = options.quotaBytes;
    this.batchSize = options.batchSize;
    this.db = options.db;
    this.databasePath = options.databasePath;

    if (this.db === null) {
      this.upsertStatement = null;
      this.countStatement = null;
      this.hasStatement = null;
      this.entriesStatement = null;
      return;
    }

    this.configureDatabase();
    this.upsertStatement = this.db.prepare(
      "INSERT INTO tuples (key, count, invalid_primary) VALUES (?, 1, ?) " +
      "ON CONFLICT(key) DO UPDATE SET count = count + 1",
    );
    this.countStatement = this.db.prepare("SELECT count FROM tuples WHERE key = ?");
    this.hasStatement = this.db.prepare("SELECT 1 AS count FROM tuples WHERE key = ?");
    this.entriesStatement = this.db.prepare("SELECT key, count FROM tuples ORDER BY key");
  }

  static async create(options: DiskIndexOptions): Promise<TupleIndex> {
    const owner = validateOwner(options.owner);
    const mode = options.mode ?? "memory";
    if (mode === "disk" && options.quotaBytes === undefined) {
      throw new TypeError("disk mode requires an explicit quotaBytes policy input");
    }
    const quotaBytes = options.quotaBytes ?? 0;
    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    if (options.quotaBytes !== undefined &&
      (!Number.isSafeInteger(quotaBytes) || quotaBytes <= 0)) {
      throw new RangeError("quotaBytes must be a positive safe integer");
    }
    if (Math.floor(quotaBytes / SQLITE_PAGE_BYTES) > SQLITE_MAX_PAGE_COUNT) {
      throw new RangeError("quotaBytes exceeds SQLite's supported page count");
    }
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
      throw new RangeError("batchSize must be a positive safe integer");
    }
    if (mode === "memory") {
      return new TupleIndex({ mode, owner, quotaBytes, batchSize, db: null, databasePath: null });
    }

    const parent = options.directory ?? os.tmpdir();
    const directory = await mkdtemp(path.join(parent, "biomed-b3-index-"));
    const databasePath = path.join(directory, "index.sqlite");
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(databasePath);
      return new TupleIndex({ mode, owner, quotaBytes, batchSize, db, databasePath });
    } catch (error) {
      if (db !== null) db.close();
      await removeIndexDirectory(directory);
      if (isSqliteFull(error)) {
        throw new DiskIndexResourceLimitError(
          `B3 disk index quota is too small to initialize within ${quotaBytes} bytes`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async add(values: Tuple, signal?: AbortSignal | null): Promise<void> {
    await this.addBatch([values], signal);
  }

  async addBatch(values: Iterable<Tuple>, signal?: AbortSignal | null): Promise<void> {
    this.assertUsable();
    try {
      throwIfAborted(signal);
      let batch: EncodedTuple[] = [];
      for (const tuple of values) {
        throwIfAborted(signal);
        batch.push(this.encodeTuple(tuple));
        if (batch.length === this.batchSize) {
          this.writeBatch(batch, signal);
          batch = [];
          await checkpoint(signal);
        }
      }
      if (batch.length > 0) {
        this.writeBatch(batch, signal);
        await checkpoint(signal);
      }
    } catch (error) {
      this.markPoisoned(error);
      throw error;
    }
  }

  count(values: Tuple): number {
    this.assertUsable();
    try {
      return this.countEncoded(this.encodeTuple(values));
    } catch (error) {
      this.markPoisoned(error);
      throw error;
    }
  }

  has(values: Tuple): boolean {
    this.assertUsable();
    try {
      return this.hasEncoded(this.encodeTuple(values).key);
    } catch (error) {
      this.markPoisoned(error);
      throw error;
    }
  }

  duplicateKeyCount(): number {
    return this.primaryKeyCheck().duplicateKeys;
  }

  primaryKeyCheck(): PrimaryKeyIndexCheck {
    this.assertUsable();
    try {
      let duplicateKeys = 0;
      let nullOrBlankRows = 0;
      if (this.db === null) {
        for (const entry of this.memory.values()) {
          if (entry.count > 1) duplicateKeys += 1;
          if (entry.invalidPrimary) nullOrBlankRows += entry.count;
        }
      } else {
        const row = this.db.prepare(
          "SELECT " +
          "COALESCE(SUM(CASE WHEN count > 1 THEN 1 ELSE 0 END), 0) AS duplicate_keys, " +
          "COALESCE(SUM(CASE WHEN invalid_primary = 1 THEN count ELSE 0 END), 0) AS null_or_blank_rows " +
          "FROM tuples",
        ).get() as unknown as SqlitePrimaryKeyRow;
        duplicateKeys = row.duplicate_keys;
        nullOrBlankRows = row.null_or_blank_rows;
      }
      return {
        duplicateKeys,
        nullOrBlankRows,
        passed: duplicateKeys === 0 && nullOrBlankRows === 0,
      };
    } catch (error) {
      this.markPoisoned(error);
      throw error;
    }
  }

  storagePath(): string | null {
    this.assertUsable();
    return this.databasePath;
  }

  ownerBinding(): DiskIndexOwner {
    this.assertUsable();
    return { ...this.owner };
  }

  stats(): IndexStats {
    this.assertUsable();
    try {
      return {
        rows: this.rows,
        bytes: this.currentBytes(),
        mode: this.mode,
        batches: this.batches,
      };
    } catch (error) {
      this.markPoisoned(error);
      throw error;
    }
  }

  async cleanup(): Promise<void> {
    if (this.cleanupPromise !== null) return this.cleanupPromise;
    const cleanup = this.cleanupOnce();
    this.cleanupPromise = cleanup;
    try {
      await cleanup;
    } catch (error) {
      this.cleanupPromise = null;
      throw error;
    }
  }

  static async checkRelationIndexes(
    from: TupleIndex,
    to: TupleIndex,
    options: RelationIndexCheckOptions,
  ): Promise<RelationIndexCheck> {
    from.assertUsable();
    to.assertUsable();
    if (!ownersMatch(from.owner, to.owner)) {
      const error = new DiskIndexOwnershipError(
        "relation indexes must have the same taskId and generation owner",
      );
      from.markPoisoned(error);
      to.markPoisoned(error);
      throw error;
    }

    try {
      const dependent = options.cardinality === "one_to_many" ? to : from;
      const referenced = options.cardinality === "one_to_many" ? from : to;
      const foreignKeyMissing = await dependent.missingCountIn(referenced, options.signal);
      const fromDuplicateKeys = from.primaryKeyCheckInternal().duplicateKeys;
      const toDuplicateKeys = to.primaryKeyCheckInternal().duplicateKeys;
      const cardinalityPassed =
        (options.cardinality === "one_to_one" && fromDuplicateKeys === 0 && toDuplicateKeys === 0) ||
        (options.cardinality === "one_to_many" && fromDuplicateKeys === 0) ||
        (options.cardinality === "many_to_one" && toDuplicateKeys === 0) ||
        options.cardinality === "many_to_many";
      const referencedEmpty = options.referencedRowCount === undefined
        ? referenced.rows === 0
        : options.referencedRowCount === 0;
      const missingAllowed = options.missingPolicy === "allow_missing" ||
        (options.missingPolicy === "allow_empty" && referencedEmpty);
      const missingPolicyPassed = options.missingPolicy !== null &&
        (foreignKeyMissing === 0 || missingAllowed);
      return {
        foreignKeyMissing,
        fromDuplicateKeys,
        toDuplicateKeys,
        missingPolicyPassed,
        cardinalityPassed,
        passed: missingPolicyPassed && cardinalityPassed,
      };
    } catch (error) {
      from.markPoisoned(error);
      to.markPoisoned(error);
      throw error;
    }
  }

  private configureDatabase(): void {
    if (this.db === null) throw new Error("disk database is unavailable");
    const maxPageCount = Math.floor(this.quotaBytes / SQLITE_PAGE_BYTES);
    if (maxPageCount < 1) {
      throw new DiskIndexResourceLimitError(
        `B3 disk index quota must allow at least one ${SQLITE_PAGE_BYTES}-byte SQLite page`,
      );
    }
    this.db.exec(
      `PRAGMA page_size=${SQLITE_PAGE_BYTES}; ` +
      "PRAGMA journal_mode=MEMORY; PRAGMA synchronous=OFF; PRAGMA temp_store=MEMORY; " +
      `PRAGMA max_page_count=${maxPageCount};`,
    );
    this.db.exec(
      "CREATE TABLE index_owner (" +
      "singleton INTEGER PRIMARY KEY CHECK(singleton = 1), " +
      "task_id TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation >= 0)); " +
      "CREATE TABLE tuples (" +
      "key BLOB PRIMARY KEY NOT NULL CHECK(typeof(key) = 'blob'), " +
      "count INTEGER NOT NULL CHECK(count > 0), " +
      "invalid_primary INTEGER NOT NULL CHECK(invalid_primary IN (0, 1))) WITHOUT ROWID;",
    );
    this.db.prepare(
      "INSERT INTO index_owner (singleton, task_id, generation) VALUES (1, ?, ?)",
    ).run(this.owner.taskId, this.owner.generation);
    this.enforceQuotaBeforeWrite();
  }

  private encodeTuple(values: Tuple): EncodedTuple {
    const key = encodeTupleKey(values);
    return {
      key,
      memoryKey: key.toString("base64"),
      invalidPrimary: values.some((value) => value === undefined || value === null || value === ""),
    };
  }

  private writeBatch(batch: readonly EncodedTuple[], signal?: AbortSignal | null): void {
    throwIfAborted(signal);
    this.enforceQuotaBeforeWrite();
    const previousRows = this.rows;
    const previousMemory = new Map<string, MemoryEntry | undefined>();
    if (this.db === null) {
      for (const tuple of batch) {
        if (!previousMemory.has(tuple.memoryKey)) {
          const current = this.memory.get(tuple.memoryKey);
          previousMemory.set(tuple.memoryKey, current === undefined ? undefined : { ...current });
        }
      }
    }

    this.beginTransaction();
    try {
      for (const tuple of batch) {
        throwIfAborted(signal);
        this.addEncoded(tuple);
      }
      throwIfAborted(signal);
      this.enforceQuotaBeforeWrite();
      this.commitTransaction();
      this.batches += 1;
    } catch (error) {
      const quotaFailure = isSqliteFull(error)
        ? new DiskIndexResourceLimitError(
          `B3 disk index quota exceeded before committing ${this.quotaBytes} bytes`,
          { cause: error },
        )
        : null;
      try {
        this.rollbackTransaction();
      } catch (rollbackError) {
        this.rows = previousRows;
        throw new AggregateError(
          [quotaFailure ?? error, rollbackError],
          "tuple index write and rollback failed",
          { cause: rollbackError },
        );
      }
      this.rows = previousRows;
      for (const [key, entry] of previousMemory) {
        if (entry === undefined) this.memory.delete(key);
        else this.memory.set(key, entry);
      }
      if (quotaFailure !== null) throw quotaFailure;
      throw error;
    }
  }

  private addEncoded(tuple: EncodedTuple): void {
    if (this.db === null) {
      const current = this.memory.get(tuple.memoryKey);
      if (current === undefined) {
        this.memory.set(tuple.memoryKey, { count: 1, invalidPrimary: tuple.invalidPrimary });
      } else {
        current.count += 1;
      }
    } else {
      if (this.upsertStatement === null) throw new Error("disk upsert statement is unavailable");
      this.upsertStatement.run(tuple.key, tuple.invalidPrimary ? 1 : 0);
    }
    this.rows += 1;
  }

  private countEncoded(tuple: EncodedTuple): number {
    if (this.db === null) return this.memory.get(tuple.memoryKey)?.count ?? 0;
    if (this.countStatement === null) throw new Error("disk count statement is unavailable");
    const row = this.countStatement.get(tuple.key) as SqliteCountRow | undefined;
    return row?.count ?? 0;
  }

  private hasEncoded(key: Uint8Array): boolean {
    if (this.db === null) return this.memory.has(Buffer.from(key).toString("base64"));
    if (this.hasStatement === null) throw new Error("disk membership statement is unavailable");
    return this.hasStatement.get(key) !== undefined;
  }

  private *entries(): Generator<readonly [Uint8Array, number]> {
    if (this.db === null) {
      for (const [key, entry] of this.memory) {
        yield [Buffer.from(key, "base64"), entry.count];
      }
      return;
    }
    if (this.entriesStatement === null) throw new Error("disk iterator statement is unavailable");
    const rows = this.entriesStatement.iterate() as unknown as Iterable<SqliteTupleRow>;
    for (const row of rows) yield [row.key, row.count];
  }

  private async missingCountIn(
    referenced: TupleIndex,
    signal?: AbortSignal | null,
  ): Promise<number> {
    throwIfAborted(signal);
    let missing = 0;
    let inspected = 0;
    for (const [key, count] of this.entries()) {
      if (!referenced.hasEncoded(key)) missing += count;
      inspected += 1;
      if (inspected % this.batchSize === 0) await checkpoint(signal);
    }
    throwIfAborted(signal);
    return missing;
  }

  private primaryKeyCheckInternal(): PrimaryKeyIndexCheck {
    let duplicateKeys = 0;
    let nullOrBlankRows = 0;
    if (this.db === null) {
      for (const entry of this.memory.values()) {
        if (entry.count > 1) duplicateKeys += 1;
        if (entry.invalidPrimary) nullOrBlankRows += entry.count;
      }
    } else {
      const row = this.db.prepare(
        "SELECT " +
        "COALESCE(SUM(CASE WHEN count > 1 THEN 1 ELSE 0 END), 0) AS duplicate_keys, " +
        "COALESCE(SUM(CASE WHEN invalid_primary = 1 THEN count ELSE 0 END), 0) AS null_or_blank_rows " +
        "FROM tuples",
      ).get() as unknown as SqlitePrimaryKeyRow;
      duplicateKeys = row.duplicate_keys;
      nullOrBlankRows = row.null_or_blank_rows;
    }
    return {
      duplicateKeys,
      nullOrBlankRows,
      passed: duplicateKeys === 0 && nullOrBlankRows === 0,
    };
  }

  private beginTransaction(): void {
    if (this.db !== null) {
      this.db.exec("BEGIN IMMEDIATE");
      this.transactionOpen = true;
    }
  }

  private commitTransaction(): void {
    if (this.db !== null) {
      this.db.exec("COMMIT");
      this.transactionOpen = false;
    }
  }

  private rollbackTransaction(): void {
    if (this.db !== null && this.transactionOpen) {
      try {
        // SQLITE_FULL may auto-rollback before Node surfaces the write error.
        if (this.db.isTransaction) this.db.exec("ROLLBACK");
      } finally {
        this.transactionOpen = false;
      }
    }
  }

  private currentBytes(): number {
    return this.databasePath === null ? 0 : statSync(this.databasePath).size;
  }

  private enforceQuotaBeforeWrite(): void {
    if (this.db === null || this.databasePath === null) return;
    const bytes = this.currentBytes();
    const pageCount = (this.db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count;
    const maxPageCount = (this.db.prepare("PRAGMA max_page_count").get() as {
      max_page_count: number;
    }).max_page_count;
    if (bytes > this.quotaBytes || pageCount > maxPageCount || maxPageCount * SQLITE_PAGE_BYTES > this.quotaBytes) {
      throw new DiskIndexResourceLimitError(
        `B3 disk index quota exceeded before write: ${bytes} bytes > ${this.quotaBytes} bytes`,
      );
    }
  }

  private markPoisoned(error: unknown): void {
    if (!this.poisoned) {
      this.poisoned = true;
      this.poisonedCause = error;
    }
  }

  private assertUsable(): void {
    if (this.closed) throw new Error("tuple index is closed");
    if (this.poisoned) throw new DiskIndexPoisonedError(this.poisonedCause);
  }

  private async cleanupOnce(): Promise<void> {
    this.closed = true;
    const failures: unknown[] = [];
    if (this.transactionOpen) {
      try {
        this.rollbackTransaction();
      } catch (error) {
        failures.push(error);
      }
    }
    if (this.db !== null && !this.databaseClosed) {
      try {
        this.db.close();
        this.databaseClosed = true;
      } catch (error) {
        failures.push(error);
      }
    }
    this.memory.clear();
    if (this.databasePath !== null) {
      try {
        await removeIndexDirectory(path.dirname(this.databasePath));
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "tuple index cleanup failed");
  }
}

export async function createTupleIndex(options: DiskIndexOptions): Promise<TupleIndex> {
  return TupleIndex.create(options);
}

/** Compare two owner-matched indexes as a deterministic PK/FK/cardinality gate. */
export async function checkRelationIndexes(
  from: TupleIndex,
  to: TupleIndex,
  options: RelationIndexCheckOptions,
): Promise<RelationIndexCheck> {
  return TupleIndex.checkRelationIndexes(from, to, options);
}
