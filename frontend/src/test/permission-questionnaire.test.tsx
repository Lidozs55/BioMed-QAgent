import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PermissionQuestionnaire } from "@/components/intervention/PermissionQuestionnaire";
import type { PendingPermission } from "@/runtime/types";

const permission: PendingPermission = {
  runId: "run_ts_1",
  requestId: "permission_abc",
  capability: "fs.read",
  scope: "external",
  resource: "D:\\datasets\\TCGA\\clinical.csv",
  canonicalResource: "D:\\datasets\\TCGA\\clinical.csv",
  command: null,
  cwd: null,
  summary: "读取文件 D:\\datasets\\TCGA\\clinical.csv",
  sequence: 2,
  timestamp: "2026-08-15T00:00:00Z",
};

function renderPermission(
  overrides: Partial<PendingPermission> = {},
  onResolvePermission = vi.fn().mockResolvedValue(undefined),
) {
  const current = { ...permission, ...overrides };
  render(
    <PermissionQuestionnaire
      key={current.requestId}
      taskId="task_perm"
      permission={current}
      onResolvePermission={onResolvePermission}
    />,
  );
  return onResolvePermission;
}

describe("PermissionQuestionnaire", () => {
  it("starts with only the ordinary allow, deny, and advanced choices", () => {
    renderPermission();

    expect(screen.getByText("Agent 想读取")).toBeTruthy();
    expect(screen.getByText("D:\\datasets\\TCGA\\clinical.csv")).toBeTruthy();
    expect(screen.getByRole("radio", { name: /允许这一次/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /拒绝/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /其他授权方式/ })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: /本次 Run/ })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("maps allow-once and deny directly to the permission API", async () => {
    const allow = renderPermission();
    fireEvent.click(screen.getByRole("radio", { name: /允许这一次/ }));
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() => {
      expect(allow).toHaveBeenCalledWith(
        "task_perm",
        "run_ts_1",
        "permission_abc",
        "allow",
        "once",
        undefined,
      );
    });

    const deny = vi.fn().mockResolvedValue(undefined);
    renderPermission({ requestId: "permission_deny" }, deny);
    const denyChoices = screen.getAllByRole("radio", { name: /拒绝/ });
    const submitButtons = screen.getAllByRole("button", { name: "确认" });
    fireEvent.click(denyChoices[denyChoices.length - 1] as HTMLElement);
    fireEvent.click(submitButtons[submitButtons.length - 1] as HTMLElement);
    await waitFor(() => {
      expect(deny).toHaveBeenCalledWith(
        "task_perm",
        "run_ts_1",
        "permission_deny",
        "deny",
        undefined,
        undefined,
      );
    });
  });

  it("reveals run, task, and persistent grants only after choosing other", async () => {
    const resolve = renderPermission();
    fireEvent.click(screen.getByRole("radio", { name: /其他授权方式/ }));
    fireEvent.click(screen.getByRole("button", { name: "继续" }));

    expect(screen.getByRole("radio", { name: /本次 Run/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /本 Task/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /始终允许此路径/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /本 Task/ }));
    fireEvent.click(screen.getByRole("button", { name: "确认" }));

    await waitFor(() => {
      expect(resolve).toHaveBeenCalledWith(
        "task_perm",
        "run_ts_1",
        "permission_abc",
        "allow",
        "task",
        undefined,
      );
    });
  });

  it("requires an explicit duration for a high-risk whole-scope grant", async () => {
    const resolve = renderPermission({ scope: "sensitive", resource: ".env" });
    fireEvent.click(screen.getByRole("radio", { name: /其他授权方式/ }));
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    fireEvent.click(screen.getByRole("radio", { name: /允许整个“敏感文件”范围/ }));
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    fireEvent.click(screen.getByRole("radio", { name: /本 Task/ }));
    fireEvent.click(screen.getByRole("button", { name: "确认" }));

    await waitFor(() => {
      expect(resolve).toHaveBeenCalledWith(
        "task_perm",
        "run_ts_1",
        "permission_abc",
        "allow",
        "task",
        true,
      );
    });
  });

  it("clears advanced answers when switching back to a direct decision", async () => {
    const resolve = renderPermission();
    fireEvent.click(screen.getByRole("radio", { name: /其他授权方式/ }));
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    fireEvent.click(screen.getByRole("radio", { name: /允许整个“外部目录”范围/ }));
    fireEvent.click(screen.getByRole("button", { name: "上一步" }));
    fireEvent.click(screen.getByRole("radio", { name: /允许这一次/ }));
    fireEvent.click(screen.getByRole("button", { name: "确认" }));

    await waitFor(() => {
      expect(resolve).toHaveBeenCalledWith(
        "task_perm",
        "run_ts_1",
        "permission_abc",
        "allow",
        "once",
        undefined,
      );
    });
  });

  it("shows a canonical target that differs from the requested path", () => {
    renderPermission({
      resource: "results/current.csv",
      canonicalResource: "D:\\shared\\sensitive\\current.csv",
    });

    expect(screen.getByText("results/current.csv")).toBeTruthy();
    expect(screen.getByText(/实际目标/)).toBeTruthy();
    expect(screen.getByText("D:\\shared\\sensitive\\current.csv")).toBeTruthy();
  });

  it("shows command context and offers persistent exec only in the advanced step", () => {
    renderPermission({
      capability: "process.exec",
      resource: null,
      command: "C:\\Python313\\python.exe -m pip install scipy",
      cwd: "D:\\coding\\BioMed-QAgent\\data\\workspaces\\task_perm",
    });

    expect(screen.getByText("Agent 想执行命令")).toBeTruthy();
    expect(screen.getByText("C:\\Python313\\python.exe -m pip install scipy")).toBeTruthy();
    expect(screen.getByText(/继承当前系统账户权限/)).toBeTruthy();
    expect(screen.queryByRole("radio", { name: /始终允许命令执行/ })).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: /其他授权方式/ }));
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    expect(screen.getByRole("radio", { name: /始终允许命令执行/ })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: /允许整个/ })).toBeNull();
  });

  it("surfaces submission errors and enables retry", async () => {
    const resolve = vi.fn()
      .mockRejectedValueOnce(new Error("permission endpoint unavailable"))
      .mockResolvedValueOnce(undefined);
    renderPermission({}, resolve);

    fireEvent.click(screen.getByRole("radio", { name: /允许这一次/ }));
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    expect(await screen.findByText("permission endpoint unavailable")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2));
  });
});
