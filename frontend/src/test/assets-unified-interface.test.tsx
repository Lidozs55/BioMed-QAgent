import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OUTPUT_FORMAL_TAB,
  OUTPUT_UNTRUSTED_TAB,
  TaskOutputPanel,
} from "@/components/TaskOutputPanel";
import type { QuarantineReceipt } from "@/api/quarantine";
import { createAPIClient, type FetchLike } from "@/hooks/useAPI";
import { useAPI } from "@/hooks/useAPI";
import type { TaskSnapshot } from "@/runtime/contracts";
import type { ArtifactProjection } from "@/runtime/types";
import { createInitialRuntimeState } from "@/runtime/reducer";
import { useAgentStore } from "@/stores/agentStore";

vi.mock("@/hooks/useAPI", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useAPI")>();
  return { ...actual, useAPI: vi.fn() };
});

function artifact(name: string): ArtifactProjection {
  return {
    artifact_id: name,
    name,
    role: "audit_report",
    size: 128,
    sha256: `sha-${name}`,
    media_type: "text/csv",
    taskId: "task-unified",
    generatedByStepId: null,
  };
}

const quarantineReceipt: QuarantineReceipt = {
  schema_version: "1.0",
  submission_id: "ua_0123456789abcdef01234567",
  task_id: "task-unified",
  name: "manual_note.csv",
  media_type: "text/csv",
  source_note: "non-authoritative reference",
  coverage_status: "partial",
  covered_scope: ["samples"],
  missing_scope: ["outcomes"],
  size_bytes: 12,
  sha256: "b".repeat(64),
  submitted_at: "2026-08-30T00:00:00Z",
  authoritative: false,
  trust: "untrusted",
};

function seedActiveTask(taskId: string | null): void {
  if (taskId === null) {
    useAgentStore.setState({ activeTaskId: null });
    return;
  }
  if (useAgentStore.getState().tasksById[taskId] !== undefined) return;
  const snapshot: TaskSnapshot = {
    task: {
      task_id: taskId,
      mode: "agent",
      databases: ["pubmed"],
      title: `${taskId} task`,
      status: "completed",
      active_run_id: null,
      created_at: "2026-07-14T00:00:00Z",
      updated_at: "2026-07-14T00:00:00Z",
      latest_sequence: 0,
    },
    runs: [],
    messages: [],
    older_messages_cursor: null,
  };
  useAgentStore.getState().hydrateTaskSnapshot(snapshot);
  useAgentStore.getState().setActiveTaskId(taskId);
}

const mockedUseAPI = vi.mocked(useAPI);

function quarantineApi(fetcher: FetchLike) {
  const api = createAPIClient({ fetcher });
  mockedUseAPI.mockReturnValue(api);
  return api;
}

/** 隔离区返回收据；其余端点（如 Publication 详情）保持挂起，避免无关网络行为。 */
function quarantineOnlyFetcher(): FetchLike {
  return vi.fn<FetchLike>().mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/quarantine")) {
      return Promise.resolve(
        new Response(JSON.stringify({ items: [quarantineReceipt] })),
      );
    }
    return new Promise<Response>(() => undefined);
  });
}

/** Base UI 隐藏面板带 inert 属性：取当前未隐藏的 tabpanel。 */
function activePanel(): HTMLElement {
  const panel = screen
    .getAllByRole("tabpanel", { hidden: true })
    .find((candidate) => !candidate.hasAttribute("inert"));
  if (panel === undefined) throw new Error("No active tabpanel found");
  return panel;
}

async function openUntrustedTab(fetcher?: FetchLike): Promise<void> {
  quarantineApi(fetcher ?? quarantineOnlyFetcher());
  render(<TaskOutputPanel taskId="task-unified" />);
  fireEvent.click(await screen.findByRole("tab", { name: /未准入/ }));
}

describe("TaskOutputPanel tabs", () => {
  afterEach(() => {
    useAgentStore.setState({
      ...createInitialRuntimeState(),
      activeTaskId: null,
    });
    vi.restoreAllMocks();
    mockedUseAPI.mockReset();
    // mockReset 会清空实现；先填充一个可用 client，避免 RTL 卸载时读到 undefined。
    mockedUseAPI.mockReturnValue(createAPIClient());
  });

  it("opens the untrusted tab on a task with no artifacts at all", async () => {
    await openUntrustedTab();

    expect(await screen.findByText("manual_note.csv")).toBeVisible();
    expect(screen.getByText("非权威 / 未经准入")).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: /正式产物/ }));
    expect(screen.getByText(/暂无正式产物/)).toBeInTheDocument();
  });

  it("keeps quarantine items labeled non-authoritative and out of formal counts", async () => {
    const fetcher = vi.fn<FetchLike>().mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/quarantine")) {
        return Promise.resolve(
          new Response(JSON.stringify({ items: [quarantineReceipt] })),
        );
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    });
    quarantineApi(fetcher);
    render(
      <TaskOutputPanel
        taskId="task-unified"
        artifacts={[artifact("main_data.csv")]}
        defaultTab={OUTPUT_UNTRUSTED_TAB}
      />,
    );

    expect(await screen.findByText("manual_note.csv")).toBeVisible();
    expect(
      within(activePanel()).getByText("非权威 / 未经准入"),
    ).toBeVisible();
    expect(within(activePanel()).getByText("trust: untrusted")).toBeVisible();
    expect(
      within(activePanel()).queryByText("main_data.csv"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /正式产物/ }));
    expect(within(activePanel()).getByText("main_data.csv")).toBeVisible();
    expect(
      within(activePanel()).queryByText("manual_note.csv"),
    ).not.toBeInTheDocument();
  });

  it("keeps untrusted assets visible when a Publication exists", async () => {
    seedActiveTask("task-unified");
    useAgentStore.setState((state) => ({
      tasksById: {
        ...state.tasksById,
        "task-unified": {
          ...state.tasksById["task-unified"]!,
          currentPublicationId: "pub-v2",
        },
      },
    }));
    await openUntrustedTab(quarantineOnlyFetcher());

    expect(await screen.findByText("manual_note.csv")).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: /正式产物/ }));
    await waitFor(() =>
      expect(screen.getByText(/加载发布产物/)).toBeInTheDocument(),
    );
  });
});

describe("TaskOutputPanel exported tab values", () => {
  it("exposes distinct formal and untrusted tab values", () => {
    expect(OUTPUT_FORMAL_TAB).not.toEqual(OUTPUT_UNTRUSTED_TAB);
    expect(OUTPUT_FORMAL_TAB).toEqual("artifacts");
    expect(OUTPUT_UNTRUSTED_TAB).toEqual("untrusted");
  });
});

// QuarantinePanel upload flow keeps its own focused coverage in
// quarantine-panel.test.tsx; the unified sheet embeds that panel verbatim.
describe("untrusted tab keeps upload capability", () => {
  it("renders the quarantine upload form inside the untrusted tab", async () => {
    await openUntrustedTab();
    await waitFor(() =>
      expect(screen.getByText("选择文件")).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: "提交到隔离区" }),
    ).toBeInTheDocument();
  });
});
