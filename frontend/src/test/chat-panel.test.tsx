import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { ChatPanel } from "@/components/ChatPanel"
import { DatabaseSelector } from "@/components/DatabaseSelector"
import { useAgentStore } from "@/stores/agentStore"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe("ChatPanel", () => {
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
      messages: [],
      traces: [],
      isConnected: true,
      isRunning: false,
      databases: [
        { id: "pubmed", name: "PubMed", category: "discovery", description: "Literature" },
        { id: "geo", name: "GEO", category: "acquisition", description: "Expression" },
      ],
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

  it("shows fixture source validation next to the research form", () => {
    render(<ChatPanel send={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText("输入研究目标..."), {
      target: { value: "Review validation" },
    })
    fireEvent.click(screen.getByRole("button", { name: "运行固定验收案例" }))

    expect(screen.getByRole("alert")).toHaveTextContent(
      "固定验收案例只能选择 PubMed 和 GEO。",
    )
    expect(useAgentStore.getState().traces).toEqual([])
  })

  it("does not carry a fixture validation error into a corrected run", async () => {
    const fetchMock = vi.fn((input: string | URL | Request) => Promise.resolve({
      ok: true,
      json: async () => input === "/api/v1/tasks"
        ? { task_id: "task_fixture", status: "completed" }
        : { artifacts: [] },
    }))
    vi.stubGlobal("fetch", fetchMock)
    render(<ChatPanel send={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText("输入研究目标..."), {
      target: { value: "Run corrected fixture" },
    })
    fireEvent.click(screen.getByRole("button", { name: "运行固定验收案例" }))
    expect(screen.getByRole("alert")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "全选" }))
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "运行固定验收案例" }))

    await waitFor(() => {
      expect(useAgentStore.getState().taskId).toBe("task_fixture")
      expect(useAgentStore.getState().isRunning).toBe(false)
    })
    expect(useAgentStore.getState().traces).toEqual([])
  })

  it("clears fixture errors when the workspace is reset", () => {
    render(<ChatPanel send={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText("输入研究目标..."), {
      target: { value: "Invalid fixture" },
    })
    fireEvent.click(screen.getByRole("button", { name: "运行固定验收案例" }))
    expect(screen.getByRole("alert")).toBeInTheDocument()

    act(() => useAgentStore.getState().reset())

    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("clears fixture errors when a saved session is loaded", () => {
    useAgentStore.setState({
      sessions: [{
        taskId: "task_saved",
        topic: "Saved task",
        databases: ["pubmed", "geo"],
        createdAt: 1,
        messageCount: 1,
        messages: [{ id: "saved-message", role: "user", content: "Saved task" }],
        traces: [],
        artifacts: [],
        pipelineStage: "done",
      }],
    })
    render(<ChatPanel send={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText("输入研究目标..."), {
      target: { value: "Invalid fixture" },
    })
    fireEvent.click(screen.getByRole("button", { name: "运行固定验收案例" }))
    expect(screen.getByRole("alert")).toBeInTheDocument()

    act(() => useAgentStore.getState().loadSession("task_saved"))

    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("ignores artifacts returned for a task that is no longer active", async () => {
    const artifactRequest = deferred<{
      ok: boolean
      json: () => Promise<{
        artifacts: Array<{
          artifact_id: string
          name: string
          size: number
          sha256: string
          media_type: string
        }>
      }>
    }>()
    const fetchMock = vi.fn().mockReturnValue(artifactRequest.promise)
    vi.stubGlobal("fetch", fetchMock)
    useAgentStore.setState({ taskId: "task_old" })

    render(<ChatPanel send={vi.fn()} />)

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/tasks/task_old/artifacts", undefined)
    act(() => {
      useAgentStore.setState({
        taskId: "task_new",
        isRunning: true,
        artifacts: [{ artifactId: "current", name: "current.csv", size: 10 }],
      })
    })
    await act(async () => {
      artifactRequest.resolve({
        ok: true,
        json: async () => ({
          artifacts: [{
            artifact_id: "stale",
            name: "stale.csv",
            size: 20,
            sha256: "hash",
            media_type: "text/csv",
          }],
        }),
      })
      await artifactRequest.promise
    })

    await waitFor(() => {
      expect(useAgentStore.getState().artifacts).toEqual([
        { artifactId: "current", name: "current.csv", size: 10 },
      ])
    })
  })

  it("archives and clears an old task before starting a fixture", async () => {
    const createRequest = deferred<{
      ok: boolean
      json: () => Promise<{ task_id: string; status: string }>
    }>()
    const fetchMock = vi.fn((input: string | URL | Request) => {
      if (input === "/api/v1/tasks") return createRequest.promise
      return Promise.resolve({
        ok: true,
        json: async () => ({ artifacts: [] }),
      })
    })
    vi.stubGlobal("fetch", fetchMock)
    useAgentStore.setState({
      taskId: "task_old",
      currentSessionId: "task_old",
      selectedDatabases: ["pubmed", "geo"],
      messages: [{ id: "old-message", role: "assistant", content: "Old answer" }],
      traces: [{ id: "old-trace", kind: "tool_output", output: "Old trace" }],
      artifacts: [{ artifactId: "old-artifact", name: "old.csv", size: 10 }],
      pipelineStage: "done",
    })
    render(<ChatPanel send={vi.fn()} />)
    fireEvent.click(screen.getByRole("tab", { name: "设置" }))
    fireEvent.change(screen.getByPlaceholderText("输入研究目标..."), {
      target: { value: "Run fresh fixture" },
    })

    fireEvent.click(screen.getByRole("button", { name: "运行固定验收案例" }))

    const runningState = useAgentStore.getState()
    expect(runningState.sessions).toEqual([
      expect.objectContaining({
        taskId: "task_old",
        messages: [{ id: "old-message", role: "assistant", content: "Old answer" }],
        traces: [{ id: "old-trace", kind: "tool_output", output: "Old trace" }],
        artifacts: [{ artifactId: "old-artifact", name: "old.csv", size: 10 }],
      }),
    ])
    expect(runningState.taskId).toBeNull()
    expect(runningState.selectedDatabases).toEqual(["pubmed", "geo"])
    expect(runningState.messages).toEqual([
      expect.objectContaining({ role: "user", content: "Run fresh fixture" }),
    ])
    expect(runningState.traces).toEqual([])
    expect(runningState.artifacts).toEqual([])

    await act(async () => {
      createRequest.resolve({
        ok: true,
        json: async () => ({ task_id: "task_new", status: "completed" }),
      })
      await createRequest.promise
    })
    await waitFor(() => {
      expect(useAgentStore.getState().taskId).toBe("task_new")
      expect(useAgentStore.getState().isRunning).toBe(false)
    })
  })

  it("clears an untracked draft before starting a fixture", async () => {
    const createRequest = deferred<{
      ok: boolean
      json: () => Promise<{ task_id: string; status: string }>
    }>()
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
      if (input === "/api/v1/tasks") return createRequest.promise
      return Promise.resolve({
        ok: true,
        json: async () => ({ artifacts: [] }),
      })
    }))
    useAgentStore.setState({
      selectedDatabases: ["pubmed", "geo"],
      messages: [{ id: "draft-message", role: "user", content: "Failed draft" }],
      traces: [{ id: "draft-error", kind: "error", message: "Failed before start" }],
      artifacts: [{ artifactId: "draft-artifact", name: "draft.csv", size: 10 }],
      pipelineStage: "error",
    })
    render(<ChatPanel send={vi.fn()} />)
    fireEvent.click(screen.getByRole("tab", { name: "设置" }))
    fireEvent.change(screen.getByPlaceholderText("输入研究目标..."), {
      target: { value: "Clean fixture" },
    })

    fireEvent.click(screen.getByRole("button", { name: "运行固定验收案例" }))

    const runningState = useAgentStore.getState()
    expect(runningState.messages).toEqual([
      expect.objectContaining({ role: "user", content: "Clean fixture" }),
    ])
    expect(runningState.traces).toEqual([])
    expect(runningState.artifacts).toEqual([])
    expect(runningState.selectedDatabases).toEqual(["pubmed", "geo"])

    await act(async () => {
      createRequest.resolve({
        ok: true,
        json: async () => ({ task_id: "task_clean", status: "completed" }),
      })
      await createRequest.promise
    })
    await waitFor(() => {
      expect(useAgentStore.getState().taskId).toBe("task_clean")
    })
  })

  it("disables every database selection control while a task is running", () => {
    useAgentStore.setState({ isRunning: true })

    render(<DatabaseSelector />)

    expect(screen.getByRole("button", { name: "全选" })).toBeDisabled()
    expect(screen.getByRole("button", { name: /PubMed/ })).toBeDisabled()
    expect(screen.getByRole("button", { name: /GEO/ })).toBeDisabled()
  })

  it("notifies consumers when selecting and clearing all databases", () => {
    const onToggle = vi.fn()
    render(<DatabaseSelector onToggle={onToggle} />)

    fireEvent.click(screen.getByRole("button", { name: "全选" }))
    expect(onToggle).toHaveBeenNthCalledWith(1, "pubmed", true)
    expect(onToggle).toHaveBeenNthCalledWith(2, "geo", true)

    fireEvent.click(screen.getByRole("button", { name: "取消全选" }))
    expect(onToggle).toHaveBeenNthCalledWith(3, "pubmed", false)
    expect(onToggle).toHaveBeenNthCalledWith(4, "geo", false)
  })
})
