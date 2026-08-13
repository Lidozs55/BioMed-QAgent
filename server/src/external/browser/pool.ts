/**
 * Lifespan-owned Node Playwright browser pool (Python
 * ``app/tools/browser_pool.py`` parity).
 *
 * One shared Chromium, one isolated BrowserContext per operation:
 *
 * - the browser is launched once (lazily on first use, or via the injectable
 *   launcher) and shared by every operation;
 * - every operation receives an INDEPENDENT BrowserContext that is destroyed
 *   when the operation ends (no cookie/session bleed between tasks);
 * - a fixed project-wide User-Agent, bounded navigation timeout, AbortSignal
 *   support, and a maximum number of concurrent contexts (excess operations
 *   queue);
 * - ``close()`` converges everything: it stops accepting work, drains active
 *   operations, and closes the shared browser;
 * - only declarative actions are allowed (``navigate``/``click``/``fill``/
 *   ``select``/``wait_for``/``extract``) — never agent-generated JavaScript.
 *   The only ``evaluate`` calls are the fixed bounded serialization scripts.
 *
 * Egress is enforced at two layers (see ``egress.ts``): the operation target
 * URL is validated before ``page.goto``, and a ``context.route`` interception
 * re-validates every request the browser makes — each redirect hop included.
 * Main-document rejections fail the operation; subresource rejections abort
 * silently so the page body still renders (Python parity).
 *
 * Output caps (Python parity): page/extract 10 MiB, screenshot 25 MiB and
 * 25,000,000 pixels.
 */

import { chromium, type Browser, type BrowserContext, type Page, type Request, type Response, type Route } from "playwright";

import { strictBrowserEgressPolicy, type BrowserEgressPolicy } from "./egress.js";

/** Project-wide browser User-Agent (Python ``BROWSER_UA``). */
export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const MAX_BROWSER_CONTENT_BYTES = 10 * 1024 * 1024;
export const MAX_BROWSER_EXTRACT_BYTES = 10 * 1024 * 1024;
export const MAX_BROWSER_SCREENSHOT_BYTES = 25 * 1024 * 1024;
export const MAX_BROWSER_SCREENSHOT_PIXELS = 25_000_000;
export const DEFAULT_BROWSER_NAVIGATION_TIMEOUT_MS = 60_000;

export interface BrowserViewport {
  width: number;
  height: number;
}

const DEFAULT_VIEWPORT: BrowserViewport = { width: 1920, height: 1080 };

const STEALTH_SCRIPT = `
Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});
Object.defineProperty(navigator, 'languages', {get: () => ['en-US', 'en']});
window.chrome = {runtime: {}};
`;

/** Fixed bounded serialization scripts (never agent-generated code). */
const SERIALIZE_DOCUMENT_BOUNDED = `
limit => {
    const content = document.documentElement.outerHTML;
    const size_bytes = new TextEncoder().encode(content).byteLength;
    if (size_bytes > limit) {
        return {over_limit: true, size_bytes};
    }
    return {over_limit: false, size_bytes, content};
}
`;
const SERIALIZE_ELEMENT_BOUNDED = `
(element, limit) => {
    const content = element.innerText;
    const size_bytes = new TextEncoder().encode(content).byteLength;
    if (size_bytes > limit) {
        return {over_limit: true, size_bytes};
    }
    return {over_limit: false, size_bytes, content};
}
`;
const SERIALIZE_DOCUMENT_DIMENSIONS = `
() => ({
    width: Math.max(
        document.documentElement.scrollWidth,
        document.body ? document.body.scrollWidth : 0
    ),
    height: Math.max(
        document.documentElement.scrollHeight,
        document.body ? document.body.scrollHeight : 0
    )
})
`;

export interface BrowserFetchResult {
  url: string;
  content: string;
  status_code: number;
  elapsed_ms: number;
  headers: Record<string, string>;
}

export interface BrowserScreenshotResult {
  url: string;
  buffer: Buffer;
  status_code: number;
  elapsed_ms: number;
}

export interface BrowserActionResult {
  content: Buffer;
  status_code: number;
  media_type: string;
}

/** Authorize one browser request before it leaves the browser (Python parity). */
export type BrowserRequestAuthorizer = (url: string, resourceType: string) => void | Promise<void>;

export interface BrowserSessionOptions {
  authorizeRequest?: BrowserRequestAuthorizer;
  extraHeaders?: Record<string, string>;
  viewport?: BrowserViewport;
  signal?: AbortSignal;
}

