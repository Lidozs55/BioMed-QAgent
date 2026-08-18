/**
 * Disk-backed probe → gene index (A4; bounded-memory replacement for the
 * full in-memory ``probe_to_gene`` Record consumed by the canonicalizer).
 *
 * Storage layout: ``probe_index_<bindingId>`` directory containing
 * ``PROBE_INDEX_SHARDS`` one-column TSV shard files, each row ``probe\tgene``.
 * A probe is sharded by FNV-1a 32-bit hash modulo ``PROBE_INDEX_SHARDS`` so a
 * lookup touches exactly one file. Ambiguous probes (a probe resolving to more
 * than one distinct gene across the annotation table) are stored as one row
 * per (probe, gene) pair and collapse to the ``ambiguous`` classification when
 * the shard is read back.
 *
 * Writes are staged in per-shard buffers and flushed in bounded chunks to keep
 * peak memory flat for high-cardinality platforms; reads use a small LRU shard
 * cache. Callers own the lifecycle: ``create``/``destroy``.
 */

import { mkdirSync, rmSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Number of shard files; power-of-two hash domain backing (prime-friendly). */
export const PROBE_INDEX_SHARDS = 128;

/** Number of shards kept resident in the LRU read cache. */
const PROBE_INDEX_CACHE_SHARDS = 4;

/** Staged rows buffered in memory before a bounded shard flush. */
const PROBE_INDEX_FLUSH_ROWS = 4096;

export type ProbeIndexShardValue =
  | { kind: "absent" }
  | { kind: "ambiguous" }
  | { kind: "mapped"; gene: string };

/** Values physically persisted in shard files (never ``absent``). */
type StoredShardValue = Exclude<ProbeIndexShardValue, { kind: "absent" }>;

/** Shard location of a probe (FNV-1a 32-bit). */
export function probeShard(probe: string): number {
  let hash = 0x811c9dc5;
  for (let offset = 0; offset < probe.length; offset += 1) {
    hash ^= probe.charCodeAt(offset);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash % PROBE_INDEX_SHARDS;
}

/**
 * Bounded-memory probe → gene index writing to ``PROBE_INDEX_SHARDS`` TSV
 * shard files under ``dir``.
 */
export class ProbeIndex {
  /** Buffered rows per shard waiting to be appended. */
  private readonly staged: string[][] = Array.from(
    { length: PROBE_INDEX_SHARDS },
    () => [],
  );
  private stagedCount = 0;
  private readonly shardCache = new Map<number, ReadonlyMap<string, StoredShardValue>>();

  private constructor(private readonly dir: string) {}

  /** Create (or recreate fresh) an index under ``dir``. */
  static create(dir: string): ProbeIndex {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    return new ProbeIndex(dir);
  }

  private shardPath(shard: number): string {
    return join(this.dir, `shard_${shard}.tsv`);
  }

  /** Stage one probe → gene mapping; ambiguous collisions are preserved. */
  async put(probe: string, gene: string): Promise<void> {
    stagedPush(this.staged[probeShard(probe)], probe, gene);
    this.stagedCount += 1;
    if (this.stagedCount >= PROBE_INDEX_FLUSH_ROWS) {
      await this.flush();
    }
  }

  /** Append all staged rows to their shard files. */
  async flush(): Promise<void> {
    if (this.stagedCount === 0) return;
    const pending: Array<Promise<void>> = [];
    for (let shard = 0; shard < PROBE_INDEX_SHARDS; shard += 1) {
      const rows = this.staged[shard];
      if (rows.length === 0) continue;
      const content = rows.join("");
      rows.length = 0;
      pending.push(appendFile(this.shardPath(shard), content, "utf8"));
    }
    this.stagedCount = 0;
    await Promise.all(pending);
  }

  /** Mapped gene for ``probe``, or undefined when absent/ambiguous. */
  async get(probe: string): Promise<string | undefined> {
    await this.flush();
    const loaded = await this.loadShard(probeShard(probe));
    const value = loaded.get(probe);
    if (value === undefined || value.kind === "ambiguous") return undefined;
    return value.gene;
  }

  /** Classified resolution for ``probe`` (absent/ambiguous/mapped). */
  async resolve(probe: string): Promise<ProbeIndexShardValue> {
    await this.flush();
    const loaded = await this.loadShard(probeShard(probe));
    const value = loaded.get(probe);
    if (value === undefined) return { kind: "absent" };
    if (value.kind === "ambiguous") return { kind: "ambiguous" };
    return value;
  }

  /**
   * Resolve a probe list while loading each shard at most once, preserving
   * input order (so callers keep a globally sorted audit without a k-way
   * merge).
   */
  async bulkResolve(probes: readonly string[]): Promise<ProbeIndexShardValue[]> {
    await this.flush();
    const buckets = new Map<number, number[]>();
    for (let offset = 0; offset < probes.length; offset += 1) {
      const shard = probeShard(probes[offset]);
      const indices = buckets.get(shard);
      if (indices === undefined) buckets.set(shard, [offset]);
      else indices.push(offset);
    }
    await Promise.all([...buckets.keys()].map((shard) => this.loadShard(shard)));
    const results = new Array<ProbeIndexShardValue>(probes.length);
    for (const [shard, indices] of buckets) {
      const loaded = await this.loadShard(shard);
      for (const offset of indices) {
        const value = loaded.get(probes[offset]);
        results[offset] = value ?? { kind: "absent" };
      }
    }
    return results;
  }

  /** Best-effort full map (skips ambiguous probes); unbounded by design. */
  async materialize(): Promise<Record<string, string>> {
    await this.flush();
    const loaded = await Promise.all(
      Array.from({ length: PROBE_INDEX_SHARDS }, (_, shard) => this.loadShard(shard)),
    );
    const mapping: Record<string, string> = {};
    for (const shardMap of loaded) {
      for (const [probe, value] of shardMap) {
        if (value.kind === "mapped") mapping[probe] = value.gene;
      }
    }
    return mapping;
  }

  /** LRU-cached shard loader; evicts the least recently used shard. */
  private async loadShard(
    shard: number,
  ): Promise<ReadonlyMap<string, StoredShardValue>> {
    const cached = this.shardCache.get(shard);
    if (cached !== undefined) {
      this.shardCache.delete(shard);
      this.shardCache.set(shard, cached);
      return cached;
    }
    const loaded = await readShard(this.shardPath(shard));
    this.shardCache.set(shard, loaded);
    if (this.shardCache.size > PROBE_INDEX_CACHE_SHARDS) {
      const oldest = this.shardCache.keys().next().value as number;
      this.shardCache.delete(oldest);
    }
    return loaded;
  }

  /** Remove the on-disk shard files. */
  destroy(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

function stagedPush(staged: string[], probe: string, gene: string): void {
  staged.push(`${probe}\t${gene}\n`);
}

/** Load one shard file (absent file when no rows were staged → empty map). */
async function readShard(shardPath: string): Promise<ReadonlyMap<string, StoredShardValue>> {
  let lines: string;
  try {
    lines = await readFile(shardPath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return new Map();
    throw error;
  }
  const genesByProbe = new Map<string, Set<string>>();
  let offset = 0;
  while (offset < lines.length) {
    const newline = lines.indexOf("\n", offset);
    const end = newline === -1 ? lines.length : newline;
    const line = end > offset ? lines.slice(offset, end) : "";
    offset = newline === -1 ? lines.length : newline + 1;
    if (line === "") continue;
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const probe = line.slice(0, tab);
    const gene = line.slice(tab + 1);
    let genes = genesByProbe.get(probe);
    if (genes === undefined) {
      genes = new Set<string>();
      genesByProbe.set(probe, genes);
    }
    genes.add(gene);
  }
  const tagged = new Map<string, StoredShardValue>();
  for (const [probe, genes] of genesByProbe) {
    if (genes.size > 1) {
      tagged.set(probe, { kind: "ambiguous" });
    } else {
      tagged.set(probe, { kind: "mapped", gene: [...genes][0] });
    }
  }
  return tagged;
}

/** True for ENOENT-style errors (shard file absent because never flushed). */
function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}