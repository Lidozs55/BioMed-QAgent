import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { OperationStep } from "@/components/conversation/OperationStep";
import type { OperationItem } from "@/runtime/types";

const TIMESTAMP = "2026-07-20T00:00:00Z";

function makeOperation(
  partial: Partial<OperationItem> & { operationId: string },
): OperationItem {
  return {
    kind: "operation",
    itemId: `operation:run-1:${partial.operationId}`,
    runId: "run-1",
    sequence: 1,
    createdAt: TIMESTAMP,
    label: null,
    category: null,
    status: "running",
    progress: null,
    error: null,
    ...partial,
  };
}

describe("OperationStep", () => {
  it("renders the operation label with a category-derived icon and running badge", () => {
    const item = makeOperation({
      operationId: "stage:discovery",
      label: "文献/数据发现",
      category: "discovery",
      status: "running",
      progress: { kind: "records_found", current: 42, total: 100, detail: null, updatedAt: TIMESTAMP },
    });
    render(<OperationStep item={item} />);
    expect(screen.getByText("文献/数据发现")).toBeInTheDocument();
    expect(screen.getByText("运行中")).toBeInTheDocument();
    // Category identity is carried on the icon element for grouping/iconography.
    const icon = screen.getByTestId("operation-icon");
    expect(icon).toHaveAttribute("data-operation-category", "discovery");
    // While running the row shows the inline progress summary.
    expect(screen.getByText("42/100")).toBeInTheDocument();
  });

  it("falls back to operation_id when the label is empty", () => {
    const item = makeOperation({
      operationId: "acquire:pubmed",
      label: "",
      category: "pubmed",
      status: "completed",
    });
    render(<OperationStep item={item} />);
    expect(screen.getByText("acquire:pubmed")).toBeInTheDocument();
    expect(screen.getByText("已完成")).toBeInTheDocument();
  });

  it("falls back to category when both label and operation_id are empty", () => {
    const item = makeOperation({
      operationId: "",
      label: null,
      category: "parse",
      status: "completed",
    });
    render(<OperationStep item={item} />);
    expect(screen.getByText("parse")).toBeInTheDocument();
  });

  it("auto-collapses a completed operation into a compact summary row, expandable on click", () => {
    const item = makeOperation({
      operationId: "compatibility_gate",
      label: "兼容性检查",
      category: "validation",
      status: "completed",
      progress: { kind: "rows_checked", current: 5000, total: 5000, detail: null, updatedAt: TIMESTAMP },
      error: null,
    });
    render(<OperationStep item={item} />);
    // Completed: compact summary row — label + status visible, detail hidden.
    expect(screen.getByText("兼容性检查")).toBeInTheDocument();
    expect(screen.getByText("已完成")).toBeInTheDocument();
    expect(screen.queryByText("5000/5000")).not.toBeInTheDocument();

    // Expand on click reveals the detail (progress).
    fireEvent.click(screen.getByRole("button", { name: /兼容性检查/ }));
    expect(screen.getByText("5000/5000")).toBeInTheDocument();

    // Collapse again on a second click (manual toggle preserved).
    fireEvent.click(screen.getByRole("button", { name: /兼容性检查/ }));
    expect(screen.queryByText("5000/5000")).not.toBeInTheDocument();
  });

  it("renders failed operations with the error detail hidden behind the expand toggle", () => {
    const item = makeOperation({
      operationId: "parse:geo",
      label: "解析 GEO 数据",
      category: "processing",
      status: "failed",
      error: "schema mismatch",
    });
    render(<OperationStep item={item} />);
    expect(screen.getByText("解析 GEO 数据")).toBeInTheDocument();
    expect(screen.getByText("失败")).toBeInTheDocument();
    expect(screen.queryByText("schema mismatch")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /解析 GEO 数据/ }));
    expect(screen.getByText("schema mismatch")).toBeInTheDocument();
  });

  it("renders skipped and cancelled operations with matching badges", () => {
    const skipped = makeOperation({
      operationId: "acquire:geo",
      label: "获取 GEO 数据",
      category: "acquisition",
      status: "skipped",
    });
    const { rerender } = render(<OperationStep item={skipped} />);
    expect(screen.getByText("已跳过")).toBeInTheDocument();

    const cancelled = makeOperation({
      operationId: "acquire:geo",
      label: "获取 GEO 数据",
      category: "acquisition",
      status: "cancelled",
    });
    rerender(<OperationStep item={cancelled} />);
    expect(screen.getByText("已取消")).toBeInTheDocument();
  });
});
