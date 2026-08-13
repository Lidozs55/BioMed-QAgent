/**
 * HTTP-first crawler facade with per-host rate limiting and the API → HTML →
 * browser fallback chain (P5-07).
 */

export {
  BROWSER_HEADERS,
  CrawlError,
  CrawlerFacade,
  fetchWithFallback,
  MAX_CRAWLER_DOWNLOAD_BYTES,
  MAX_CRAWLER_REDIRECTS,
  MAX_CRAWLER_RESPONSE_BYTES,
  type ApiRequestOptions,
  type BrowserPoolClient,
  type CrawlAttempt,
  type CrawlerFacadeLike,
  type CrawlerFacadeOptions,
  type CrawlerMethodUsed,
  type CrawlerScreenshotOptions,
  type DownloadResult,
  type FetchResult,
  type FetchWithFallbackOptions,
} from "./crawler.js";
export { AsyncHostRateLimiter, DEFAULT_RATE_LIMIT_SECONDS, normalizedHost, type AsyncHostRateLimiterOptions } from "./rate-limit.js";
