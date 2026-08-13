/**
 * Per-host asynchronous request pacing (Python ``crawler.py``
 * ``AsyncHostRateLimiter`` parity).
 *
 * This is the project's single rate-limiter implementation for the crawler
 * layer: each normalized hostname gets an independent serialized lane, the
 * registry is bounded (idle hosts are evicted LRU-style), and the interval,
 * clock, and sleeper are injectable so tests can run with a fast interval.
 */

import { URL } from "node:url";

/** Python ``DEFAULT_RATE_LIMIT_SECONDS``: 2s between requests (hard constraint). */
export const DEFAULT_RATE_LIMIT_SECONDS = 2.0;

/** Python ``_normalized_host``: lowercase hostname without the trailing dot. */
export function normalizedHost(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("rate-limited URL is malformed");
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (host === "") {
    throw new Error("rate-limited URL requires a hostname");
  }
  return host.toLowerCase().replace(/\.$/, "");
}

interface HostState {
  /** Serialized lane: each wait chains onto the previous one. */
  tail: Promise<void>;
  lastRequestTime: number | null;
  lastUsed: number;
  references: number;
}

export interface AsyncHostRateLimiterOptions {
  /** Minimum interval between requests to the same host (seconds). */
  minInterval?: number;
  /** Bound on tracked hosts before idle-host eviction. */
  maxHosts?: number;
  /** Monotonic seconds clock (Python ``time.monotonic``). */
  clock?: () => number;
  /** Sleeper (seconds); defaults to ``setTimeout``. */
  sleeper?: (seconds: number) => Promise<void>;
}

export class AsyncHostRateLimiter {
  private readonly minInterval: number;
  private readonly maxHosts: number;
  private readonly clock: () => number;
  private readonly sleeper: (seconds: number) => Promise<void>;
  private readonly hosts = new Map<string, HostState>();

  constructor(options: AsyncHostRateLimiterOptions = {}) {
    this.minInterval = options.minInterval ?? DEFAULT_RATE_LIMIT_SECONDS;
    if (this.minInterval < 0) {
      throw new Error("min_interval must be non-negative");
    }
    this.maxHosts = options.maxHosts ?? 256;
    if (this.maxHosts <= 0) {
      throw new Error("max_hosts must be positive");
    }
    this.clock = options.clock ?? (() => Date.now() / 1000);
    this.sleeper =
      options.sleeper ??
      ((seconds) => new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000)));
  }

  get trackedHostCount(): number {
    return this.hosts.size;
  }

  /** Wait for the lane associated with *url*'s hostname. */
  async wait(url: string): Promise<void> {
    const host = normalizedHost(url);
    let state = this.hosts.get(host);
    if (state === undefined) {
      this.evictIdleHost();
      state = { tail: Promise.resolve(), lastRequestTime: null, lastUsed: this.clock(), references: 0 };
      this.hosts.set(host, state);
    }
    state.references += 1;
    state.lastUsed = this.clock();
    const lane = state.tail.then(async () => {
      const now = this.clock();
      if (state.lastRequestTime !== null) {
        const remaining = this.minInterval - (now - state.lastRequestTime);
        if (remaining > 0) {
          await this.sleeper(remaining);
        }
      }
      state.lastRequestTime = this.clock();
    });
    state.tail = lane.catch(() => undefined);
    try {
      await lane;
    } finally {
      state.references -= 1;
      state.lastUsed = this.clock();
    }
  }

  private evictIdleHost(): void {
    if (this.hosts.size < this.maxHosts) {
      return;
    }
    let oldest: string | null = null;
    let oldestUsed = Number.POSITIVE_INFINITY;
    for (const [host, state] of this.hosts) {
      if (state.references === 0 && state.lastUsed < oldestUsed) {
        oldest = host;
        oldestUsed = state.lastUsed;
      }
    }
    if (oldest === null) {
      throw new Error("host rate limiter capacity is exhausted");
    }
    this.hosts.delete(oldest);
  }
}
