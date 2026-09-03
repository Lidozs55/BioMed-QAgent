import { randomUUID } from "node:crypto";

/**
 * Bounded search-result entry captured from Bailian's OpenAI-compatible
 * ``search_info`` payload. Shape matches the ``ProviderSearchResult`` wire
 * contract in @biomed/contracts so it can flow through events and message
 * records without re-mapping.
 */
export interface ProviderSearchResult {
  site_name: string;
  url: string;
  title?: string;
  icon?: string;
}

export const SEARCH_PROBE_HEADER = "x-biomed-search-probe";

const MAX_RESULTS = 20;
const MAX_FIELD_LENGTH = 200;
/** A quiet mirror stream for this long cancels the probe and frees the slot. */
const MIRROR_INACTIVITY_TIMEOUT_MS = 30_000;
const DASHSCOPE_HOSTS = new Set([
  "dashscope.aliyuncs.com",
  "dashscope-intl.aliyuncs.com",
]);
const CHAT_COMPLETIONS_PATH = /\/compatible-mode\/v1\/chat\/completions$/u;

/**
 * One in-flight streaming request's capture slot. ``done`` always resolves
 * (never rejects) — with whatever bounded results were collected, possibly
 * empty after a timeout or a non-SSE response.
 */
export interface SearchCaptureSlot {
  results: ProviderSearchResult[];
  done: Promise<ProviderSearchResult[]>;
  resolve: (results: ProviderSearchResult[]) => void;
}

const probeRegistry = new Map<string, SearchCaptureSlot>();

function boundedField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  return trimmed.length <= MAX_FIELD_LENGTH ? trimmed : trimmed.slice(0, MAX_FIELD_LENGTH);
}

/**
 * Extract bounded results from a chunk's ``search_info`` value. Defensive by
 * design: anything that does not match the documented
 * ``{ search_results: [{ site_name, icon, url, ... }] }`` shape yields fewer
 * or zero entries instead of throwing.
 */
export function parseSearchInfo(value: unknown): ProviderSearchResult[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  const rawResults = (value as { search_results?: unknown }).search_results;
  if (!Array.isArray(rawResults)) return [];
  const results: ProviderSearchResult[] = [];
  for (const raw of rawResults) {
    if (results.length >= MAX_RESULTS) break;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const url = boundedField(record.url);
    if (url === undefined) continue;
    const entry: ProviderSearchResult = {
      site_name: boundedField(record.site_name) ?? "",
      url,
    };
    const title = boundedField(record.title);
    if (title !== undefined) entry.title = title;
    const icon = boundedField(record.icon);
    if (icon !== undefined) entry.icon = icon;
    results.push(entry);
  }
  return results;
}

/**
 * Incrementally scan the mirror SSE stream for ``search_info`` and resolve the
 * slot when the stream ends, errors, or goes quiet. Non-fatal by contract:
 * capture failure must never disturb the model request itself.
 */
function pumpMirror(mirror: ReadableStream<Uint8Array>, slot: SearchCaptureSlot): void {
  const reader = mirror.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    slot.resolve(slot.results);
  };
  const armInactivityGuard = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      void reader.cancel().catch(() => {});
    }, MIRROR_INACTIVITY_TIMEOUT_MS);
  };
  armInactivityGuard();
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        armInactivityGuard();
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const rawEvent = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          for (const line of rawEvent.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "" || data === "[DONE]") continue;
            try {
              const chunk = JSON.parse(data) as { search_info?: unknown };
              if (chunk.search_info !== undefined) {
                const room = MAX_RESULTS - slot.results.length;
                if (room > 0) {
                  slot.results.push(...parseSearchInfo(chunk.search_info).slice(0, room));
                }
              }
            } catch {
              // Non-JSON data frame (keepalives, comments): ignore.
            }
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // Mirror read failure (abort, cancellation): keep partial results.
    } finally {
      finish();
    }
  })();
}

type FetchInput = Parameters<typeof fetch>[0];

function requestUrl(input: FetchInput): URL | null {
  try {
    if (typeof input === "string") return new URL(input);
    if (input instanceof URL) return input;
    return new URL(input.url);
  } catch {
    return null;
  }
}

function probeIdFromHeaders(headers: unknown): string | null {
  if (headers instanceof Headers) return headers.get(SEARCH_PROBE_HEADER);
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      if (key.toLowerCase() === SEARCH_PROBE_HEADER) return value;
    }
    return null;
  }
  if (headers !== null && typeof headers === "object") {
    const value = (headers as Record<string, unknown>)[SEARCH_PROBE_HEADER];
    return typeof value === "string" ? value : null;
  }
  return null;
}

function probeSlotForRequest(
  input: FetchInput,
  init: RequestInit | undefined,
): SearchCaptureSlot | null {
  const probeId = probeIdFromHeaders(init?.headers)
    ?? (typeof input === "object" && input !== null && "headers" in input
      ? probeIdFromHeaders((input as Request).headers)
      : null);
  if (probeId === null) return null;
  const slot = probeRegistry.get(probeId);
  if (slot === undefined) return null;
  const url = requestUrl(input);
  if (url === null || !DASHSCOPE_HOSTS.has(url.hostname)) return null;
  if (!CHAT_COMPLETIONS_PATH.test(url.pathname)) return null;
  return slot;
}

let probeInstalled = false;
let originalFetch: typeof fetch | undefined;

/**
 * Install the process-wide fetch tee that mirrors DashScope chat-completions
 * SSE responses into registered capture slots. Requests without a registered
 * probe header (or to other hosts/paths) pass through untouched. Idempotent;
 * the returned disposer fully restores the previous fetch (tests only).
 */
export function installSearchInfoProbe(): () => void {
  if (probeInstalled) return () => {};
  probeInstalled = true;
  originalFetch = globalThis.fetch;
  const patched: typeof fetch = async (input, init) => {
    const slot = probeSlotForRequest(input, init);
    if (slot === null) return (originalFetch as typeof fetch)(input, init);
    let response: Response;
    try {
      response = await (originalFetch as typeof fetch)(input, init);
    } catch (error) {
      // The model call itself failed; release the slot so the probe registry
      // cannot leak, and let the transport error propagate untouched.
      slot.resolve([]);
      throw error;
    }
    try {
      const contentType = response.headers.get("content-type") ?? "";
      if (response.body === null || !contentType.includes("text/event-stream")) {
        slot.resolve([]);
        return response;
      }
      const [main, mirror] = response.body.tee();
      pumpMirror(mirror, slot);
      return new Response(main, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch {
      return response;
    }
  };
  globalThis.fetch = patched;
  return () => {
    if (!probeInstalled) return;
    globalThis.fetch = originalFetch as typeof fetch;
    originalFetch = undefined;
    probeInstalled = false;
  };
}

/** Register a per-request capture slot keyed by the probe header value. */
export function registerSearchProbe(): { probeId: string; slot: SearchCaptureSlot } {
  const probeId = `probe_${randomUUID()}`;
  let resolve!: (results: ProviderSearchResult[]) => void;
  const done = new Promise<ProviderSearchResult[]>((resolveSlot) => {
    resolve = resolveSlot;
  });
  const slot: SearchCaptureSlot = { results: [], done, resolve };
  probeRegistry.set(probeId, slot);
  return { probeId, slot };
}

/** Drop a finished probe slot; safe to call more than once. */
export function releaseSearchProbe(probeId: string): void {
  probeRegistry.delete(probeId);
}
