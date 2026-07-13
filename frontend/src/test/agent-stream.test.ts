import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { useAgentStream } from "@/hooks/useAgentStream"
import { useAgentStore, type WSEvent } from "@/stores/agentStore"

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

  emit(event: WSEvent) {
    this.onmessage?.(new MessageEvent("message", {
      data: JSON.stringify(event),
    }))
  }
}

describe("useAgentStream", () => {
  beforeEach(() => {
    vi.stubGlobal("WebSocket", FakeWebSocket)
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

  it("archives the previous task before sending a new research task", () => {
    useAgentStore.setState({
      taskId: "task-old",
      currentSessionId: "task-old",
      messages: [{ id: "old-message", role: "user", content: "Old task" }],
      traces: [{ id: "old-trace", kind: "tool_call", name: "search_pubmed" }],
      artifacts: [{ artifactId: "old-artifact", name: "old.csv", size: 10 }],
      selectedDatabases: ["pubmed", "geo"],
      pipelineStage: "done",
    })
    const { result } = renderHook(() => useAgentStream())

    act(() => result.current.connect())
    act(() => result.current.send("New task", ["pubmed", "geo"]))

    const state = useAgentStore.getState()
    expect(state.sessions.map((session) => session.taskId)).toContain("task-old")
    expect(state.taskId).toBeNull()
    expect(state.messages.map((message) => message.content)).toEqual(["New task"])
    expect(state.traces).toEqual([])
    expect(state.artifacts).toEqual([])
    expect(state.selectedDatabases).toEqual(["pubmed", "geo"])
  })

  it("discards a failed draft without a task id before sending again", () => {
    useAgentStore.setState({
      messages: [{ id: "draft-message", role: "user", content: "Failed draft" }],
      traces: [{ id: "draft-error", kind: "error", message: "Disconnected" }],
      artifacts: [{ artifactId: "draft-artifact", name: "draft.csv", size: 10 }],
      selectedDatabases: ["pubmed", "geo"],
      pipelineStage: "error",
    })
    const { result } = renderHook(() => useAgentStream())

    act(() => result.current.connect())
    act(() => result.current.send("Retry cleanly", ["pubmed", "geo"]))

    const state = useAgentStore.getState()
    expect(state.taskId).toBeNull()
    expect(state.messages).toEqual([
      expect.objectContaining({ role: "user", content: "Retry cleanly" }),
    ])
    expect(state.traces).toEqual([])
    expect(state.artifacts).toEqual([])
    expect(state.selectedDatabases).toEqual(["pubmed", "geo"])
  })

  it("persists the final response after marking a websocket task done", () => {
    const { result } = renderHook(() => useAgentStream())
    act(() => result.current.connect())
    act(() => result.current.send("Run task", ["pubmed", "geo"]))
    act(() => FakeWebSocket.latest.emit({ type: "task_started", task_id: "task-new" }))
    act(() => FakeWebSocket.latest.emit({ type: "done", final_output: "Final answer" }))

    const state = useAgentStore.getState()
    expect(state.pipelineStage).toBe("done")
    expect(state.isRunning).toBe(false)
    expect(
      state.sessions[0].messages[state.sessions[0].messages.length - 1]?.content,
    ).toBe("Final answer")
    expect(state.sessions[0].pipelineStage).toBe("done")
  })

  it("persists websocket errors in the failed session", () => {
    const { result } = renderHook(() => useAgentStream())
    act(() => result.current.connect())
    act(() => result.current.send("Run task", ["pubmed", "geo"]))
    act(() => FakeWebSocket.latest.emit({ type: "task_started", task_id: "task-error" }))
    act(() => FakeWebSocket.latest.emit({ type: "error", message: "Model unavailable" }))

    const state = useAgentStore.getState()
    expect(state.pipelineStage).toBe("error")
    expect(
      state.sessions[0].traces[state.sessions[0].traces.length - 1]?.message,
    ).toBe("Model unavailable")
    expect(state.sessions[0].pipelineStage).toBe("error")
  })
})
