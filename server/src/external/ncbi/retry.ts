/**
 * NCBI request pacing and retry helpers (Python
 * ``app/tools/crawler.AsyncHostRateLimiter`` + ``app/integrations/ncbi/client.py``
 * ``parse_retry_after`` parity).
 *
 * ``HostRateLimiter`` spaces requests per normalized hostname. For NCBI
 * E-utilities the process shares two quota limiters (3 req/s without an API
 * key, 10 req/s with one); because E-utilities is a single host the per-host
 * limiter is equivalent to the Python process-global limiter it replaces.
 */

/** Cancellable timeout signal; Node's ``AbortSignal.timeout`` keeps a
 * ref'ed timer alive, which would hold test processes open for minutes. */
export function timeoutSignal(ms: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
  }, ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

/** Stable ``<name>: <message>`` description used in error messages. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.name !== "Error" ? `${error.name}: ${error.message}` : error.message;
  }
  return String(error);
}

export interface HostRateLimiterOptions {
  /** Minimum seconds between requests to the same host. */
  minInterval: number;
  /** Injectable monotonic clock returning milliseconds. */
  now?: () => number;
  /** Injectable sleeper receiving milliseconds. */
  sleep?: (delayMs: number) => Promise<void>;
}

export class HostRateLimiter {
  readonly minIntervalMs: number;
  private readonly _now: () => number;
  private readonly _sleep: (delayMs: number) => Promise<void>;
  private readonly _lastRequestAt = new Map<string, number>();
  private readonly _chains = new Map<string, Promise<void>>();

  constructor(options: HostRateLimiterOptions) {
    if (!Number.isFinite(options.minInterval) || options.minInterval < 0) {
      throw new TypeError("min_interval must be non-negative");
    }
    this.minIntervalMs = options.minInterval * 1000;
    this._now = options.now ?? Date.now;
    this._sleep =
      options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  }

  /** Wait until the host's pacing window allows the next request. */
  async wait(url: string): Promise<void> {
    const host = new URL(url).hostname;
    const previous = this._chains.get(host) ?? Promise.resolve();
    const next = previous.then(async () => {
      const last = this._lastRequestAt.get(host);
      if (last !== undefined) {
        const remaining = this.minIntervalMs - (this._now() - last);
        if (remaining > 0) await this._sleep(remaining);
      }
      this._lastRequestAt.set(host, this._now());
    });
    this._chains.set(host, next.then(() => undefined, () => undefined));
    await next;
  }
}

/**
 * Parse a ``Retry-After`` header value into seconds (Python
 * ``parse_retry_after`` parity): seconds first, then HTTP date; missing or
 * unparseable values yield ``0``.
 */
export function parseRetryAfter(value: string | undefined, nowMs: number): number {
  if (!value) return 0;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && value.trim() !== "") {
    return Math.max(0, seconds);
  }
  const retryAtMs = Date.parse(value);
  if (!Number.isFinite(retryAtMs)) return 0;
  return Math.max(0, (retryAtMs - nowMs) / 1000);
}
