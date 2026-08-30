import { describe, expect, it, vi } from "vitest";

import { createAPIClient, type FetchLike } from "@/hooks/useAPI";
import { APIError } from "@/api/errors";
import type { QuarantineReceipt } from "@/api/quarantine";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const receipt: QuarantineReceipt = {
  schema_version: "1.0",
  submission_id: "ua_0123456789abcdef01234567",
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
    expect(api.getQuarantineContentUrl?.("task/1", receipt.submission_id)).toBe(
      `/api/v1/tasks/task%2F1/quarantine/${receipt.submission_id}/content`,
    );
  });

  it("fetches one receipt through the encoded detail path", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(receipt));
    const api = createAPIClient({ fetcher });

    await expect(api.fetchQuarantineReceipt?.("task/1", receipt.submission_id)).resolves.toEqual(receipt);
    expect(fetcher).toHaveBeenCalledWith(
      `/api/v1/tasks/task%2F1/quarantine/${receipt.submission_id}`,
      undefined,
    );
  });

  it("posts metadata and file as multipart form data", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(receipt, 201));
    const api = createAPIClient({ fetcher });
    const file = new File(["x"], "notes.csv", { type: "text/csv" });

    await expect(api.submitQuarantine?.("task/1", {
      file,
      source_note: "manual export",
      coverage_status: "unknown",
      covered_scope: [],
      missing_scope: [],
    })).resolves.toEqual(receipt);

    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe("/api/v1/tasks/task%2F1/quarantine");
    const init = call?.[1];
    expect(init?.method).toBe("POST");
    expect(init?.headers).toBeUndefined();
    expect(init?.body).toBeInstanceOf(FormData);
    const form = init?.body as FormData;
    expect(JSON.parse(String(form.get("metadata")))).toEqual({
      schema_version: "1.0",
      name: "notes.csv",
      media_type: "text/csv",
      source_note: "manual export",
      coverage_status: "unknown",
      covered_scope: [],
      missing_scope: [],
    });
    expect(form.get("file")).toBe(file);
  });

  it("rejects a receipt that claims authority or has a malformed digest", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({
      items: [{ ...receipt, authoritative: true, sha256: "bad" }],
    }));
    await expect(createAPIClient({ fetcher }).fetchQuarantine?.("task_1")).rejects.toBeInstanceOf(APIError);
  });
});
