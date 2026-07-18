import { act, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatPanel } from "@/components/ChatPanel";
import { MarkdownContent } from "@/components/MarkdownContent";
import type { EventPayload } from "@/runtime/contracts";
import { createInitialRuntimeState } from "@/runtime/reducer";
import { useAgentStore } from "@/stores/agentStore";

const globalCss = readFileSync(
  join(process.cwd(), "src", "styles", "global.css"),
  "utf8",
);

const TIMESTAMP = "2026-07-18T00:00:00Z";

function seedStreamingTask(): void {
  useAgentStore.getState().mergeTaskPage(
    {
      active_items: [
        {
          task_id: "task_stream",
          mode: "agent",
          databases: [],
          title: "Streaming",
          status: "running",
          active_run_id: "run_stream",
          created_at: TIMESTAMP,
          updated_at: TIMESTAMP,
          latest_sequence: 0,
        },
      ],
      items: [],
      next_cursor: null,
    },
    false,
  );
  useAgentStore.getState().setActiveTaskId("task_stream");
  useAgentStore.getState().applyAssistantStreamFrames([
    {
      type: "assistant_stream_delta",
      task_id: "task_stream",
      run_id: "run_stream",
      stream_id: "assistant:run_stream",
      chunk_index: 0,
      delta: "实时文本",
    },
  ]);
}

function applyBoundary(payload: EventPayload): void {
  useAgentStore.getState().applyEvent({
    schema_version: "2.0",
    event_id: "event_boundary",
    type: payload.type,
    task_id: "task_stream",
    run_id: "run_stream",
    stage_attempt_id: null,
    sequence: 1,
    timestamp: TIMESTAMP,
    payload,
  });
}

describe("streaming Markdown cursor", () => {
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
    });
  });

  beforeEach(() => {
    useAgentStore.setState({
      ...createInitialRuntimeState(),
      connectionStatus: "connected",
    });
  });

  it("marks only actively streaming Markdown as busy", () => {
    const { container, rerender } = render(
      <MarkdownContent content="正在生成" streaming />,
    );
    const markdown = container.querySelector(".markdown-content");
    expect(markdown).toHaveAttribute("data-streaming", "true");
    expect(markdown).toHaveAttribute("aria-busy", "true");
    expect(markdown).not.toHaveAttribute("aria-live");

    rerender(<MarkdownContent content="生成完成" streaming={false} />);
    expect(markdown).toHaveAttribute("data-streaming", "false");
    expect(markdown).toHaveAttribute("aria-busy", "false");
  });

  it("passes active state only to the matching assistant run", () => {
    seedStreamingTask();
    useAgentStore.setState((state) => ({
      tasksById: {
        ...state.tasksById,
        task_stream: {
          ...state.tasksById.task_stream,
          messages: [
            {
              messageId: "historical",
              taskId: "task_stream",
              runId: "run_old",
              ordinal: 1,
              role: "assistant",
              content: "历史文本",
              createdAt: TIMESTAMP,
              sequence: null,
            },
            ...state.tasksById.task_stream.messages,
          ],
        },
      },
    }));

    const { container } = render(
      <ChatPanel startTask={vi.fn()} continueTask={vi.fn()} />,
    );

    expect(screen.getByText("实时文本").closest(".markdown-content")).toHaveAttribute(
      "data-streaming",
      "true",
    );
    expect(screen.getByText("历史文本").closest(".markdown-content")).toHaveAttribute(
      "data-streaming",
      "false",
    );
    expect(container.querySelectorAll('.markdown-content[data-streaming="true"]')).toHaveLength(1);
  });

  it.each<EventPayload>([
    { type: "tool_started", tool_call_id: "call_1", tool_name: "search" },
    { type: "run_finalizing" },
    { type: "run_completed" },
    { type: "run_failed", error: "boom" },
    { type: "run_cancelled", reason: "stop" },
    { type: "run_interrupted", reason: "restart" },
  ])("hides the cursor after $type", (payload) => {
    seedStreamingTask();
    applyBoundary(payload);

    render(<ChatPanel startTask={vi.fn()} continueTask={vi.fn()} />);

    expect(screen.getByText("实时文本").closest(".markdown-content")).toHaveAttribute(
      "data-streaming",
      "false",
    );
  });

  it("hides the cursor after realtime end and disconnect deactivation", () => {
    seedStreamingTask();
    act(() => {
      useAgentStore.getState().applyAssistantStreamFrames([
        {
          type: "assistant_stream_end",
          task_id: "task_stream",
          run_id: "run_stream",
          stream_id: "assistant:run_stream",
          last_chunk_index: 0,
          finish_reason: "stop",
        },
      ]);
      useAgentStore.getState().deactivateAssistantStreams("task_stream");
    });

    render(<ChatPanel startTask={vi.fn()} continueTask={vi.fn()} />);

    expect(screen.getByText("实时文本").closest(".markdown-content")).toHaveAttribute(
      "data-streaming",
      "false",
    );
  });

  it("defines a pseudo cursor and disables blinking for reduced motion", () => {
    expect(globalCss).toContain('.markdown-content[data-streaming="true"] > :last-child::after');
    expect(globalCss).toContain("@keyframes assistant-stream-cursor-blink");
    expect(globalCss).toContain("@media (prefers-reduced-motion: reduce)");
    expect(globalCss).toMatch(/prefers-reduced-motion:[\s\S]*animation:\s*none/);
  });
});
