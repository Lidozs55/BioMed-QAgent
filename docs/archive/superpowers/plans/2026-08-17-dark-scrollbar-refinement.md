# Dark Scrollbar Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 统一聊天消息区和普通滚动面板的暗色滚动条视觉，降低高亮滚动条的突兀感。

**Architecture:** 使用全局 CSS 定义原生滚动条的语义样式；`MessageScrollerViewport` 复用该样式；shadcn `ScrollArea` 的 `ScrollBar` 复用相同 track/thumb 状态类。保持现有滚动 API、自动跟随和页面布局不变。

**Tech Stack:** React 19、TypeScript、Tailwind CSS v4、shadcn Base UI、Vitest、Testing Library。

## Global Constraints

- 不新增依赖。
- 不替换聊天区的 `MessageScroller`。
- 不在业务页面逐个添加滚动条样式。
- 使用现有语义 token；暗色模式的 thumb 低对比度，悬停/滚动时提高可见度。
- 不改变滚动行为、滚动宽度策略或公开组件 API。

---

### Task 1: Lock the shared scrollbar styling contract

**Files:**
- Modify: `frontend/src/test/chat-panel.test.tsx`
- Modify: `frontend/src/test/results-viewer.test.tsx`

**Interfaces:**
- Consumes: Existing `MessageScrollerViewport` and `ScrollArea` render output.
- Produces: Test assertions requiring both primitives to expose the shared scrollbar style contract.

- [ ] **Step 1: Add failing assertions**

  In the existing chat viewport test, require the viewport to include `scrollbar-subtle` and the existing behavior classes. In the existing results viewer test, query the rendered scrollbar thumb and require `scrollbar-thumb` and `scrollbar-track` classes.

- [ ] **Step 2: Run the focused tests**

  Run from `D:/coding/BioMed-QAgent-scrollbar`:

  `pnpm --filter @biomed/frontend test -- src/test/chat-panel.test.tsx src/test/results-viewer.test.tsx`

  Expected: FAIL because the shared style classes are not yet present.

### Task 2: Implement shared styles at the component/global boundary

**Files:**
- Modify: `frontend/src/styles/global.css`
- Modify: `frontend/src/components/ui/message-scroller.tsx`
- Modify: `frontend/src/components/ui/scroll-area.tsx`

**Interfaces:**
- Consumes: Existing semantic CSS variables `--background`, `--muted-foreground`, `--border` and existing scroll state attributes.
- Produces: `scrollbar-subtle`, `scrollbar-track`, and `scrollbar-thumb` styling available to all current scroll containers.

- [ ] **Step 1: Add the minimal global rules**

  Add rules for `.scrollbar-subtle` with `scrollbar-width: thin`, transparent track, and semantic thumb color. Add WebKit rules for `.scrollbar-subtle::-webkit-scrollbar`, `::-webkit-scrollbar-track`, and `::-webkit-scrollbar-thumb`; use a transparent border to create visual breathing room and rounded corners. In `.dark`, use a low-opacity `--muted-foreground` thumb and increase it only for hover/active states. Keep reduced-motion behavior compatible with existing global rules.

- [ ] **Step 2: Apply the shared classes to `MessageScrollerViewport`**

  Replace the duplicated `scrollbar-thin scrollbar-gutter-stable` portion with `scrollbar-subtle scrollbar-gutter-stable`, retaining the existing `data-autoscrolling` transparency classes.

- [ ] **Step 3: Apply the shared classes to shadcn `ScrollBar`**

  Add `scrollbar-track` to the custom scrollbar root and `scrollbar-thumb` to its thumb, while retaining orientation/layout classes. Ensure the thumb remains draggable and the existing `bg-border` styling is replaced by the shared semantic class.

### Task 3: Verify and review the complete change

**Files:**
- No additional production files.

**Interfaces:**
- Consumes: Tasks 1–2 changes.
- Produces: Verified frontend implementation and reviewable branch diff.

- [ ] **Step 1: Run focused tests**

  Run the two frontend test files and confirm they pass.

- [ ] **Step 2: Run frontend quality gates**

  Run `pnpm --filter @biomed/frontend lint`, `pnpm --filter @biomed/frontend typecheck`, `pnpm --filter @biomed/frontend build`, and `pnpm --filter @biomed/frontend test`.

- [ ] **Step 3: Inspect the diff**

  Confirm only the shared CSS, two shadcn primitives, tests, design, and plan changed; confirm no business page received per-page scrollbar overrides.

- [ ] **Step 4: Request code review**

  Review the branch diff against `origin/main`, fix any Critical or Important findings, and rerun the affected checks.
