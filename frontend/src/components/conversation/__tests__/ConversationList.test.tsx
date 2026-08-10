import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConversationList } from "@/components/conversation/ConversationList";
import type { ConversationItem } from "@/runtime/types";

vi.mock("@/components/ui/message-scroller", () => ({
  MessageScrollerItem: ({ children, messageId }: { children: ReactNode; messageId: string }) => (
    <div data-message-id={messageId} data-testid="message-scroller-item">
      {children}
    </div>
  ),
}));

vi.mock("@/components/conversation/ConversationStep", () => ({
  ConversationStep: ({ item }: { item: ConversationItem }) => (
    <div data-testid={`conversation-step-${item.itemId}`}>{item.kind}</div>
  ),
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

describe("ConversationList", () => {
  it("does not create an empty message wrapper for artifact items", () => {
    render(<ConversationList items={[USER_ITEM, ARTIFACT_ITEM]} activeRunId={null} />);

    expect(screen.getAllByTestId("message-scroller-item")).toHaveLength(1);
    expect(screen.getByTestId("message-scroller-item")).toHaveAttribute(
      "data-message-id",
      "user-1",
    );
    expect(screen.queryByTestId("conversation-step-artifact-1")).not.toBeInTheDocument();
  });
});
