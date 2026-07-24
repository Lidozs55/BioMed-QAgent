import { describe, expect, it, vi } from "vitest";
import { createAPIClient, type FetchLike } from "@/hooks/useAPI";

/* ------------------------------------------------------------------ */
/*  Multipart File identity tests via actual RequestInit.body capture  */
/*  No FormData.prototype spies — pure fetch call capture.            */
/* ------------------------------------------------------------------ */

describe("uploadSkill exact File identity via fetch body", () => {
  it("captures exact File reference from actual FormData body", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(new Response("{}", { status: 200 }));
    const api = createAPIClient({ fetcher });
    const file = new File(['{"name":"test"}'], "test-skill.yaml", { type: "application/x-yaml" });

    await api.uploadSkill(file);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const call = fetcher.mock.calls[0];
    expect(call).toBeDefined();
    const [url, init] = call;
    expect(url).toBe("/api/v1/skills/upload");
    if (init === undefined) throw new Error("Expected init object");
    expect(init.method).toBe("POST");
    expect(init.headers).toBeUndefined();
    expect(init.body).toBeInstanceOf(FormData);
    if (init.body instanceof FormData) {
      const f = init.body.get("file");
      if (!(f instanceof File)) throw new Error("Expected File for form field 'file'");
      expect(f).toBe(file);
    }
  });
});

describe("startImportTask FormData fields via fetch body", () => {
  it("includes request_id, input, and files fields with exact File objects", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(new Response(JSON.stringify({ status: "queued", request_id: "req_abc", task_id: "t1", run_id: "r1" }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const api = createAPIClient({ fetcher, randomUUID: () => "custom" });
    const fileA = new File(["a"], "a.csv", { type: "text/csv" });
    const fileB = new File(["b"], "b.csv", { type: "text/csv" });

    await api.startImportTask({ files: [fileA, fileB], note: "my note" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const call = fetcher.mock.calls[0];
    expect(call).toBeDefined();
    const [url, init] = call;
    expect(url).toBe("/api/v1/import/tasks");
    if (init === undefined) throw new Error("Expected init object");
    expect(init.method).toBe("POST");
    expect(init.headers).toBeUndefined();
    expect(init.body).toBeInstanceOf(FormData);
    if (init.body instanceof FormData) {
      expect(init.body.get("request_id")).toBe("req_custom");
      expect(init.body.get("input")).toBe("my note");
      const entries = init.body.getAll("files");
      expect(entries).toHaveLength(2);
      if (!(entries[0] instanceof File)) throw new Error("Expected File at files[0]");
      if (!(entries[1] instanceof File)) throw new Error("Expected File at files[1]");
      expect(entries[0]).toBe(fileA);
      expect(entries[1]).toBe(fileB);
    }
  });

  it("trims note before sending via actual FormData body", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(new Response(JSON.stringify({ status: "queued", request_id: "req_abc", task_id: "t1", run_id: "r1" }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const api = createAPIClient({ fetcher, randomUUID: () => "trim" });

    await api.startImportTask({ files: [], note: "  padded note  " });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const call = fetcher.mock.calls[0];
    expect(call).toBeDefined();
    const [, init] = call;
    if (init === undefined) throw new Error("Expected init object");
    expect(init.body).toBeInstanceOf(FormData);
    if (init.body instanceof FormData) {
      expect(init.body.get("input")).toBe("padded note");
    }
  });
});
