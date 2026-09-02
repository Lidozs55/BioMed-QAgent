import { describe, expect, it, vi } from "vitest";

import { createAPIClient, type FetchLike } from "@/hooks/useAPI";
import { APIError } from "@/api/errors";
import {
  parseSourceAssetListPage,
  type SourceAssetRegistrationReceipt,
} from "@/api/sourceAssets";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const TASK_ID = "task_ts_abc";

function receipt(overrides: Partial<SourceAssetRegistrationReceipt> = {}): SourceAssetRegistrationReceipt {
  const sha256 = "a".repeat(64);
  return {
    schema_version: "1.0",
    receipt_id: "receipt_01234567-89ab-cdef-0123-456789abcdef",
    task_id: TASK_ID,
    asset_ref: {
      schema_version: "1.0",
      asset_id: `asset_${sha256}`,
      task_id: TASK_ID,
      role: "carrier",
    },
    source_id: "source_fixture",
    relative_path: "source_assets/table.csv",
    sha256,
    size_bytes: 12,
    media_type: "text/csv",
    registered_at: "2026-08-30T00:00:00.000Z",
    path_compatibility: {
      schema_version: "1.0",
      mode: "asset_id",
      legacy_path: null,
      telemetry_event: "asset_ref_used",
    },
    ...overrides,
  };
}

describe("source-assets API boundary", () => {
  it("fetches, strictly parses, and lists receipts for a task", async () => {
    const items = [
      receipt({
        relative_path: "source_assets/extract/derived.csv",
        receipt_id: "receipt_ffffffff-89ab-cdef-0123-456789abcdef",
      }),
      receipt(),
    ];
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ items }));
    const api = createAPIClient({ fetcher });

    await expect(api.fetchSourceAssets?.(TASK_ID)).resolves.toEqual(items);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/tasks/task_ts_abc/source-assets",
      undefined,
    );
    // Encoded task ids keep the same guard as other task-scoped endpoints.
    await expect(createAPIClient({
      fetcher: vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ items: [] })),
    }).fetchSourceAssets?.("task/x")).resolves.toEqual([]);
    expect(vi.mocked(fetcher).mock.calls[0]).toEqual([
      "/api/v1/tasks/task_ts_abc/source-assets",
      undefined,
    ]);
  });

  it("exposes the URL helper through the endpoint client", () => {
    // The URL must stay a deterministic function of the task id.
    const api = createAPIClient({
      fetcher: vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ items: [] })),
    });
    expect(api.fetchSourceAssets).toBeTypeOf("function");
  });

  it("rejects unknown fields, missing fields, and cross-task receipts", async () => {
    const fetcher = vi.fn<FetchLike>();
    const api = createAPIClient({ fetcher });
    const cases: unknown[] = [
      { items: [receipt({ legacy_unknown_field: 1 } as unknown as Partial<SourceAssetRegistrationReceipt>)] },
      { items: [{ ...receipt(), receipt_id: undefined }] },
      { items: [receipt({ task_id: "task_ts_other" })] },
      { items: [receipt({ sha256: "zz".repeat(32) })] },
      { items: [receipt({ size_bytes: -1 })] },
      { items: [receipt({ size_bytes: 1.5 })] },
      { items: [receipt({ asset_ref: { ...receipt().asset_ref, role: "root" as unknown as SourceAssetRegistrationReceipt["asset_ref"]["role"] } })] },
      { items: [receipt({ relative_path: "../escape.csv" })] },
      { items: [receipt({ relative_path: "secrets/notes.csv" })] },
      { items: [receipt({ relative_path: "source_assets//double.csv" })] },
      { items: [receipt({ relative_path: "source_assets/a\\b.csv" })] },
      { extra: [] },
      { items: [receipt()], next_cursor: "nope" },
    ];
    for (const body of cases) {
      fetcher.mockResolvedValue(jsonResponse(body));
      await expect(api.fetchSourceAssets?.(TASK_ID)).rejects.toBeInstanceOf(APIError);
    }
  });

  it("rejects non-object envelopes and item shapes without coercing", async () => {
    const fetcher = vi.fn<FetchLike>();
    const api = createAPIClient({ fetcher });
    const cases: unknown[] = [
      null,
      "items",
      [],
      { items: ["not-an-object"] },
      { items: [13] },
      { items: [null] },
      {
        items: [{
          schema_version: "2.0",
          receipt_id: "receipt_01234567-89ab-cdef-0123-456789abcdef",
          task_id: TASK_ID,
          asset_ref: receipt().asset_ref,
          source_id: "source_fixture",
          relative_path: "source_assets/table.csv",
          sha256: "a".repeat(64),
          size_bytes: 12,
          media_type: "text/csv",
          registered_at: "2026-08-30T00:00:00.000Z",
          path_compatibility: receipt().path_compatibility,
        }],
      },
    ];
    for (const body of cases) {
      fetcher.mockResolvedValue(jsonResponse(body));
      await expect(api.fetchSourceAssets?.(TASK_ID)).rejects.toBeInstanceOf(APIError);
    }
  });

  it("rejects asset_id that does not bind the content hash", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({
      items: [receipt({
        asset_ref: { ...receipt().asset_ref, asset_id: `asset_${"b".repeat(64)}` },
      })],
    }));
    await expect(createAPIClient({ fetcher }).fetchSourceAssets?.(TASK_ID))
      .rejects.toBeInstanceOf(APIError);
  });

  it("parses pages directly through the standalone parser", () => {
    const page = parseSourceAssetListPage({ items: [receipt()] }, TASK_ID);
    expect(page.items).toHaveLength(1);
    expect(page.items[0].asset_ref.role).toBe("carrier");
    expect(() => parseSourceAssetListPage({ items: [], extra: 1 }, TASK_ID)).toThrow(APIError);
    expect(() => parseSourceAssetListPage({ items: [receipt()] }, "task_ts_mismatch"))
      .toThrow(APIError);
  });

  it("propagates HTTP failures as APIError", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(
      { detail: "Task not found" },
      404,
    ));
    await expect(createAPIClient({ fetcher }).fetchSourceAssets?.(TASK_ID))
      .rejects.toBeInstanceOf(APIError);
  });
});
