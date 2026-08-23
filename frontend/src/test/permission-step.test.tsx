import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import { PermissionStep } from "@/components/conversation/PermissionStep";
import type { PermissionItem } from "@/runtime/types";

function item(overrides: Partial<PermissionItem> = {}): PermissionItem {
  return {
    kind: "permission",
    itemId: "permission:run_1:request_1",
    runId: "run_1",
    sequence: 2,
    createdAt: "2026-08-22T00:00:00Z",
    requestId: "request_1",
    capability: "fs.read",
    summary: "读取外部数据文件",
    status: "requested",
    grantScope: null,
    ...overrides,
  };
}

describe("PermissionStep", () => {
  test("renders a pending permission as durable conversation history", () => {
    render(<PermissionStep item={item()} />);
    expect(screen.getByRole("status")).toHaveTextContent("读取外部数据文件");
    expect(screen.getByRole("status")).toHaveTextContent("fs.read");
    expect(screen.getByRole("status")).toHaveTextContent("等待授权");
  });

  test("renders the durable resolution and grant scope", () => {
    render(<PermissionStep item={item({ status: "allowed", grantScope: "task" })} />);
    expect(screen.getByRole("status")).toHaveTextContent("已允许");
    expect(screen.getByRole("status")).toHaveTextContent("scope=task");
  });
});
