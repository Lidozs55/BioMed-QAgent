import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import QuarantinePanel from "@/components/QuarantinePanel";
import type { QuarantineReceipt } from "@/api/quarantine";
import { createAPIClient, type FetchLike } from "@/hooks/useAPI";
import { useAPI } from "@/hooks/useAPI";

vi.mock("@/hooks/useAPI", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useAPI")>();
  return { ...actual, useAPI: vi.fn() };
});

const receipt: QuarantineReceipt = {
  schema_version: "1.0",
  submission_id: "submission_1",
  task_id: "task_1",
  name: "manual.csv",
  media_type: "text/csv",
  source_note: "from lab notebook",
  coverage_status: "partial",
  covered_scope: ["samples"],
  missing_scope: ["outcomes"],
  size_bytes: 12,
  sha256: "b".repeat(64),
  submitted_at: "2026-08-30T00:00:00Z",
  authoritative: false,
  trust: "untrusted",
};

const mockedUseAPI = vi.mocked(useAPI);

describe("QuarantinePanel", () => {
  it("loads and displays quarantine metadata separately from artifacts", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(new Response(JSON.stringify({ items: [receipt] })));
    const api = createAPIClient({ fetcher });
    mockedUseAPI.mockReturnValue(api);

    render(<QuarantinePanel taskId="task_1" />);

    expect(await screen.findByText("manual.csv")).toBeVisible();
    expect(screen.getByText("非权威 / 未经准入")).toBeVisible();
    expect(screen.getByText("覆盖部分范围")).toBeVisible();
    expect(screen.getByText("samples")).toBeVisible();
    expect(screen.getByText("outcomes")).toBeVisible();
    expect(screen.getByText("from lab notebook")).toBeVisible();
    expect(screen.getByText(`${receipt.size_bytes} bytes`)).toBeVisible();
    expect(screen.getByText(receipt.sha256)).toBeVisible();
    expect(screen.getByRole("button", { name: "下载" })).toBeEnabled();
    expect(fetcher).toHaveBeenCalledWith("/api/v1/tasks/task_1/quarantine", undefined);
  });

  it("uploads selected file fields and refreshes the list", async () => {
    const fetcher = vi.fn<FetchLike>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify(receipt)));
    const api = createAPIClient({
      fetcher,
      randomUUID: () => "12345678-1234-1234-1234-123456789abc",
    });
    mockedUseAPI.mockReturnValue(api);

    const { container } = render(<QuarantinePanel taskId="task_1" />);
    const fileInput = container.querySelector("input[type=file]");
    if (!(fileInput instanceof HTMLInputElement)) throw new Error("file input missing");
    fireEvent.change(fileInput, { target: { files: [new File(["x"], "manual.csv", { type: "text/csv" })] } });
    fireEvent.click(await screen.findByRole("button", { name: "提交到隔离区" }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/v1/tasks/task_1/quarantine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "manual.csv",
        media_type: "text/csv",
        coverage_status: "unknown",
        covered_scope: [],
        missing_scope: [],
        bytes_base64: "eA==",
        idempotency_key: "req_12345678-1234-1234-1234-123456789abc",
      }),
    }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
  });
});
