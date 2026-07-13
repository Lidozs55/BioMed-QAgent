import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import App from "@/App"
import { useAgentStore } from "@/stores/agentStore"

class FakeWebSocket {
  static OPEN = 1
  static latest: FakeWebSocket

  readyState = FakeWebSocket.OPEN
  onopen: ((event: Event) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  sent: string[] = []

  constructor(public readonly url: string) {
    FakeWebSocket.latest = this
  }

  send(payload: string) {
    this.sent.push(payload)
  }

  close() {
    this.readyState = 3
  }

  open() {
    this.onopen?.(new Event("open"))
  }
}

describe("App agent stream ownership", () => {
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
    vi.stubGlobal("WebSocket", FakeWebSocket)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ databases: [] }),
    }))
    useAgentStore.setState({
      messages: [],
      traces: [],
      isConnected: false,
      isRunning: false,
      databases: [],
      selectedDatabases: [],
      artifacts: [],
      taskId: null,
      fixtureError: null,
      sessions: [],
      currentSessionId: null,
      pipelineStage: "idle",
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("sends from ChatPanel through the websocket connected by App", async () => {
    render(<App />)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    act(() => FakeWebSocket.latest.open())
    fireEvent.change(screen.getByPlaceholderText("输入研究目标..."), {
      target: { value: "Find biomarkers" },
    })

    fireEvent.click(screen.getByRole("button", { name: "开始研究" }))

    expect(FakeWebSocket.latest.sent).toEqual([
      JSON.stringify({ type: "run", input: "Find biomarkers" }),
    ])
  })
})
