import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  QueuedMessages,
  type QueuedMessage,
} from "@/components/QueuedMessages";

const ENTRIES: QueuedMessage[] = [
  { id: "a", input: "message one" },
  { id: "b", input: "message two" },
];

describe("QueuedMessages", () => {
  it("renders each entry on a single truncated line", () => {
    render(
      <QueuedMessages
        entries={ENTRIES}
        onDelete={vi.fn()}
        onEdit={vi.fn()}
        onSteer={vi.fn()}
        onReorder={vi.fn()}
      />,
    );

    const first = screen.getByText("message one");
    expect(first).toBeInTheDocument();
    expect(first.className).toContain("truncate");
    expect(screen.getByText("message two")).toBeInTheDocument();
  });

  it("invokes delete/edit/steer handlers with the entry id", () => {
    const onDelete = vi.fn();
    const onEdit = vi.fn();
    const onSteer = vi.fn();
    render(
      <QueuedMessages
        entries={ENTRIES}
        onDelete={onDelete}
        onEdit={onEdit}
        onSteer={onSteer}
        onReorder={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "删除：message one" }));
    expect(onDelete).toHaveBeenCalledWith("a");
    fireEvent.click(screen.getByRole("button", { name: "编辑：message two" }));
    expect(onEdit).toHaveBeenCalledWith("b");
    fireEvent.click(screen.getByRole("button", { name: "调整方向：message one" }));
    expect(onSteer).toHaveBeenCalledWith("a");
  });

  it("reorders entries via drag and drop", () => {
    const onReorder = vi.fn();
    render(
      <QueuedMessages
        entries={ENTRIES}
        onDelete={vi.fn()}
        onEdit={vi.fn()}
        onSteer={vi.fn()}
        onReorder={onReorder}
      />,
    );

    const first = screen.getByText("message one").closest(
      "[draggable='true']",
    ) as HTMLElement;
    const second = screen.getByText("message two").closest(
      "[draggable='true']",
    ) as HTMLElement;
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    fireEvent.dragStart(first);
    fireEvent.dragOver(second);
    fireEvent.drop(second);
    expect(onReorder).toHaveBeenCalledWith(0, 1);
  });
});