export interface BrowserActionOptions {
  action: string;
  target: string | null;
  value: string | null;
  current_url: string;
  timeout_seconds: number;
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

/** Reject when *signal* aborts; otherwise settle with *promise*. */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

interface SemaphoreWaiter {
  release: () => void;
}

/** Counting semaphore with abortable queuing (cancelled waiters leave the queue). */
class Semaphore {
  private available: number;
  private readonly waiters: SemaphoreWaiter[] = [];

  constructor(limit: number) {
    this.available = limit;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    if (signal?.aborted === true) {
      throw abortError(signal);
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const current = signal;
      const waiter: SemaphoreWaiter = {
        release: () => {
          settled = true;
          resolve();
        },
      };
      this.waiters.push(waiter);
      const onAbort = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        settled = true;
        if (current !== undefined) reject(abortError(current));
      };
      if (current !== undefined) {
        current.addEventListener("abort", onAbort, { once: true });
      }
      waiter.release = (): void => {
        if (!settled) {
          settled = true;
          if (current !== undefined) current.removeEventListener("abort", onAbort);
          resolve();
        }
      };
    });
  }

  release(): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter.release();
    else this.available += 1;
  }
}

function isMainFrameRequest(request: Request, page: Page | null): boolean {
  return request.isNavigationRequest() && request.frame() !== null && page !== null && request.frame() === page.mainFrame();
}

function resourceTypeOf(request: Request, page: Page | null): string {
  if (isMainFrameRequest(request, page)) return "main_frame";
  return request.resourceType();
}

/** One isolated BrowserContext retained across a declarative action sequence. */
export class BrowserSession {
  private closed = false;
  private statusCode = 0;
  private navigated = false;

  constructor(
    private readonly pool: NodeBrowserPool,
    private readonly context: BrowserContext,
    readonly page: Page,
    private readonly routeErrors: Error[],
    private readonly authorizeRequest: BrowserRequestAuthorizer,
  ) {}

  /** Goto-layer egress check: run the authorizer before navigation starts. */
  async authorize(url: string, resourceType: string): Promise<void> {
    await this.authorizeRequest(url, resourceType);
  }

  /** Perform one allowlisted declarative browser action. */
  async action(options: BrowserActionOptions): Promise<BrowserActionResult> {
    if (this.closed) {
      throw new Error("browser session is closed");
    }
    const timeoutMs = Math.trunc(options.timeout_seconds * 1000);
    if (options.action === "navigate") {
      const destination = options.value ?? options.target ?? options.current_url;
      if (!destination) {
        throw new Error("browser navigate requires a URL");
      }
      await this.authorize(destination, "main_frame");
      const response = await this.page.goto(destination, { waitUntil: "networkidle", timeout: timeoutMs });
      this.raiseRouteError();
      this.statusCode = response?.status() ?? 0;
      this.navigated = true;
      return { content: Buffer.alloc(0), status_code: this.statusCode, media_type: "text/html" };
    }

    if (!this.navigated) {
      await this.authorize(options.current_url, "main_frame");
      const response = await this.page.goto(options.current_url, { waitUntil: "networkidle", timeout: timeoutMs });
      this.raiseRouteError();
      this.statusCode = response?.status() ?? 0;
      this.navigated = true;
    }

    let content = Buffer.alloc(0);
    let mediaType = "text/html";
    if (options.action === "click") {
      const locator = this.requireLocator(options.target, "click");
      await locator.click({ timeout: timeoutMs });
    } else if (options.action === "fill") {
      const locator = this.requireLocator(options.target, "fill");
      if (options.value === null) {
        throw new Error("browser fill requires a value");
      }
      await locator.fill(options.value, { timeout: timeoutMs });
    } else if (options.action === "select") {
      const locator = this.requireLocator(options.target, "select");
      if (options.value === null) {
        throw new Error("browser select requires a value");
      }
      await locator.selectOption(options.value, { timeout: timeoutMs });
    } else if (options.action === "wait_for") {
      if (options.target === null) {
        throw new Error("browser wait_for requires a target");
      }
      await this.page.waitForSelector(options.target, { state: "visible", timeout: timeoutMs });
    } else if (options.action === "extract") {
      if (options.target === null) {
        const serialized = await this.page.evaluate<unknown>(SERIALIZE_DOCUMENT_BOUNDED, MAX_BROWSER_EXTRACT_BYTES);
        content = Buffer.from(boundedSerializedText(serialized, MAX_BROWSER_EXTRACT_BYTES, "browser extract"), "utf8");
        mediaType = "text/html";
      } else {
        const locator = this.page.locator(options.target);
        const serialized = await locator.evaluate<unknown, number>(SERIALIZE_ELEMENT_BOUNDED, MAX_BROWSER_EXTRACT_BYTES);
        content = Buffer.from(boundedSerializedText(serialized, MAX_BROWSER_EXTRACT_BYTES, "browser extract"), "utf8");
        mediaType = "text/plain";
      }
    } else {
      throw new Error(`unsupported browser action: ${options.action}`);
    }

    this.raiseRouteError();
    if (content.byteLength > MAX_BROWSER_EXTRACT_BYTES) {
      throw new Error(`browser extract exceeded ${MAX_BROWSER_EXTRACT_BYTES} byte limit`);
    }
    return { content, status_code: this.statusCode, media_type: mediaType };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.page.close();
    } catch {
      // The page may already be closed (crash, cancellation); the context
      // must still be released.
    }
    try {
      await this.context.close();
    } catch {
      // Context teardown must not mask the operation's own error.
    }
    this.pool.endOperation();
  }

  /** Surface the first route-layer egress rejection, if any. */
  raiseRouteError(): void {
    if (this.routeErrors.length > 0) throw this.routeErrors[0];
  }

  private requireLocator(target: string | null, action: string): ReturnType<Page["locator"]> {
    if (target === null) {
      throw new Error(`browser ${action} requires a target`);
    }
    return this.page.locator(target);
  }
}

