import { describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import { useAPI } from "@/hooks/useAPI"

describe("useAPI", () => {
  it("creates an explicit fixture task and uses artifact_id for downloads", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ task_id: "task_1", status: "completed" }),
    })
    vi.stubGlobal("fetch", fetchMock)
    const { result } = renderHook(() => useAPI())

    await result.current.createTask(
      "breast cancer gene expression",
      ["pubmed", "geo"],
    )

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic: "breast cancer gene expression",
        databases: ["pubmed", "geo"],
        mode: "fixture",
      }),
    })
    expect(result.current.getArtifactUrl("task_1", "artifact_abc")).toBe(
      "/api/v1/tasks/task_1/artifacts/artifact_abc",
    )
  })
})
