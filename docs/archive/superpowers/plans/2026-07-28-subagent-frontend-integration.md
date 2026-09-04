# Subagent Frontend and Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 UI 中实时展示 durable subagent 状态，把桌面右栏直接替换为 subagent 工作区，并把产物操作迁移到聊天输入区左下角 FAB。

**Architecture:** transport 校验新事件，reducer 从 snapshot/replay 构造 `subagentsById`；桌面复用现有 ResizablePanel，移动端复用 Sheet。产物 FAB 复用现有 Attachment、Tabs、ResultsViewer，不引入新状态系统或设计系统。

**Tech Stack:** React 19、TypeScript、Vite、Tailwind CSS v4、shadcn/ui Base Nova、Phosphor Icons、Vitest、Testing Library

## Global Constraints

- 左侧 SessionSidebar 和中间 ChatPanel 的视觉语言不改变。
- 桌面右栏直接显示 subagent，不保留 ArtifactWorkspace 双轨。
- 第一个子 Agent queued 时自动打开右栏，用户仍可折叠。
- 移动端使用带 `SheetTitle` 的 Sheet。
- 产物 FAB 位于聊天输入区左下角，打开 bottom Sheet。
- 复用 Accordion、Badge、Progress、ScrollArea、Button、Spinner、Empty、Attachment、Tabs、ResultsViewer。
- 图标只使用项目现有 Phosphor Icons；颜色只使用语义 token。
- TypeScript 不使用 `any`、`@ts-ignore` 或 `@ts-expect-error`。
- 旧 snapshot 和缺少 `subagent_id` 的事件必须继续回放。
- 每个任务提交后执行 `git fetch origin main && git rebase origin/main` 并重跑受影响测试。

---

### Task 1: Frontend contracts, transport validation, and durable projection

**Files:**
- Modify: `frontend/src/runtime/contracts.ts`
- Modify: `frontend/src/runtime/types.ts`
- Modify: `frontend/src/runtime/transport.ts`
- Modify: `frontend/src/runtime/reducer.ts`
- Test: `frontend/src/test/api-event-payloads.test.ts`
- Test: `frontend/src/test/runtime-reducer.test.ts`
- Test: `frontend/src/test/realtime-stream-reducer.test.ts`

**Interfaces:**
- Produces: `SubagentRecord`, `SubagentProjection`, dedicated subagent payload types
- Extends: `EventEnvelope.subagent_id`, `parent_tool_call_id`
- Extends: `TaskProjection.subagentsById`, `subagentOrder`

- [ ] **Step 1: Write failing projection tests**

```typescript
it("projects queued, progress, and completed subagent events", () => {
  let state = stateWithTask();
  state = reduceEnvelope(state, subagentQueuedEnvelope(2));
  state = reduceEnvelope(state, subagentProgressEnvelope(3));
  state = reduceEnvelope(state, subagentCompletedEnvelope(4));

  const task = state.tasksById.task_1;
  expect(task.subagentOrder).toEqual(["subagent_1"]);
  expect(task.subagentsById.subagent_1.status).toBe("completed");
  expect(task.subagentsById.subagent_1.sourceAssetIds).toEqual(["source_1"]);
});

it("hydrates an old snapshot without subagents", () => {
  const state = hydrateSnapshot(emptyState(), legacySnapshot());
  expect(state.tasksById.task_1.subagentOrder).toEqual([]);
  expect(state.tasksById.task_1.subagentsById).toEqual({});
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm test -- src/test/runtime-reducer.test.ts src/test/api-event-payloads.test.ts`
Expected: TypeScript/test failure because subagent contracts are absent.

- [ ] **Step 3: Implement typed event handling**

Add the ten event names to the event union and transport allowlist. Validate
required payload fields per event without rejecting unknown forward-compatible
detail fields. Initialize both projection collections in
`createTaskProjection`; snapshot hydration uses `snapshot.subagents ?? []`.
Dedicated events update only projection state and never create
ConversationItems. Existing tool events with `subagent_id` remain in the right
panel and are not inserted into the main chat.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm test -- src/test/api-event-payloads.test.ts src/test/runtime-reducer.test.ts src/test/realtime-stream-reducer.test.ts`
Expected: new lifecycle, duplicate replay, reconnect, snapshot merge, and old
event tests pass.

- [ ] **Step 5: Commit and sync**

```bash
git add frontend/src/runtime frontend/src/test
git commit -m "feat: project durable subagent events in frontend"
git fetch origin main
git rebase origin/main
```

### Task 2: Desktop SubagentWorkspace

**Files:**
- Create: `frontend/src/components/SubagentWorkspace.tsx`
- Create: `frontend/src/components/SubagentCard.tsx`
- Create: `frontend/src/components/subagentPanelControl.ts`
- Modify: `frontend/src/App.tsx`
- Delete: `frontend/src/components/ArtifactWorkspace.tsx`
- Delete: `frontend/src/components/artifactPanelControl.ts`
- Delete: `frontend/src/test/artifact-workspace.test.tsx`
- Create: `frontend/src/test/subagent-workspace.test.tsx`

**Interfaces:**
- Produces: `SubagentWorkspace({ children })`
- Consumes: active TaskProjection subagents and controller cancellation action

- [ ] **Step 1: Write failing desktop behavior tests**

```tsx
it("opens the workspace when the first subagent is queued", async () => {
  renderAppWithTask(taskWithSubagent({ status: "queued" }));
  expect(await screen.findByRole("heading", { name: "子任务" })).toBeVisible();
  expect(screen.getByText("SourceResearchAgent")).toBeVisible();
});

