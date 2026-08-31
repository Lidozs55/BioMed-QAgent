import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ASSETS_FORMAL_TAB,
  ASSETS_SOURCE_TAB,
  ASSETS_UNTRUSTED_TAB,
  AssetsSheet,
} from "@/components/AssetsSheet";
import type { QuarantineReceipt } from "@/api/quarantine";
import type { SourceAssetRegistrationReceipt } from "@/api/sourceAssets";
import { createAPIClient, type FetchLike } from "@/hooks/useAPI";
import { useAPI } from "@/hooks/useAPI";

vi.mock("@/hooks/useAPI", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useAPI")>();
  return { ...actual, useAPI: vi.fn() };
});

const TASK_ID = "task-unified";

function artifact(name: string) {
  return {
    artifact_id: name,
    name,
    role: "audit_report",
    size: 128,
    sha256: `sha-${name}`,
    media_type: "text/csv",
    taskId: TASK_ID,
    generatedByStepId: null,
  };
}

const quarantineReceipt: QuarantineReceipt = {
  schema_version: "1.0",
  submission_id: "ua_0123456789abcdef01234567",
  task_id: TASK_ID,
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

function sourceReceipt(
  overrides: Partial<SourceAssetRegistrationReceipt> = {},
): SourceAssetRegistrationReceipt {
  const sha256 = "a".repeat(64);
  return {
    schema_version: "1.0",
    receipt_id: "receipt_01234567-89ab-cdef-0123-456789abcdef",
    task_id: TASK_ID,
    asset_ref: {
      schema_version: "1.0",
      asset_id: `asset_${sha256}`,
      task_id: TASK_ID,
      role: "carrier",
    },
    source_id: "source_fixture",
    relative_path: "source_assets/table.csv",
    sha256,
    size_bytes: 12,
    media_type: "text/csv",
    registered_at: "2026-08-30T00:00:00.000Z",
    path_compatibility: {
      schema_version: "1.0",
      mode: "asset_id",
      legacy_path: null,
      telemetry_event: "asset_ref_used",
    },
    ...overrides,
  };
}

const mockedUseAPI = vi.mocked(useAPI);

/** 隔离区/来源按 URL 分流；未匹配端点保持挂起，避免无关网络行为。 */
function assetsFetcher(options: {
  quarantineItems?: QuarantineReceipt[];
  sourceItems?: SourceAssetRegistrationReceipt[];
  sourceError?: boolean;
}): FetchLike {
  return vi.fn<FetchLike>().mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/quarantine")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ items: options.quarantineItems ?? [] }),
        ),
      );
    }
    if (url.includes("/source-assets")) {
      if (options.sourceError) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: "registry unavailable" }), {
            status: 500,
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ items: options.sourceItems ?? [] })),
      );
    }
    return new Promise<Response>(() => undefined);
  });
}

function mockApi(fetcher: FetchLike): void {
  mockedUseAPI.mockReturnValue(createAPIClient({ fetcher }));
}

/** Base UI 隐藏面板带 inert 属性：取当前未隐藏的 tabpanel。 */
function activePanel(): HTMLElement {
  const panel = screen
    .getAllByRole("tabpanel", { hidden: true })
    .find((candidate) => !candidate.hasAttribute("inert"));
  if (panel === undefined) throw new Error("No active tabpanel found");
  return panel;
}

function renderSheet(
  props: Partial<React.ComponentProps<typeof AssetsSheet>> = {},
): void {
  render(<AssetsSheet open onOpenChange={vi.fn()} taskId={TASK_ID} {...props} />);
}

afterEach(() => {
  vi.restoreAllMocks();
  mockedUseAPI.mockReset();
  mockedUseAPI.mockReturnValue(createAPIClient());
});

