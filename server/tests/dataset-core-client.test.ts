import { describe, expect, test, vi } from "vitest";

import {
  DatasetCoreBridgeError,
  DatasetCoreClient,
} from "../src/legacy/dataset-core-client.js";
import { datasetBuildSpec as spec } from "./dataset-bridge-fixture.js";

describe("DatasetCoreClient", () => {
  const identity = {
    taskId: "task_1",
    runId: "run_1",
    piSessionId: "pi_1",
    toolCallId: "tool_1",
  } as const;

  test("requires a loopback target and validates response correlation", async () => {
    expect(() => new DatasetCoreClient({ baseUrl: "https://example.com", fetch: vi.fn() })).toThrow(/loopback/i);
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      return new Response(JSON.stringify({
        version: 1,
        request_id: `${request.request_id}_wrong`,
        ok: true,
        data: { valid: true, reason_codes: [], reasons: [] },
        error: null,
      }));
    });
    const client = new DatasetCoreClient({ baseUrl: "http://127.0.0.1:8000", secret: "secret", fetch, requestId: () => "request_1" });

    await expect(client.validate({ ...identity, spec })).rejects.toMatchObject({ code: "bridge_unavailable" });
  });

  test("requires a non-empty bridge secret", () => {
    expect(
      () => new DatasetCoreClient({ baseUrl: "http://127.0.0.1:8000" }),
    ).toThrow(/bridge secret/i);
    expect(
      () => new DatasetCoreClient({ baseUrl: "http://127.0.0.1:8000", secret: "  " }),
    ).toThrow(/bridge secret/i);
  });

  test("maps transport failures to bridge_unavailable", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const client = new DatasetCoreClient({
      baseUrl: "http://127.0.0.1:8000",
      secret: "secret",
      fetch,
      requestId: () => "request_unavailable",
    });

    await expect(
      client.validate({ ...identity, spec }),
    ).rejects.toMatchObject({ code: "bridge_unavailable" });
  });

  test("sends the configured private secret only to the private bridge", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      version: 1, request_id: "request_1", ok: true,
      data: { valid: true, reason_codes: [], reasons: [] }, error: null,
    })));
    const client = new DatasetCoreClient({ baseUrl: "http://localhost:8000", secret: "secret", fetch, requestId: () => "request_1" });
    await client.validate({ ...identity, spec });

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:8000/internal/migration/pi/dataset/operations",
      expect.objectContaining({ headers: expect.objectContaining({ "x-biomed-bridge-secret": "secret" }) }),
    );
  });

  test("on AbortSignal sends cancellation and waits for acknowledged original result", async () => {
    let resolveOriginal!: (response: Response) => void;
    const original = new Promise<Response>((resolve) => { resolveOriginal = resolve; });
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/cancel")) {
        resolveOriginal(new Response(JSON.stringify({
          version: 1, request_id: "request_cancel", ok: false, data: null,
          error: { code: "cancelled", message: "cancelled", retryable: false, details: { cancellation_source: "abort_signal" } },
        })));
        return new Response(JSON.stringify({ status: "cancel_requested" }), { status: 202 });
      }
      return original;
    });
    const client = new DatasetCoreClient({ baseUrl: "http://127.0.0.1:8000", secret: "secret", fetch, requestId: () => "request_cancel", cancellationTimeoutMs: 1000 });
    const controller = new AbortController();
    const result = client.execute({
      ...identity, spec,
      sourceFiles: { binding: "source_assets/file.tsv" }, mappingFiles: {}, signal: controller.signal,
    });
    controller.abort();

    await expect(result).resolves.toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith("/request_cancel/cancel"))).toBe(true);
  });

  test("does not claim cancellation when original acknowledgement is unavailable", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/cancel")) return new Response("{}", { status: 202 });
      return new Promise<Response>(() => undefined);
    });
    const client = new DatasetCoreClient({ baseUrl: "http://127.0.0.1:8000", secret: "secret", fetch, requestId: () => "request_timeout", cancellationTimeoutMs: 5 });
    const controller = new AbortController();
    const result = client.execute({ ...identity, spec, sourceFiles: {}, mappingFiles: {}, signal: controller.signal });
    controller.abort();
    const error = await result.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(DatasetCoreBridgeError);
    expect(error).toMatchObject({ code: "bridge_unavailable" });
  });

  test("sends complete cross-layer correlation in the request envelope", async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      return new Response(JSON.stringify({
        version: 1,
        request_id: request.request_id,
        ok: true,
        data: { valid: true, reason_codes: [], reasons: [] },
        error: null,
      }));
    });
    const client = new DatasetCoreClient({
      baseUrl: "http://127.0.0.1:8000",
      secret: "secret",
      fetch,
      requestId: () => "request_correlated",
    });

    await client.validate({
      taskId: "task_1",
      runId: "run_1",
      piSessionId: "pi_1",
      toolCallId: "tool_1",
      spec,
    });

    expect(JSON.parse(String(fetch.mock.calls[0]?.[1].body))).toMatchObject({
      request_id: "request_correlated",
      task_id: "task_1",
      run_id: "run_1",
      pi_session_id: "pi_1",
      tool_call_id: "tool_1",
    });
  });
});
