import { describe, expect, test } from "vitest";

import type { EventEnvelope, TaskPage } from "@/runtime/contracts";
import {
  createInitialRuntimeState,
  mergeTaskPage,
  reduceRuntimeEvent,
} from "@/runtime/reducer";
import type { AgentRuntimeData } from "@/runtime/types";

function envelope(taskId: string, sequence: number, payload: EventEnvelope["payload"]): EventEnvelope {
  return {
    schema_version: "2.0",
    event_id: `event_${sequence}`,
    type: payload.type,
    task_id: taskId,
    run_id: "run_ts_1",
    stage_attempt_id: null,
    sequence,
    timestamp: "2026-08-15T00:00:00.000Z",
    payload,
  };
}

function stateWithTask(taskId: string, status: "running" | "completed" = "running"): AgentRuntimeData {
  const page: TaskPage = {
    schema_version: "1.0",
    active_items: [{
      task_id: taskId,
      mode: "agent",
      databases: [],
      title: "t",
      status,
      active_run_id: status === "completed" ? null : "run_ts_1",
      created_at: "2026-08-15T00:00:00.000Z",
      updated_at: "2026-08-15T00:00:00.000Z",
      latest_sequence: 1,
    }],
    items: [],
    next_cursor: null,
  };
  return mergeTaskPage(createInitialRuntimeState(), page, true);
}

function requested(
  taskId: string,
  requestId: string,
  capability: "fs.read" | "fs.write" | "fs.edit" | "process.exec" = "fs.read",
): AgentRuntimeData {
  const state = stateWithTask(taskId);
  return reduceRuntimeEvent(state, envelope(taskId, 2, {
    type: "permission_requested",
    request_id: requestId,
    capability,
    scope: "external",
    resource: "D:\\datasets\\TCGA\\clinical.csv",
    canonical_resource: "D:\\datasets\\TCGA\\clinical.csv",
    command: null,
    cwd: null,
    summary: "读取文件 D:\\datasets\\TCGA\\clinical.csv",
  }));
}

describe("permission event reducer (P4)", () => {
  test("permission_requested sets the pending permission card", () => {
    const state = requested("task_p1", "permission_abc");
    expect(state.tasksById.task_p1?.pendingPermission).toMatchObject({
      runId: "run_ts_1",
      requestId: "permission_abc",
      capability: "fs.read",
      scope: "external",
      resource: "D:\\datasets\\TCGA\\clinical.csv",
      summary: "读取文件 D:\\datasets\\TCGA\\clinical.csv",
    });
    expect(state.tasksById.task_p1?.items).toContainEqual(expect.objectContaining({
      kind: "permission",
      itemId: "permission:run_ts_1:permission_abc",
      requestId: "permission_abc",
      status: "requested",
      sequence: 2,
    }));
  });

  test("permission_resolved clears the matching pending request", () => {
    const state = requested("task_p2", "permission_abc", "process.exec");
    const resolved = reduceRuntimeEvent(state, envelope("task_p2", 3, {
      type: "permission_resolved",
      request_id: "permission_abc",
      decision: "allow",
      grant_scope: "run",
    }));
    expect(resolved.tasksById.task_p2?.pendingPermission).toBeNull();
    expect(resolved.tasksById.task_p2?.items).toContainEqual(expect.objectContaining({
      kind: "permission",
      itemId: "permission:run_ts_1:permission_abc",
      status: "allowed",
      grantScope: "run",
      sequence: 2,
    }));
  });

  test("a stale resolution does not dismiss a newer pending request", () => {
    const state = requested("task_p3", "permission_old");
    const second = reduceRuntimeEvent(state, envelope("task_p3", 3, {
      type: "permission_requested",
      request_id: "permission_new",
      capability: "fs.read",
      scope: "external",
      resource: "y",
      canonical_resource: "y",
      command: null,
      cwd: null,
      summary: "s2",
    }));
    expect(second.tasksById.task_p3?.pendingPermission?.requestId).toBe("permission_new");

    const staleResolve = reduceRuntimeEvent(second, envelope("task_p3", 4, {
      type: "permission_resolved",
      request_id: "permission_old",
      decision: "deny",
      grant_scope: null,
    }));
    expect(staleResolve.tasksById.task_p3?.pendingPermission?.requestId).toBe("permission_new");
    expect(staleResolve.tasksById.task_p3?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestId: "permission_old", status: "denied" }),
      expect.objectContaining({ requestId: "permission_new", status: "requested" }),
    ]));
  });

  test("run cancellation clears the pending permission", () => {
    const state = requested("task_p4", "permission_abc");
    expect(state.tasksById.task_p4?.pendingPermission).not.toBeNull();
    const cancelled = reduceRuntimeEvent(state, envelope("task_p4", 3, {
      type: "run_cancelled",
      reason: "user requested",
    }));
    expect(cancelled.tasksById.task_p4?.pendingPermission).toBeNull();
  });

  test("permission events do not change the run status (unlike business HIL)", () => {
    const state = requested("task_p5", "permission_abc", "fs.write");
    expect(state.tasksById.task_p5?.runsById.run_ts_1?.status).toBe("running");
    expect(state.tasksById.task_p5?.summary.status).toBe("running");
  });
});