describe("AssetsSheet source/evidence tab", () => {
  it("exposes a distinct read-only source tab value", () => {
    expect(ASSETS_SOURCE_TAB).not.toEqual(ASSETS_FORMAL_TAB);
    expect(ASSETS_SOURCE_TAB).not.toEqual(ASSETS_UNTRUSTED_TAB);
    expect(ASSETS_SOURCE_TAB).toEqual("sources");
  });

  it("shows an empty read-only list when no sources are registered", async () => {
    mockApi(assetsFetcher({}));
    renderSheet({ defaultTab: ASSETS_SOURCE_TAB });

    expect(
      await screen.findByText("暂无来源/证据登记"),
    ).toBeVisible();
    expect(screen.getAllByText(/只读清单/).length).toBeGreaterThan(0);
    expect(
      screen.queryByRole("button", { name: /提交|上传|下载/ }),
    ).not.toBeInTheDocument();
  });

  it("lists registered source receipts with role, media, size, and source ID", async () => {
    mockApi(
      assetsFetcher({
        sourceItems: [
          sourceReceipt(),
          sourceReceipt({
            receipt_id: "receipt_ffffffff-89ab-cdef-0123-456789abcdef",
            asset_ref: {
              schema_version: "1.0",
              asset_id: `asset_${"c".repeat(64)}`,
              task_id: TASK_ID,
              role: "mapping",
            },
            sha256: "c".repeat(64),
            relative_path: "source_assets/derive/mapping.json",
            media_type: "application/json",
            size_bytes: 2048,
            source_id: "source_mapping",
          }),
        ],
      }),
    );
    renderSheet({ defaultTab: ASSETS_SOURCE_TAB });

    expect(await screen.findByText("source_assets/table.csv")).toBeVisible();
    expect(screen.getByText("source_assets/derive/mapping.json")).toBeVisible();

    const rows = screen
      .getAllByText(/来源 ID：/)
      .map((element) => element.closest('[data-slot="card"]'));
    expect(rows).toHaveLength(2);
    expect(screen.getByText("来源 ID：source_fixture")).toBeInTheDocument();
    expect(screen.getByText("来源 ID：source_mapping")).toBeInTheDocument();

    // 载体/来源 vs Core 衍生证据：仅按 receipt 的 role 字段区分。
    expect(screen.getByText("已采集 载体/来源")).toBeInTheDocument();
    expect(screen.getByText("Core 衍生证据")).toBeInTheDocument();
    expect(screen.getByText("载体")).toBeInTheDocument();
    expect(screen.getByText("映射")).toBeInTheDocument();
    // formatSize: 12 B / 2.0 KB
    expect(screen.getByText(/text\/csv · 12 B/)).toBeInTheDocument();
    expect(screen.getByText(/application\/json · 2.0 KB/)).toBeInTheDocument();
  });

  it("keeps the source tab isolated from formal and untrusted content", async () => {
    mockApi(
      assetsFetcher({
        quarantineItems: [quarantineReceipt],
        sourceItems: [sourceReceipt()],
      }),
    );
    renderSheet({
      artifacts: [artifact("main_data.csv")],
      defaultTab: ASSETS_SOURCE_TAB,
    });

    const sourcePanel = await screen
      .findByText("source_assets/table.csv")
      .then((element) => element.closest<HTMLElement>('[role="tabpanel"]'));
    if (sourcePanel === null) throw new Error("source panel missing");
    expect(
      within(sourcePanel).queryByText("manual_note.csv"),
    ).not.toBeInTheDocument();
    expect(
      within(sourcePanel).queryByText("main_data.csv"),
    ).not.toBeInTheDocument();
    expect(
      within(sourcePanel).queryByText("非权威 / 未经准入"),
    ).not.toBeInTheDocument();
    // 来源登记不提供正式产物操作，也不计入正式产物数量。
    expect(
      within(sourcePanel).queryByRole("button", { name: "保存全部产物" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /正式产物/ }));
    expect(
      within(activePanel()).getByText("main_data.csv"),
    ).toBeVisible();
    expect(
      within(activePanel()).queryByText("source_assets/table.csv"),
    ).not.toBeInTheDocument();
  });

  it("shows an error alert when the registry listing fails", async () => {
    mockApi(assetsFetcher({ sourceError: true }));
    renderSheet({ defaultTab: ASSETS_SOURCE_TAB });

    expect(
      await screen.findByText("来源/证据登记加载失败"),
    ).toBeVisible();
  });
});
