/**
 * Shared request pacing for agent tools (deduplicated from ``gdc.ts`` /
 * ``xena.ts``; Python ``rate_limit`` parity: a single shared timestamp per
 * source, enforced before every external request).
 */
import { AsyncHostRateLimiter } from "../../external/crawler/rate-limit.js";

const limiters = new Map<number, AsyncHostRateLimiter>();

export function rateLimit(url: string, minIntervalMs: number): Promise<void> {
  if (minIntervalMs <= 0) return Promise.resolve();
  let limiter = limiters.get(minIntervalMs);
  if (limiter === undefined) {
    limiter = new AsyncHostRateLimiter({ minInterval: minIntervalMs / 1000 });
    limiters.set(minIntervalMs, limiter);
  }
  return limiter.wait(url);
}