import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConversationList } from "@/components/conversation/ConversationList";
import type { ConversationItem } from "@/runtime/types";

const { renderConversationStep } = vi.hoisted(() => ({
  renderConversationStep: vi.fn(),
}));

vi.mock("@/components/ui/message-scroller", () => ({
  MessageScrollerItem: ({
    children,
    messageId,
    scrollAnchor,
  }: {
    children: ReactNode;
    messageId: string;
    scrollAnchor?: boolean;
  }) => (
    <div
      data-message-id={messageId}
      data-scroll-anchor={scrollAnchor === true ? "true" : "false"}
      data-testid="message-scroller-item"
    >
      {children}
    </div>
  ),
}));

vi.mock("@/components/conversation/ConversationStep", () => ({
  ConversationStep: ({ item }: { item: ConversationItem }) => {
    renderConversationStep(item.itemId);
    return <div data-testid={`conversation-step-${item.itemId}`}>{item.kind}</div>;
  },
}));

const BASE = {
  runId: "run-1",
  sequence: 1,
  createdAt: "2026-08-10T00:00:00Z",
} as const;

const USER_ITEM: ConversationItem = {
  ...BASE,
  itemId: "user-1",
  kind: "user_message",
  content: "正文",
};

const ARTIFACT_ITEM: ConversationItem = {
  ...BASE,
  itemId: "artifact-1",
  kind: "artifact",
  artifactId: "artifact-1",
  name: "result.csv",
  sizeBytes: 1024,
  mediaType: "text/csv",
};

const ASSISTANT_ITEM: ConversationItem = {
  ...BASE,
  itemId: "assistant-1",
  kind: "assistant_segment",
  streamId: "stream-1",
  content: "第一段",
  isStreaming: true,
  finishReason: null,
};

describe("ConversationList", () => {
  beforeEach(() => {
    renderConversationStep.mockClear();
  });

  it("does not create an empty message wrapper for artifact items", () => {
    render(<ConversationList items={[USER_ITEM, ARTIFACT_ITEM]} activeRunId={null} />);

    expect(screen.getAllByTestId("message-scroller-item")).toHaveLength(1);
    expect(screen.getByTestId("message-scroller-item")).toHaveAttribute(
      "data-message-id",
      "user-1",
    );
    expect(screen.queryByTestId("conversation-step-artifact-1")).not.toBeInTheDocument();
  });

  it("lets MessageScroller follow the live edge instead of anchoring user turns", () => {
    render(<ConversationList items={[USER_ITEM]} activeRunId="run-1" />);

    expect(screen.getByTestId("message-scroller-item")).toHaveAttribute(
      "data-scroll-anchor",
      "false",
    );
  });

  it("does not rerender an unchanged historical row when the live row grows", () => {
    const { rerender } = render(
      <ConversationList
        items={[USER_ITEM, ASSISTANT_ITEM]}
        activeRunId="run-1"
      />,
    );

    rerender(
      <ConversationList
        items={[
          USER_ITEM,
          { ...ASSISTANT_ITEM, content: "第一段继续输出" },
        ]}
        activeRunId="run-1"
      />,
    );

    expect(renderConversationStep.mock.calls.filter(([id]) => id === "user-1")).toHaveLength(1);
    expect(
      renderConversationStep.mock.calls.filter(([id]) => id === "assistant-1"),
    ).toHaveLength(2);
  });
});
