/**
 * HTTP transport for the frontend API clients.
 *
 * Shared request plumbing (fetch, error mapping, query building, request ids,
 * admission retry) used by the per-endpoint client modules in ``./tasks.ts``,
 * ``./publications.ts``, ``./settings.ts``, ``./modelRegistry.ts`` and
 * ``./databases.ts``.
 */
import { APIError } from "@/api/errors";

const DEFAULT_BASE_URL = "/api/v1";

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface AdmissionOptions {
  requestId?: string;
}

export interface HttpOptions {
  baseUrl?: string;
  fetcher?: FetchLike;
  randomUUID?: () => string;
}

function defaultRandomUUID(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  // Fallback for environments where crypto.randomUUID is unavailable
  // (e.g., insecure contexts, older browsers)
  const seed = globalThis.crypto?.getRandomValues
    ? () => globalThis.crypto.getRandomValues(new Uint8Array(1))[0]
    : () => Math.floor(Math.random() * 256);
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (seed() & 15) >> (c === 'x' ? 0 : 3);
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export interface Http {
  readonly baseUrl: string;
  readonly fetcher: FetchLike;
  readonly randomUUID: () => string;

  encodeId(value: string): string;
  withQuery(
    url: string,
    entries: ReadonlyArray<readonly [string, string | number | null | undefined]>,
  ): string;

  /** Fetch + error-mapped JSON body as unknown (callers narrow with parsers). */
  request(url: string, init?: RequestInit): Promise<unknown>;
  /** Fetch that only checks the HTTP status (no body parsing). */
  requestVoid(url: string, init?: RequestInit): Promise<void>;
  /** Fetch + error-mapped raw text body (task-file CSV downloads). */
  requestText(url: string, init?: RequestInit): Promise<string>;
  /** Fetch + parse + runtime-validate with an endpoint parser. */
  requestJson<T>(url: string, init: RequestInit | undefined, parse: (body: unknown) => T): Promise<T>;
  /** POST with one retry for ambiguous network failures (admission path). */
  postAdmission(url: string, body: string): Promise<unknown>;
  /** Extract the error detail from a non-2xx response body. */
  errorDetail(response: Response): Promise<unknown>;
  requestId(provided?: string): string;
}

export function createHttp(options: HttpOptions = {}): Http {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const fetcher: FetchLike = options.fetcher ?? ((input, init) => fetch(input, init));
  const randomUUID = options.randomUUID ?? defaultRandomUUID;

  const parseResponse = async (response: Response): Promise<unknown> => {
    if (!response.ok) throw new APIError(response.status, await errorDetail(response));
    return response.json() as Promise<unknown>;
  };

  const errorDetail = async (response: Response): Promise<unknown> => {
    try {
      const body: unknown = await response.json();
      if (typeof body === "object" && body !== null && "detail" in body) {
        return Reflect.get(body, "detail");
      }
      return body;
    } catch {
      return response.statusText || `API request failed (${response.status})`;
    }
  };

  const request = async (url: string, init?: RequestInit): Promise<unknown> => {
    return parseResponse(await fetcher(url, init));
  };

  const requestVoid = async (url: string, init?: RequestInit): Promise<void> => {
    const response = await fetcher(url, init);
    if (!response.ok) throw new APIError(response.status, await errorDetail(response));
  };

  const requestText = async (url: string, init?: RequestInit): Promise<string> => {
    const response = await fetcher(url, init);
    if (!response.ok) throw new APIError(response.status, await errorDetail(response));
    return response.text();
  };

  const postAdmission = async (url: string, body: string): Promise<unknown> => {
    const init: RequestInit = { method: "POST", headers: { "Content-Type": "application/json" }, body };
    let response: Response;
    try { response = await fetcher(url, init); }
    catch { response = await fetcher(url, init); }
    return parseResponse(response);
  };

  return {
    baseUrl,
    fetcher,
    randomUUID,
    encodeId: (value: string): string => encodeURIComponent(value),
    withQuery(url, entries) {
      const query = new URLSearchParams();
      for (const [key, value] of entries) {
        if (value !== undefined && value !== null) query.set(key, String(value));
      }
      const serialized = query.toString();
      return serialized.length === 0 ? url : `${url}?${serialized}`;
    },
    request,
    requestVoid,
    requestText,
    requestJson: <T,>(url: string, init: RequestInit | undefined, parse: (body: unknown) => T): Promise<T> =>
      request(url, init).then((body) => parse(body)),
    postAdmission,
    errorDetail,
    requestId: (provided?: string): string => provided ?? `req_${randomUUID()}`,
  };
}