export interface BrowserPoolOptions {
  /** Maximum concurrent BrowserContexts (Python ``max_contexts``, default 4). */
  maxContexts?: number;
  /** Injectable egress policy; defaults to the strict production policy. */
  policy?: BrowserEgressPolicy;
  /** Bounded navigation timeout applied to every ``page.goto`` (ms). */
  navigationTimeoutMs?: number;
  /** Injectable browser launcher (tests); defaults to headless chromium. */
  launcher?: () => Promise<Browser>;
}

export interface BrowserFetchOptions {
  waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
  timeoutMs?: number;
  extraHeaders?: Record<string, string>;
  authorizeRequest?: BrowserRequestAuthorizer;
  signal?: AbortSignal;
}

export interface BrowserScreenshotOptions {
  fullPage?: boolean;
  selector?: string | null;
  viewportWidth?: number;
  viewportHeight?: number;
  waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
  timeoutMs?: number;
  extraHeaders?: Record<string, string>;
  authorizeRequest?: BrowserRequestAuthorizer;
  signal?: AbortSignal;
}

export class NodeBrowserPool {
  private readonly maxContextsValue: number;
  private readonly policy: BrowserEgressPolicy;
  private readonly navigationTimeoutMs: number;
  private readonly launcher: () => Promise<Browser>;
  private readonly semaphore: Semaphore;
  private launchTail: Promise<void> = Promise.resolve();
  private browser: Browser | null = null;
  private started = false;
  private closed = false;
  private active = 0;
  private queued = 0;
  private idleWaiters: Array<() => void> = [];

  constructor(options: BrowserPoolOptions = {}) {
    this.maxContextsValue = options.maxContexts ?? 4;
    if (this.maxContextsValue <= 0) {
      throw new Error("max_contexts must be positive");
    }
    this.policy = options.policy ?? strictBrowserEgressPolicy;
    this.navigationTimeoutMs = options.navigationTimeoutMs ?? DEFAULT_BROWSER_NAVIGATION_TIMEOUT_MS;
    this.launcher = options.launcher ?? (async () => chromium.launch({ headless: true }));
    this.semaphore = new Semaphore(this.maxContextsValue);
  }

