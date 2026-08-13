/**
 * Browser egress policy + Node Playwright pool (P5-07).
 */

export {
  createStrictBrowserEgressPolicy,
  normalizeBrowserHost,
  strictBrowserEgressPolicy,
  strictHttpsAuthority,
  type BrowserEgressPolicy,
  type BrowserEgressPolicyOptions,
} from "./egress.js";
export {
  BROWSER_UA,
  DEFAULT_BROWSER_NAVIGATION_TIMEOUT_MS,
  MAX_BROWSER_CONTENT_BYTES,
  MAX_BROWSER_EXTRACT_BYTES,
  MAX_BROWSER_SCREENSHOT_BYTES,
  MAX_BROWSER_SCREENSHOT_PIXELS,
  BrowserSession,
  NodeBrowserPool,
  type BrowserActionResult,
  type BrowserActionOptions,
  type BrowserFetchOptions,
  type BrowserFetchResult,
  type BrowserPoolOptions,
  type BrowserRequestAuthorizer,
  type BrowserScreenshotOptions,
  type BrowserScreenshotResult,
  type BrowserSessionOptions,
  type BrowserViewport,
} from "./pool.js";