it("cancels only the selected running subagent", async () => {
  const cancelSubagent = vi.fn().mockResolvedValue(undefined);
  renderWorkspace(taskWithSubagent({ status: "running" }), { cancelSubagent });
  await userEvent.click(screen.getByRole("button", { name: "取消此子任务" }));
  expect(cancelSubagent).toHaveBeenCalledWith("task_1", "run_1", "subagent_1");
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm test -- src/test/subagent-workspace.test.tsx`
Expected: import failure because workspace components do not exist.

- [ ] **Step 3: Implement with existing shadcn components**

Replace the App wrapper with `SubagentWorkspace`. Preserve the existing
`ResizablePanelGroup` geometry and collapse behavior. Render one Accordion item
per subagent with Badge, Progress, ScrollArea, Button, Spinner, and Empty.
Display objective, agent type, duration, fallback timeline, warnings, error,
SourceAsset IDs, and Recipe ID. Auto-open only on transition from zero to one
subagent, not on every replay.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm test -- src/test/subagent-workspace.test.tsx src/test/chat-panel.test.tsx`
Expected: open/collapse, replay stability, status rendering, per-child cancel,
empty state, and unchanged chat tests pass.

- [ ] **Step 5: Commit and sync**

```bash
git add frontend/src/App.tsx frontend/src/components frontend/src/test
git commit -m "feat: replace artifact sidebar with subagent workspace"
git fetch origin main
git rebase origin/main
```

### Task 3: Mobile subagent Sheet

**Files:**
- Modify: `frontend/src/components/SubagentWorkspace.tsx`
- Modify: `frontend/src/components/ChatPanel.tsx`
- Test: `frontend/src/test/subagent-workspace.test.tsx`
- Test: `frontend/src/test/chat-panel.test.tsx`

**Interfaces:**
- Produces: mobile header status button and Sheet
- Reuses: `SubagentCard` from Task 2

- [ ] **Step 1: Write failing mobile test**

```tsx
it("opens the same subagent detail in an accessible mobile sheet", async () => {
  setViewportWidth(390);
  renderAppWithTask(taskWithSubagent({ status: "running" }));
  await userEvent.click(screen.getByRole("button", { name: "查看 1 个子任务" }));
  expect(screen.getByRole("dialog")).toBeVisible();
  expect(screen.getByText("子任务运行状态")).toBeVisible();
  expect(screen.getByText("正在解析公开页面")).toBeVisible();
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm test -- src/test/subagent-workspace.test.tsx src/test/chat-panel.test.tsx`
Expected: mobile status button/dialog assertions fail.

- [ ] **Step 3: Implement responsive Sheet**

Hide the Resizable right panel below the existing desktop breakpoint. Add a
ChatPanel header button containing Spinner/Badge and active count. Use
`SheetContent side="right"` with visible `SheetTitle` text “子任务运行状态” and
the shared ScrollArea/card list. Closing the Sheet changes only local UI state.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm test -- src/test/subagent-workspace.test.tsx src/test/chat-panel.test.tsx`
Expected: desktop and mobile variants both pass, including accessible dialog
name and keyboard close.

- [ ] **Step 5: Commit and sync**

```bash
git add frontend/src/components frontend/src/test
git commit -m "feat: show subagents in mobile sheet"
git fetch origin main
git rebase origin/main
```

### Task 4: Artifact FAB and bottom Sheet

**Files:**
- Create: `frontend/src/components/ArtifactFab.tsx`
- Create: `frontend/src/components/ArtifactSheet.tsx`
- Modify: `frontend/src/components/AgentComposer.tsx`
- Modify: `frontend/src/components/ResultsViewer.tsx`
- Test: `frontend/src/test/artifact-fab.test.tsx`
- Test: `frontend/src/test/chat-panel.test.tsx`

**Interfaces:**
- Produces: `ArtifactFab`, `ArtifactSheet`
- Consumes: existing active artifacts, `getArtifactUrl`, ResultsViewer

- [ ] **Step 1: Write failing FAB tests**

```tsx
it("shows artifact count and opens the bottom sheet", async () => {
  renderComposerWithArtifacts([artifact("main_data.csv"), artifact("warnings.csv")]);
  await userEvent.click(screen.getByRole("button", { name: "查看 2 个产物" }));
  expect(screen.getByRole("dialog", { name: "任务产物" })).toBeVisible();
  expect(screen.getByText("main_data.csv")).toBeVisible();
});

it("downloads every artifact from save all", async () => {
  const download = vi.fn();
  renderArtifactSheet([artifact("a.csv"), artifact("b.csv")], { download });
  await userEvent.click(screen.getByRole("button", { name: "保存全部产物" }));
  expect(download).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm test -- src/test/artifact-fab.test.tsx`
Expected: import failure because FAB/Sheet do not exist.

- [ ] **Step 3: Implement using existing artifact components**

Place an icon Button in the composer action row before attachment controls.
Hide it for zero artifacts; otherwise its accessible label contains the count.
Open `SheetContent side="bottom"` with `SheetTitle` “任务产物”, Tabs for list
and preview, Attachment rows for downloads, ResultsViewer for preview, and one
“保存全部产物” Button. Reuse the current download helper and preserve per-file
download names.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm test -- src/test/artifact-fab.test.tsx src/test/chat-panel.test.tsx`
Expected: visibility, count, open/close, preview, individual download, save-all,
and composer attachment tests pass.

- [ ] **Step 5: Commit and sync**

```bash
git add frontend/src/components frontend/src/test
git commit -m "feat: move artifacts to composer fab"
git fetch origin main
git rebase origin/main
```

### Task 5: Cross-layer API, replay, and end-to-end verification

**Files:**
- Modify: `frontend/src/hooks/useAPI.ts`
- Modify: `frontend/src/runtime/controller.ts`
- Modify: `backend/tests/agent_loop/test_agent_run_e2e.py`
- Create: `backend/tests/integration/test_subagent_research_flow.py`
- Modify: `frontend/src/test/runtime-controller.test.ts`
- Create: `frontend/src/test/subagent-flow.test.tsx`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/TODO.md`

**Interfaces:**
- Produces: controller `cancelSubagent`
- Verifies: Main Agent → children → SourceAsset → Pipeline → Validation Gate

- [ ] **Step 1: Write failing API/controller and flow tests**

```typescript
it("posts cancellation to the exact child endpoint", async () => {
  await controller.cancelSubagent("task_1", "run_1", "subagent_1");
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/v1/tasks/task_1/runs/run_1/subagents/subagent_1/cancel",
    expect.objectContaining({ method: "POST" }),
  );
});
```

```python
@pytest.mark.asyncio
async def test_parallel_children_feed_only_validated_assets_to_pipeline(flow) -> None:
    result = await flow.run(
        sources=["pubmed", "arrayexpress"],
        objective="Build a cohort table",
    )
    assert len(result.completed_subagents) == 2
    assert result.pipeline_source_asset_ids == result.validated_source_asset_ids
    assert result.published_artifacts
    assert all(item.validation_passed for item in result.published_artifacts)
```

- [ ] **Step 2: Verify RED**

Run: `pnpm test -- src/test/runtime-controller.test.ts src/test/subagent-flow.test.tsx`
Expected: controller cancellation method and integrated flow are absent.

Run: `uv run pytest tests/integration/test_subagent_research_flow.py -q`
Expected: flow harness cannot observe the new complete path yet.

- [ ] **Step 3: Complete API wiring and documentation**

Add the typed POST method and controller action, connect workspace callbacks,
and ensure replay reconnect uses the latest Task sequence. Update
`docs/ARCHITECTURE.md` to replace the hard-allowlist/self-evolution description
with the final Supervisor/Recipe architecture. Mark only actually completed
`docs/TODO.md` §6 checkboxes.

- [ ] **Step 4: Run complete project quality gates**

Backend:

```bash
uv run pytest
uv run ruff check app/ tests/ launcher.py
```

Expected: zero failures and zero Ruff warnings.

Frontend:

```bash
pnpm lint
pnpm tsc
pnpm test
pnpm build
```

Expected: all commands exit 0.

Cold-start Uvicorn with the verified PowerShell process template from
`docs/DEVELOPER_QUICKSTART.md §4.1`, request `/api/v1/health`, and terminate the
exact child process in `finally`. Expected response: `{"status":"ok"}`.

- [ ] **Step 5: Commit and final main sync**

```bash
git add backend frontend docs
git commit -m "feat: complete managed subagent research flow"
git fetch origin main
git rebase origin/main
```

Re-run the full gates after the final rebase before review or merge.
