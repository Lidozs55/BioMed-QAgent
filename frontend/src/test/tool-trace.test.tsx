import { act, fireEvent, render, screen } from "@testing-library/react"
import { beforeAll, beforeEach, describe, expect, it } from "vitest"

import { ToolTrace } from "@/components/ToolTrace"
import { useAgentStore } from "@/stores/agentStore"

describe("ToolTrace", () => {
  beforeAll(() => {
    window.matchMedia = () => ({
      matches: false,
      media: "",
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    })
  })

  beforeEach(() => {
    useAgentStore.setState({
      traces: [{ id: "trace-1", kind: "tool_call", name: "search" }],
      isConnected: true,
      isRunning: true,
    })
  })

  it("disables clearing traces while a task is running", async () => {
    render(<ToolTrace />)
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Toggle tool trace" }))
    })

    expect(screen.getByRole("button", { name: "清除" })).toBeDisabled()
  })
})
