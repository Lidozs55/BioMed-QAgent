import { beforeAll, beforeEach, describe, expect, it } from "vitest"
import { render } from "@testing-library/react"
import { SessionSidebar } from "@/components/SessionSidebar"
import { SidebarProvider } from "@/components/ui/sidebar"
import { useAgentStore } from "@/stores/agentStore"

describe("SessionSidebar", () => {
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
      sessions: [{
        taskId: "task-sidebar",
        topic: "Sidebar structure",
        databases: ["pubmed", "geo"],
        createdAt: 1,
        messageCount: 0,
        messages: [],
        traces: [],
        artifacts: [],
        pipelineStage: "done",
      }],
      currentSessionId: "task-sidebar",
      isConnected: true,
      isRunning: false,
      artifacts: [],
      taskId: "task-sidebar",
      pipelineStage: "done",
    })
  })

  it("renders session navigation and delete as sibling controls", () => {
    const { container, getByRole } = render(
      <SidebarProvider>
        <SessionSidebar />
      </SidebarProvider>,
    )

    expect(container.querySelector("button button")).toBeNull()
    expect(getByRole("button", { name: "删除 Sidebar structure" })).toBeVisible()
  })
})
