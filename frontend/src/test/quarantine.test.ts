import { describe, expect, it, vi } from "vitest";

import { createAPIClient, type FetchLike } from "@/hooks/useAPI";
import { APIError } from "@/api/errors";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const receipt = {
  schema_version: "1.0",
  submission_id: "submission/1",
  task_id: "task/1",
  name: "notes.csv",
  media_type: "text/csv",
  source_note: "manual export",
  coverage_status: "partial",
  covered_scope: ["samples"],
  missing_scope: ["outcomes"],
  size_bytes: 3,
  sha256: "a".repeat(64),
  submitted_at: "2026-08-30T00:00:00Z",
  authoritative: false,
  trust: "untrusted",
};

describe("quarantine API boundary", () => {
  it("parses receipts and encodes task and submission IDs", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ items: [receipt] }));
    const api = createAPIClient({ fetcher });

    await expect(api.fetchQuarantine?.("task/1")).resolves.toEqual([receipt]);
    expect(fetcher).toHaveBeenCalledWith("/api/v1/tasks/task%2F1/quarantine", undefined);
    expect(api.getQuarantineContentUrl?.("task/1", "submission/1")).toBe(
      "/api/v1/tasks/task%2F1/quarantine/submission%2F1/content",
    );
  });

  it("fetches one receipt through the encoded detail path", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(receipt));
    const api = createAPIClient({ fetcher });

    await expect(api.fetchQuarantineReceipt?.("task/1", "submission/1")).resolves.toEqual(receipt);
    expect(fetcher).toHaveBeenCalledWith("/api/v1/tasks/task%2F1/quarantine/submission%2F1", undefined);
  });

  it("posts JSON bytes with an idempotency request ID", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(receipt, 201));
    const api = createAPIClient({
      fetcher,
      randomUUID: () => "12345678-1234-1234-1234-123456789abc",
    });

    await expect(api.submitQuarantine?.("task/1", {
      name: "notes.csv",
      media_type: "text/csv",
      coverage_status: "unknown",
      covered_scope: [],
      missing_scope: [],
      bytes_base64: "eA==",
    })).resolves.toEqual(receipt);

    expect(fetcher).toHaveBeenCalledWith("/api/v1/tasks/task%2F1/quarantine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "notes.csv",
        media_type: "text/csv",
        coverage_status: "unknown",
        covered_scope: [],
        missing_scope: [],
        bytes_base64: "eA==",
        idempotency_key: "req_12345678-1234-1234-1234-123456789abc",
      }),
    });
  });

  it("rejects a receipt that claims authority or has a malformed digest", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({
      items: [{ ...receipt, authoritative: true, sha256: "bad" }],
    }));
    await expect(createAPIClient({ fetcher }).fetchQuarantine?.("task_1")).rejects.toBeInstanceOf(APIError);
  });
});
