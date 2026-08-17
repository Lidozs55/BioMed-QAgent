# Sidebar Footer Settings Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 精简侧栏底部操作，并将设置入口与历史任务图标精确对齐，同时保留设置页缓存导出能力。

**Architecture:** 删除 `SessionSidebar` 中非导航信息和导出回调，设置入口直接复用历史任务行使用的 Sidebar 菜单原语。缓存导出继续由 `App` 向 `SettingsPanel` 注入，不改变 API 或服务端。

**Tech Stack:** React 19、TypeScript、shadcn/ui Sidebar、Vitest、Testing Library。

## Global Constraints

- 所有实现位于 `fix/sidebar-footer-settings-cache` 独立 worktree。
- 使用仓库根 `pnpm dev` 正式入口，并以 `8001` 端口验收。
- 先写失败测试，再写最小实现。

---

### Task 1: 固定侧栏底部行为与对齐结构

**Files:**

- Modify: `frontend/src/test/session-sidebar.test.tsx`
- Modify: `frontend/src/components/SessionSidebar.tsx`
- Modify: `frontend/src/App.tsx`

**Interfaces:**

- Consumes: `SidebarMenu`、`SidebarMenuItem`、`SidebarMenuButton`。
- Produces: 仅含“设置”的 `SidebarFooter`，不再接受 `onExportCache`。

- [x] **Step 1: 写失败测试**

新增断言：底部不存在连接状态、并发槽位和缓存导出；设置按钮位于 `data-slot="sidebar-menu-button"` 中，并由菜单和菜单项包裹。

- [x] **Step 2: 验证测试因旧底部内容而失败**

在 `frontend/` 运行 `pnpm test -- src/test/session-sidebar.test.tsx`，预期新断言失败。

- [x] **Step 3: 写最小实现**

删除连接/槽位计算、`onExportCache` prop 和导出按钮；用 Sidebar 菜单原语渲染设置入口；从 `App` 的 `SessionSidebar` 调用移除 `onExportCache`。

- [x] **Step 4: 验证侧栏测试通过**

在 `frontend/` 重跑 `pnpm test -- src/test/session-sidebar.test.tsx`，预期通过。

### Task 2: 固定设置页导出入口

**Files:**

- Modify: `frontend/src/test/settings-panel.test.tsx`
- Modify: `frontend/src/components/settings/sections/GeneralSettingsSection.tsx`

**Interfaces:**

- Consumes: `SettingsPanelProps.onExportCache?: () => void`。
- Produces: “常规 → 导出缓存”回调回归测试。

- [x] **Step 1: 增加设置页入口测试**

打开设置面板，点击“常规”，确认“导出缓存”可见并调用传入回调一次。

- [x] **Step 2: 运行设置页测试**

在 `frontend/` 运行 `pnpm test -- src/test/settings-panel.test.tsx`，预期通过。

### Task 3: 综合验证与视觉验收

**Files:**

- Verify only.

**Interfaces:**

- Consumes: 仓库现有前端脚本和根开发服务器。
- Produces: 自动化检查结果与 `http://localhost:8001/` 可验收页面。

- [x] **Step 1: 运行前端 test、lint、typecheck 和 build**

所有命令必须无错误退出。

- [x] **Step 2: 从仓库根在 8001 启动正式开发入口**

设置 `PORT=8001` 后运行 `pnpm dev`，确认 Host 和内嵌 Vite 可访问。

- [x] **Step 3: 验收桌面和移动端**

确认侧栏仅保留设置入口、图标与历史任务同列，设置页可触发缓存导出。
