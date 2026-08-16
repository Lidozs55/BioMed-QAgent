import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PermissionDialog } from "@/components/PermissionDialog";
import type { TaskSummary } from "@/runtime/contracts";
import {
  createInitialRuntimeState,
  mergeTaskPage,
} from "@/runtime/reducer";
import type { PendingPermission, TaskProjection } from "@/runtime/types";

const CREATED_AT = "2026-08-15T00:00:00Z";

function taskWithPermission(overrides: Partial<PendingPermission> = {}): TaskProjection {
  const summary: TaskSummary = {
    task_id: "task_perm",
    mode: "agent",
    databases: [],
    title: "permission task",
    status: "running",
    active_run_id: "run_ts_1",
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    latest_sequence: 2,
  };
  const state = createInitialRuntimeState();
  const withTask = mergeTaskPage(state, {
    schema_version: "1.0",
    active_items: [summary],
    items: [],
    next_cursor: null,
  }, true);
  const task = withTask.tasksById.task_perm as TaskProjection;
  return {
    ...task,
    pendingPermission: {
      runId: "run_ts_1",
      requestId: "permission_abc",
      capability: "fs.read",
      scope: "external",
      resource: "D:\\datasets\\TCGA\\clinical.csv",
      command: null,
      cwd: null,
      summary: "读取文件 D:\\datasets\\TCGA\\clinical.csv",
      sequence: 2,
      timestamp: CREATED_AT,
      ...overrides,
    },
  };
}

describe("PermissionDialog", () => {
  it("renders the file request with capability and scope badges", () => {
    render(
      <PermissionDialog task={taskWithPermission()} onResolvePermission={vi.fn()} />,
    );
    expect(screen.getAllByText(/读取文件/).length).toBeGreaterThan(0);
    expect(screen.getByText("D:\\datasets\\TCGA\\clinical.csv")).toBeTruthy();
    expect(screen.getByText("外部目录")).toBeTruthy();
    expect(screen.getByText(/本 Run \/ 本 Task 允许/)).toBeTruthy();
  });

  it("submits deny / allow-once / run / task / persistent decisions", async () => {
    const onResolvePermission = vi.fn().mockResolvedValue(undefined);
    render(
      <PermissionDialog task={taskWithPermission()} onResolvePermission={onResolvePermission} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /拒绝/ }));
    await waitFor(() => {
      expect(onResolvePermission).toHaveBeenCalledWith(
        "task_perm",
        "run_ts_1",
        "permission_abc",
        "deny",
        undefined,
      );
    });

    fireEvent.click(screen.getByRole("button", { name: /允许一次/ }));
    await waitFor(() => {
      expect(onResolvePermission).toHaveBeenLastCalledWith(
        "task_perm",
        "run_ts_1",
        "permission_abc",
        "allow",
        "once",
      );
    });

    fireEvent.click(screen.getByRole("button", { name: /本 Run 允许/ }));
    await waitFor(() => {
      expect(onResolvePermission).toHaveBeenLastCalledWith(
        "task_perm",
        "run_ts_1",
        "permission_abc",
        "allow",
        "run",
      );
    });

    fireEvent.click(screen.getByRole("button", { name: /本 Task 允许/ }));
    await waitFor(() => {
      expect(onResolvePermission).toHaveBeenLastCalledWith(
        "task_perm",
        "run_ts_1",
        "permission_abc",
        "allow",
        "task",
      );
    });

    fireEvent.click(screen.getByRole("button", { name: /始终允许此路径/ }));
    await waitFor(() => {
      expect(onResolvePermission).toHaveBeenLastCalledWith(
        "task_perm",
        "run_ts_1",
        "permission_abc",
        "allow",
        "persistent",
      );
    });
    expect(onResolvePermission).toHaveBeenCalledTimes(5);
  });

  it("renders the command request with the OS-privilege warning", () => {
    render(
      <PermissionDialog
        task={taskWithPermission({
          capability: "process.exec",
          resource: null,
          command: "python scripts/analyze.py",
          cwd: "D:\\coding\\BioMed-QAgent\\data\\workspaces\\task_perm",
        })}
        onResolvePermission={vi.fn()}
      />,
    );
    expect(screen.getAllByText(/执行命令/).length).toBeGreaterThan(0);
    expect(screen.getByText("python scripts/analyze.py")).toBeTruthy();
    expect(screen.getAllByText(/系统账户权限/).length).toBeGreaterThan(0);
    // Command requests offer the persistent exec option instead of a path grant.
    expect(screen.getByRole("button", { name: /始终允许命令执行/ })).toBeTruthy();
  });

  it("renders nothing when no permission is pending", () => {
    const task = taskWithPermission();
    const { container } = render(
      <PermissionDialog task={{ ...task, pendingPermission: null }} onResolvePermission={vi.fn()} />,
    );
    expect(container.textContent).toBe("");
    void act;
  });
});