  get isStarted(): boolean {
    return this.started;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get maxContexts(): number {
    return this.maxContextsValue;
  }

  get activeOperations(): number {
    return this.active;
  }

  get queuedOperations(): number {
    return this.queued;
  }

  /** Make the pool available; Chromium launches lazily on first use. */
  async start(): Promise<void> {
    if (this.closed) {
      throw new Error("browser pool is closed");
    }
    this.started = true;
  }

  /** Stop accepting work, drain active operations, close the shared browser. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.waitForIdle();
    await this.withLaunchLock(async () => {
      if (this.browser !== null) {
        const browser = this.browser;
        this.browser = null;
        try {
          await browser.close();
        } catch {
          // The browser may already be gone; the pool is still closed.
        }
      }
    });
  }

  /** Render one page in an isolated context (Python ``BrowserPool.fetch``). */
  async fetch(url: string, options: BrowserFetchOptions = {}): Promise<BrowserFetchResult> {
    const startedAt = Date.now();
    const session = await this.openSession({
      authorizeRequest: options.authorizeRequest,
      extraHeaders: options.extraHeaders,
      signal: options.signal,
    });
    try {
      await session.authorize(url, "main_frame");
      const response = await this.navigate(session, url, options.waitUntil ?? "networkidle", options.timeoutMs, options.signal);
      const serialized = await session.page.evaluate<unknown>(SERIALIZE_DOCUMENT_BOUNDED, MAX_BROWSER_CONTENT_BYTES);
      const content = boundedSerializedText(serialized, MAX_BROWSER_CONTENT_BYTES, "browser content");
      return {
        url,
        content,
        status_code: response?.status() ?? 0,
        elapsed_ms: Date.now() - startedAt,
        headers: response?.headers() ?? {},
      };
    } finally {
      await session.close();
    }
  }

  /** Capture a bounded PNG in an isolated context (Python ``BrowserPool.screenshot``). */
  async screenshot(url: string, options: BrowserScreenshotOptions = {}): Promise<BrowserScreenshotResult> {
    const startedAt = Date.now();
    const viewportWidth = options.viewportWidth ?? DEFAULT_VIEWPORT.width;
    const viewportHeight = options.viewportHeight ?? DEFAULT_VIEWPORT.height;
    validateViewportDimensions(viewportWidth, viewportHeight);
    const fullPage = options.fullPage ?? true;
    const selector = options.selector ?? null;
    if (!fullPage && selector === null && viewportWidth * viewportHeight > MAX_BROWSER_SCREENSHOT_PIXELS) {
      throw new Error(`browser screenshot exceeded ${MAX_BROWSER_SCREENSHOT_PIXELS} pixel limit`);
    }
    const session = await this.openSession({
      authorizeRequest: options.authorizeRequest,
      extraHeaders: options.extraHeaders,
      viewport: { width: viewportWidth, height: viewportHeight },
      signal: options.signal,
    });
    try {
      await session.authorize(url, "main_frame");
      const response = await this.navigate(session, url, options.waitUntil ?? "networkidle", options.timeoutMs, options.signal);
      await enforceScreenshotDimensions(session.page, { fullPage, selector, viewportWidth, viewportHeight });
      const timeout = options.timeoutMs ?? this.navigationTimeoutMs;
      const capture = selector === null ? session.page.screenshot({ fullPage, timeout }) : session.page.locator(selector).screenshot({ timeout });
      capture.catch(() => undefined);
      let content: Buffer;
      try {
        content = await abortable(capture, options.signal);
      } catch (error) {
        session.raiseRouteError();
        throw error;
      }
      if (content.byteLength > MAX_BROWSER_SCREENSHOT_BYTES) {
        throw new Error(`browser screenshot exceeded ${MAX_BROWSER_SCREENSHOT_BYTES} byte limit`);
      }
      return {
        url: response?.url() ?? url,
        buffer: content,
        status_code: response?.status() ?? 0,
        elapsed_ms: Date.now() - startedAt,
      };
    } finally {
      await session.close();
    }
  }

  /** Acquire one isolated context for a declarative action sequence. */
  async openSession(options: BrowserSessionOptions = {}): Promise<BrowserSession> {
    this.queued += 1;
    try {
      await this.semaphore.acquire(options.signal);
    } catch (error) {
      this.queued -= 1;
      throw error;
    }
    this.queued -= 1;
    if (!this.started) {
      this.semaphore.release();
      throw new Error("browser pool is not started");
    }
    if (this.closed) {
      this.semaphore.release();
      throw new Error("browser pool is closed");
    }
    this.active += 1;
    try {
      const browser = await this.ensureBrowser();
      const authorizedHosts = new Set<string>();
      const authorizeRequest = options.authorizeRequest ?? (async (url) => {
        await this.policy.validateUrl(url, authorizedHosts);
      });
      const routeErrors: Error[] = [];
      let context: BrowserContext | null = null;
      let page: Page | null = null;
      try {
        context = await browser.newContext({
          userAgent: BROWSER_UA,
          extraHTTPHeaders: options.extraHeaders ?? {},
          viewport: options.viewport ?? DEFAULT_VIEWPORT,
          locale: "en-US",
          acceptDownloads: false,
          serviceWorkers: "block",
        });
        await context.addInitScript(STEALTH_SCRIPT);
        await context.route("**/*", async (route: Route) => {
          const request = route.request();
          const isMainFrame = isMainFrameRequest(request, page);
          try {
            await authorizeRequest(request.url(), resourceTypeOf(request, page));
            await route.continue();
          } catch (error) {
            const failure = error instanceof Error ? error : new Error(String(error));
            if (isMainFrame) routeErrors.push(failure);
            await route.abort();
            if (isMainFrame) throw failure;
          }
        });
        page = await context.newPage();
        return new BrowserSession(this, context, page, routeErrors, authorizeRequest);
      } catch (error) {
        try {
          await page?.close();
        } catch {
          // Page teardown is best-effort on the failure path.
        }
        try {
          await context?.close();
        } catch {
          // Context teardown is best-effort on the failure path.
        }
        throw error;
      }
    } catch (error) {
      this.endOperation();
      throw error;
    }
  }

  /** Internal: release one operation slot (called by ``BrowserSession.close``). */
  endOperation(): void {
    this.active -= 1;
    this.semaphore.release();
    this.notifyIdle();
  }

  private async navigate(
    session: BrowserSession,
    url: string,
    waitUntil: BrowserFetchOptions["waitUntil"],
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Response | null> {
    const navigation = session.page.goto(url, {
      waitUntil: waitUntil ?? "networkidle",
      timeout: timeoutMs ?? this.navigationTimeoutMs,
    });
    navigation.catch(() => undefined);
    try {
      return await abortable(navigation, signal);
    } catch (error) {
      // Surface a route-layer egress rejection deterministically.
      session.raiseRouteError();
      throw error;
    }
  }

  private async ensureBrowser(): Promise<Browser> {
    return this.withLaunchLock(async () => {
      if (this.browser !== null) return this.browser;
      if (this.closed) {
        throw new Error("browser pool is closed");
      }
      const browser = await this.launcher();
      this.browser = browser;
      return browser;
    });
  }

  private async withLaunchLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.launchTail;
    let release: () => void = () => undefined;
    this.launchTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private waitForIdle(): Promise<void> {
    if (this.active === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private notifyIdle(): void {
    if (this.active === 0 && this.idleWaiters.length > 0) {
      const waiters = this.idleWaiters.splice(0);
      for (const waiter of waiters) waiter();
    }
  }
}

/** Python ``_bounded_serialized_text`` parity: validate the measured payload. */
function boundedSerializedText(serialized: unknown, limit: number, label: string): string {
  if (typeof serialized !== "object" || serialized === null || Array.isArray(serialized)) {
    throw new Error(`${label} serialization is invalid`);
  }
  const record = serialized as Record<string, unknown>;
  const sizeBytes = record["size_bytes"];
  if (typeof sizeBytes === "boolean" || typeof sizeBytes !== "number" || !Number.isInteger(sizeBytes) || sizeBytes < 0) {
    throw new Error(`${label} size measurement is invalid`);
  }
  if (sizeBytes > limit) {
    throw new Error(`${label} exceeded ${limit} byte limit`);
  }
  if (record["over_limit"] !== false) {
    throw new Error(`${label} serialization is invalid`);
  }
  const content = record["content"];
  if (typeof content !== "string") {
    throw new Error(`${label} serialization is invalid`);
  }
  if (Buffer.byteLength(content, "utf8") !== sizeBytes) {
    throw new Error(`${label} size measurement is invalid`);
  }
  return content;
}

function validateViewportDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error("browser viewport dimensions must be positive integers");
  }
}

async function enforceScreenshotDimensions(
  page: Page,
  options: { fullPage: boolean; selector: string | null; viewportWidth: number; viewportHeight: number },
): Promise<void> {
  let width: number;
  let height: number;
  if (options.selector !== null) {
    const box = await page.locator(options.selector).boundingBox();
    if (box === null) {
      throw new Error(`browser screenshot selector is not visible: ${options.selector}`);
    }
    width = box.width;
    height = box.height;
  } else if (options.fullPage) {
    const dimensions = await page.evaluate<{ width: number; height: number }>(SERIALIZE_DOCUMENT_DIMENSIONS);
    width = dimensions.width;
    height = dimensions.height;
  } else {
    width = options.viewportWidth;
    height = options.viewportHeight;
  }
  if (width <= 0 || height <= 0 || width * height > MAX_BROWSER_SCREENSHOT_PIXELS) {
    throw new Error(`browser screenshot exceeded ${MAX_BROWSER_SCREENSHOT_PIXELS} pixel limit`);
  }
}
