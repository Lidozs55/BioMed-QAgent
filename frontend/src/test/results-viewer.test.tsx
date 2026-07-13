import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import ResultsViewer from "@/components/ResultsViewer"
import { useAgentStore } from "@/stores/agentStore"

describe("ResultsViewer", () => {
  beforeEach(() => {
    useAgentStore.setState({
      messages: [],
      traces: [],
      isConnected: true,
      isRunning: false,
      artifacts: [{ artifactId: "artifact-csv", name: "results.csv", size: 64 }],
      taskId: "task-results",
      pipelineStage: "done",
    })
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "gene,description\nTP53,\"tumor protein, p53\"",
    }))
  })

  it("preserves quoted commas in CSV preview cells", async () => {
    render(<ResultsViewer />)
    fireEvent.click(screen.getByRole("button", { name: "CSV 预览" }))

    expect(await screen.findByText("tumor protein, p53")).toBeVisible()
  })
})
