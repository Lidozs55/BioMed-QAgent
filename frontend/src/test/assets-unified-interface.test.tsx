import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentComposer } from "@/components/AgentComposer";
import { ArtifactFab } from "@/components/ArtifactFab";
import { ArtifactSheet } from "@/components/ArtifactSheet";
import {
  ASSETS_FORMAL_TAB,
  ASSETS_UNTRUSTED_TAB,
  AssetsEntry,
  AssetsSheet,
} from "@/components/AssetsSheet";
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

function composerProps() {
  return {
    value: "",
    onChange: () => undefined,
    onSubmit: () => undefined,
    onKeyDown: () => undefined,
    placeholder: "输入研究目标...",
    ariaLabel: "研究目标",
  } as const;
}

async function openUntrustedTab(fetcher?: FetchLike): Promise<void> {
  quarantineApi(fetcher ?? quarantineOnlyFetcher());
  render(<AssetsSheet open onOpenChange={vi.fn()} taskId="task-unified" />);
  fireEvent.click(await screen.findByRole("tab", { name: /未准入/ }));
}

describe("AgentComposer unified assets entry", () => {
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

  it("renders one Resources entry instead of artifact and quarantine controls", () => {
    seedActiveTask("task-unified");
    render(<AgentComposer {...composerProps()} />);

    expect(screen.getByRole("button", { name: "资源" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /查看 .* 个产物/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "查看未准入文件" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the Resources entry for an active task with zero artifacts", () => {
    seedActiveTask("task-zero-artifacts");
    render(<AgentComposer {...composerProps()} />);

    expect(screen.getByRole("button", { name: "资源" })).toBeEnabled();
  });

  it("hides the entry without an active task", () => {
    seedActiveTask(null);
    render(<AgentComposer {...composerProps()} />);

    expect(screen.queryByRole("button", { name: "资源" })).not.toBeInTheDocument();
  });
});

describe("AssetsSheet tabs", () => {
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
      <AssetsSheet
        open
        onOpenChange={vi.fn()}
        taskId="task-unified"
        artifacts={[artifact("main_data.csv")]}
        defaultTab={ASSETS_UNTRUSTED_TAB}
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

describe("AssetsEntry", () => {
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

  it("opens the unified sheet from the composer entry", async () => {
    seedActiveTask("task-unified");
    quarantineApi(
      vi.fn<FetchLike>().mockResolvedValue(
        new Response(JSON.stringify({ items: [quarantineReceipt] })),
      ),
    );
    render(<AssetsEntry />);

    fireEvent.click(screen.getByRole("button", { name: "资源" }));
    const dialog = await screen.findByRole("dialog", { name: "资源" });
    expect(dialog).toBeVisible();
    expect(within(dialog).getByRole("tab", { name: /正式产物/ })).toBeInTheDocument();
    expect(within(dialog).getByRole("tab", { name: /未准入/ })).toBeInTheDocument();
  });
});

describe("legacy ArtifactFab / ArtifactSheet compatibility", () => {
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

  it("keeps the legacy artifact FAB behavior unchanged", () => {
    mockedUseAPI.mockReturnValue(
      createAPIClient({ fetcher: vi.fn<FetchLike>() }),
    );
    render(
      <ArtifactFab
        artifacts={[artifact("main_data.csv")]}
        taskId="task-unified"
      />,
    );

    expect(
      screen.getByRole("button", { name: "查看 1 个产物" }),
    ).toBeInTheDocument();
  });

  it("keeps the legacy artifact sheet download behavior unchanged", () => {
    mockedUseAPI.mockReturnValue(
      createAPIClient({ fetcher: vi.fn<FetchLike>() }),
    );
    const download = vi.fn();
    render(
      <ArtifactSheet
        open
        onOpenChange={vi.fn()}
        artifacts={[artifact("main_data.csv")]}
        taskId="task-unified"
        download={download}
      />,
    );

    expect(screen.getByRole("dialog", { name: "任务产物" })).toBeVisible();
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    expect(screen.getByText("main_data.csv")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "下载 main_data.csv" }));
    expect(download).toHaveBeenCalledWith(
      expect.stringContaining("main_data.csv"),
      "main_data.csv",
    );
  });
});

describe("AssetsSheet exported tab values", () => {
  it("exposes distinct formal and untrusted tab values", () => {
    expect(ASSETS_FORMAL_TAB).not.toEqual(ASSETS_UNTRUSTED_TAB);
    expect(ASSETS_FORMAL_TAB).toEqual("artifacts");
    expect(ASSETS_UNTRUSTED_TAB).toEqual("untrusted");
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
