# BioMed-QAgent Frontend

BioMed-QAgent 的前端界面 —— 基于 React 19、Vite 5、Tailwind CSS v4 和 shadcn/ui 构建的单页应用。

提供研究主题输入、数据库选择、Agent 实时交互流、阶段进度可视化、工具调用追踪、人在回路 Dialog、后台任务通知和结果下载等完整工作流。

## 环境要求

- Node.js 18+
- pnpm（**请勿使用 npm**，锁文件以 `pnpm-lock.yaml` 为准）

## 安装与启动

```bash
cd frontend
pnpm install          # 安装依赖
pnpm dev              # 启动开发服务器 → http://localhost:5173
```

开发服务器会自动将 `/api` 代理到后端 `http://127.0.0.1:8000`，将 `/api/v1/ws` 代理到 WebSocket `ws://127.0.0.1:8000`。

## 可用命令

| 命令 | 说明 |
|------|------|
| `pnpm dev` | 启动 Vite 开发服务器（端口 5173） |
| `pnpm build` | TypeScript 类型检查 + Vite 生产构建 |
| `pnpm tsc` | 仅运行 TypeScript 类型检查（`tsc --noEmit`） |
| `pnpm lint` | ESLint 检查（`--max-warnings 0`） |
| `pnpm preview` | 预览生产构建产物 |
| `pnpm test` | 运行 Vitest 测试（单次） |
| `pnpm test:watch` | Vitest 监视模式 |

## 为打包构建

BioMed-QAgent 以桌面应用形式分发（.exe），前端构建产物内嵌于 PyInstaller 打包的二进制文件中。本节说明前端构建如何与打包流水线集成。

### CI/CD 自动构建

推送 tag（如 `v1.0.0`）触发 GitHub Actions 工作流：

1. `pnpm build` — TypeScript 检查 + Vite 生产构建，输出到 `frontend/dist/`
2. `dist/` 目录作为构建产物上传到 Actions artifact
3. PyInstaller 将 `dist/` 内嵌到单文件 exe 中（通过 `--add-data` 参数）
4. 最终产出发布到 GitHub Releases 页面

### 构建产物

`frontend/dist/` 目录包含：

- `index.html` — SPA 入口文件
- `assets/` — 打包后的 JavaScript、CSS、字体文件（哈希文件名，支持长效缓存）

生产模式下，后端 `launcher.py` 通过 FastAPI `StaticFiles` 挂载 `dist/` 目录，
所有静态资源由后端提供服务。Vite 代理（`/api` → `:8000`）**仅用于开发模式**。

### 手动构建步骤

```bash
# 1. 前端构建
cd frontend
pnpm build

# 2. 将构建产物复制到后端打包目录
cp -r dist/ ../backend/dist/   # Windows: Copy-Item -Recurse dist\ ..\backend\dist\

# 3. 执行 PyInstaller 打包（在项目根目录）
cd ..
pyinstaller --onefile --add-data "frontend/dist;dist" --add-data "backend/app;app" backend/launcher.py
```

### 开发说明

`pnpm dev` 仍然像之前一样工作——开发服务器自动代理 `/api` 到后端 `:8000`，
无需关心打包细节。本节仅文档化打包集成流程，不影响日常开发体验。

## 项目结构

```
frontend/
├── index.html                  # Vite 入口 HTML（lang="zh-CN"）
├── package.json                # 项目配置、脚本、依赖（packageManager pnpm 11.14）
├── pnpm-lock.yaml              # pnpm 锁文件（规范来源）
├── pnpm-workspace.yaml         # pnpm 工作区配置
├── eslint.config.js            # ESLint 配置（max-warnings 0）
├── vite.config.ts              # Vite 配置（React、Tailwind v4、代理、别名）
├── vitest.config.ts            # Vitest 配置（jsdom、@/ 别名）
├── tsconfig.json               # TypeScript 根配置（项目引用）
├── tsconfig.app.json           # 应用 TS 配置（strict、react-jsx）
├── tsconfig.node.json          # Node 端 TS 配置
├── components.json             # shadcn/ui 配置（base-nova、phosphor、Tailwind v4）
└── src/
    ├── main.tsx                # React 入口（字体、全局样式、渲染 <App/>）
    ├── App.tsx                 # 根布局：SidebarProvider + SessionSidebar + 主区域
    ├── styles/
    │   └── global.css          # Tailwind v4 导入、CSS 变量 (oklch)、亮/暗主题
    ├── lib/
    │   ├── utils.ts            # cn() 工具函数（clsx + tailwind-merge）
    │   └── fileUtils.ts        # 文件大小格式化、CSV 解析（papaparse）共享工具
    ├── runtime/                # Durable event transport / controller / reducer
    │   ├── contracts.ts        # 后端事件契约 TS 镜像（EventEnvelope + payload 联合）
    │   ├── types.ts            # TaskProjection / RunProjection / StageProjection 等前端状态类型
    │   ├── transport.ts        # WebSocket 自动重连 + sequence replay
    │   ├── controller.ts       # Task lifecycle 控制器（REST + WS 协同）
    │   └── reducer.ts          # 纯函数 reducer：events → Task/Run 投影
    ├── stores/
    │   ├── agentStore.ts       # Zustand 状态管理（tasksById / activitiesById / artifactsById）
    │   └── agentSelectors.ts   # 派生选择器（activeTask / selectActiveMessages 等）
    ├── hooks/
    │   ├── useAgentStream.ts   # WebSocket Hook（连接/断开/发送/解析事件）
    │   ├── useAPI.ts           # REST API Hook（数据库、任务、产物、resume）
    │   ├── useSettings.ts      # 模型设置 REST Hook（GET/POST /settings, GET /vendors, GET /models），内置 abort/last-request-wins 和初始带凭据加载
    │   ├── useTheme.ts         # 主题切换 Hook（localStorage 持久化）
    │   └── use-mobile.ts       # 移动端检测 Hook（断点 768px）
    ├── components/
    │   ├── SettingsPanel.tsx          # 模型设置面板（API 连接、模型选择、生成参数、高级参数），驱动 useSettings hook
    │   ├── AgentComposer.tsx          # 任务创建 / 续跑 composer（输入 + 数据库选择）
    │   ├── ArtifactWorkspace.tsx      # 产物工作区（按 Tab 分类展示 14 个 artifact）
    │   ├── BackgroundTaskNotifications.tsx # 后台任务 toast 通知 + View 失败反馈
    │   ├── ChatPanel.tsx              # 主工作区对话面板（ConversationList + 状态条 + 续跑输入）
    │   ├── DatabaseSelector.tsx       # 数据库选择器（分类分组、ToggleGroup）
    │   ├── MarkdownContent.tsx        # Markdown 渲染（react-markdown + remark-gfm）
    │   ├── ResultsViewer.tsx          # 产物展示（来源清单、文件卡片、CSV 预览）
    │   ├── SessionSidebar.tsx         # 会话历史侧边栏（任务列表、状态 Badge、删除）
    │   ├── ThemeToggle.tsx            # 亮/暗主题切换按钮
    │   ├── UserInputDialog.tsx        # 人在回路统一 Dialog（plan_confirmation / max_turns_reached / data_correction）
    │   ├── taskStatus.tsx             # 任务状态 Badge 组件
    │   ├── taskStatusMeta.ts          # 任务状态元数据（颜色、图标、文案映射）
    │   ├── artifactPanelControl.ts    # Artifact 面板状态控制
    │   ├── conversation/              # Coding agent 风格对话步骤流组件
    │   │   ├── ConversationList.tsx       # 列表渲染器（Fragment + MessageScrollerItem）
    │   │   ├── ConversationStep.tsx       # kind 分发器（switch item.kind）
    │   │   ├── UserMessageBubble.tsx      # 用户消息（右对齐 Bubble）
    │   │   ├── AssistantSegment.tsx       # Assistant 文本段（Markdown + 流式光标）
    │   │   ├── ReasoningBlock.tsx         # 思维链（默认折叠，流式时展开，500ms 后自动折叠）
    │   │   ├── ToolCallStep.tsx           # 工具调用（三态图标 + 可展开 arguments/output）
    │   │   ├── StageStep.tsx              # 阶段（紧凑单行 + Badge）
    │   │   ├── ProgressStep.tsx           # 进度（紧凑单行，同 kind 原位更新）
    │   │   ├── WarningStep.tsx            # 警告（紧凑单行，黄色）
    │   │   ├── ArtifactStep.tsx           # 产物（紧凑单行 + 文件大小 Badge）
    │   │   ├── toolLabels.ts              # toolName + args → {verb, target, details?} 映射
    │   │   ├── stageLabels.ts             # STAGE_LABELS + PROGRESS_LABELS 中文映射
    │   │   └── __tests__/                 # 组件单元测试（4 文件）
    │   └── ui/                        # 36 个 shadcn/ui 组件（见下方清单）
    └── test/
        ├── setup.ts                   # Vitest 配置导入（jest-dom、jsdom）
        ├── app.test.tsx               # App 根布局渲染
        ├── api.test.ts                # useAPI REST 调用
        ├── agent-stream.test.ts       # useAgentStream WebSocket 事件解析
        ├── artifact-workspace.test.tsx # ArtifactWorkspace Tab 切换与 CSV 预览
        ├── background-task-notifications.test.tsx # 后台通知 View 失败反馈
        ├── chat-panel.test.tsx        # ChatPanel ConversationList 渲染 + 状态条
        ├── hydrate-compat.test.ts     # MessageRecord → ConversationItem 投影兼容
        ├── items-ordering.test.ts     # ConversationItem sequence 排序 + 去重
        ├── markdown-streaming.test.tsx # AssistantSegment 流式光标 + Markdown
        ├── realtime-stream-reducer.test.ts # 实时 assistant_stream_delta 投影
        ├── results-viewer.test.tsx    # ResultsViewer 空判定与产物列表
        ├── runtime-controller.test.ts # Controller REST + WS 协同
        ├── runtime-reducer.test.ts    # Reducer 事件投影（含 ConversationItem 项目化）
        ├── session-sidebar.test.tsx   # SessionSidebar 任务列表 + 删除
        ├── store.test.ts              # Zustand Store 初始化
        └── user-input-dialog.test.tsx # UserInputDialog plan_confirmation / max_turns_reached
```

## 组件树

```
<App>
  <SidebarProvider>
    <SessionSidebar />              ← 左侧：任务历史、运行中 N/4、当前任务信息（含"设置"入口）
    <SidebarInset>
      <header>                       ← 顶部：侧边栏触发器 + 标题 + 主题切换
        <ThemeToggle />
      </header>
      <main>
        <SettingsPanel />            ← 设置面板（showSettings=true 时替代主工作区）：API 连接 / 模型选择 / 生成参数 / 高级参数
        <AgentComposer />            ← 任务创建 / 续跑输入区
        <ChatPanel>                  ← 主对话区（coding agent 风格步骤流）
          <Marker>                   ← 状态条：活跃 item 简述（如"检索 PubMed · 查询: ..."）
          <MessageScroller>
            <ConversationList>       ← 按 sequence 排序的 ConversationItem 列表
              <UserMessageBubble />  ←   user 消息（右对齐）
              <ReasoningBlock />     ←   思维链（默认折叠，流式时展开）
              <ToolCallStep />       ←   工具调用（三态图标 + 可展开）
              <StageStep />          ←   阶段（紧凑单行）
              <ProgressStep />       ←   进度（紧凑单行）
              <WarningStep />        ←   警告（紧凑单行）
              <ArtifactStep />       ←   产物（紧凑单行）
              <AssistantSegment />   ←   Assistant 文本段（Markdown + 光标）
            </ConversationList>
          </MessageScroller>
          <AgentComposer />          ← 续跑输入区
        </ChatPanel>
        <ArtifactWorkspace>          ← 结果展示（按 Tab 分类）
          <Tabs>
            <TabsContent "主数据">
            <TabsContent "来源">
            <TabsContent "处理">
            <TabsContent "警告">
          </Tabs>
          <ResultsViewer />
        </ArtifactWorkspace>
        <UserInputDialog />          ← HIL 模态（按 prompt_kind 渲染分支）
        <BackgroundTaskNotifications /> ← toast 通知（含 View 失败反馈）
      </main>
    </SidebarInset>
  </SidebarProvider>
</App>
```

### 页面说明

当前应用为**单页应用**，不使用 React Router。任务工作台和设置面板按以下分区组织：

| 分区 | 组件 | 功能 |
|------|------|------|
| **模型设置** | `SettingsPanel` + `useSettings` | 替代主工作区的全屏面板：API 连接（Base URL + API Key）、模型下拉选择（`ScrollArea className="h-72"` 固定高度可滚动列表，带凭据发现后显示可用模型及多模态能力 Badge）、生成参数（max_tokens 滑块 + 高级展开区）。api_key 空输入清除、掩码保留；四路独立 AbortController 实现 last-request-wins；`onSave` 仅发送 dirty 字段，保存成功后异步刷新模型列表 |
| **任务创建** | `AgentComposer` + `DatabaseSelector` | 输入研究目标、选择数据库、启动任务或续跑 |
| **对话流** | `ChatPanel` + `ConversationList` + `MarkdownContent` | coding agent 风格步骤流：用户输入 / 思维链 / 工具调用 / 阶段 / 进度 / 警告 / 产物 / Assistant 文本段，按 sequence 顺序交错渲染 |
| **状态条** | `ChatPanel` 顶部 `Marker` | Run running 时显示活跃 item 简述（如"检索 PubMed · 查询: 'lung cancer'"），否则显示 `STATUS_LABELS[task.status]` |
| **结果** | `ArtifactWorkspace` + `ResultsViewer` | 14 个 artifact 按 Tab 分类展示，CSV 预览、下载 |
| **人在回路** | `UserInputDialog` | 计划确认 / max_turns_reached / 数据修正统一 Dialog，按 Run+request_id 隔离 |
| **后台通知** | `BackgroundTaskNotifications` | 任务终态、View 失败、HIL 等异步通知 |

## 状态管理

使用 **Zustand** 单一 Store（`agentStore.ts`），通过 selector 派生视图层数据。Store 不持久化会话事实到 localStorage（会话事实由后端 durable runtime 持有）；前端只缓存 UI 偏好与主题。

### Store 结构

```typescript
interface AgentStore {
  // 任务投影（按 task_id 索引）
  tasksById: Record<string, TaskProjection>
  activeItems: string[]                         // active task_id 列表（按 created_at DESC）
  // 全局
  activeTaskId: string | null
  nextCursor: string | null                     // 历史分页 cursor
  connectionStatus: "idle" | "connected" | "reconnecting" | "error"
  historyStatus: "idle" | "loading" | "ready" | "error"
  historyError: string | null
  // 草稿态
  draft: {
    input: string
    selectedDatabaseIds: string[]
    mode: "agent" | "fixture"
    error: string | null
  }
  databases: DatabaseInfo[]
}

interface TaskProjection {
  summary: TaskSummary                          // 后端权威 TaskSummary
  runsById: Record<string, RunProjection>
  runOrder: string[]
  // ConversationItem 列表（coding agent 风格对话流的主要数据源）
  items: ConversationItem[]                     // 按 sequence 升序，itemId 去重
  itemSequences: Record<string, number>         // itemId → latest sequence
  currentReasoningSegmentByRun: Record<string, number>  // runId → reasoning 段索引
  // 旧字段（保留用于分页加载和旧事件回放，ChatPanel 不再直接消费）
  messages: ProjectedMessage[]
  olderMessagesCursor: string | null
  activitiesById: Record<string, ActivityProjection>
  activityOrder: string[]
  artifactsById: Record<string, ArtifactProjection>
  artifactOrder: string[]
  artifactEventSequences: Record<string, number>
  artifactManifestSequence: number | null
  stages: Record<string, StageProjection>
  assistantStreamsByRunId: Record<string, AssistantStreamProjection>
  pendingUserInput: PendingUserInput | null      // 绑定 task_id + run_id + request_id
  lastSequence: number
  hydration: "summary" | "snapshot"
}
```

**ConversationItem 联合类型**（8 种 kind，详见
[ARCHITECTURE.md §9.1](../docs/ARCHITECTURE.md#91-对话流展示coding-agent-风格)）：
`user_message` / `assistant_segment` / `reasoning` / `tool_call` / `stage` /
`progress` / `warning` / `artifact`。reducer 按 `itemId` 去重 + `sequence` 升序
维护 `items` 列表，ChatPanel 通过 `selectActiveItems` 订阅，`selectActiveItem`
返回最后一个活跃 item（`isStreaming=true` 或 `status=running`）用于状态条显示。

完整类型定义见 [`runtime/types.ts`](src/runtime/types.ts)，派生选择器见
[`stores/agentSelectors.ts`](src/stores/agentSelectors.ts)。

## 数据流

### WebSocket 实时通信（durable event stream）

`runtime/transport.ts` 管理 WebSocket 连接生命周期，`runtime/controller.ts` 协调 REST + WS：

```
通过 REST 创建任务或续跑（POST /tasks 或 /tasks/{id}/runs）
        │
        ├── 连接 ws://host/api/v1/ws
        ├── 发送 { type: "subscribe", task_id, after_sequence }
        │
        ▼
接收按 sequence 排序的 durable EventEnvelope
        │
        ├── 优先重放 sequence > after_sequence 的历史事件（HTTP /events fallback）
        └── 进入 live fan-out
        │
        ▼
runtime/reducer.ts 纯函数 reducer
        │
        └── 更新 tasksById[task_id] 的 Run/message/activity/artifact/stage 投影
```

WebSocket 仅发送 `subscribe`、`unsubscribe` 和 `ping` 控制命令；断线重连后从 Task 的 `lastSequence` 继续 replay。`controller.ts` 在 snapshot/accepted-Task handoff 时使用 REST `/events` 重放填补间隙。

### REST API 补充数据

`hooks/useAPI.ts`（任务相关）和 `hooks/useSettings.ts`（模型配置）通过 HTTP 获取数据：

`useSettings.ts` 使用四个独立的 **AbortController**（settings / vendors / models /
save）。每条 lane 的新请求都会 `abort()` 前一个未完成请求；只有当前 save 可以更新
设置与 `saving` 状态，组件卸载会取消全部 lane。POST 成功即代表设置已持久化，后续
模型发现失败只更新可见错误状态，不会把已成功保存误报为失败。模型列表在设置加载
完毕且含有效凭据后自动触发一次 `GET /models?use_current_settings=true`；初始化时
并行加载 settings 和 vendors。

| 调用 | 端点 | 时机 |
|------|------|------|
| `fetchDatabases()` | `GET /api/v1/databases` | 页面加载时 |
| `fetchTasks()` | `GET /api/v1/tasks` | 加载历史 + cursor 分页 |
| `fetchTaskStatus(id)` | `GET /api/v1/tasks/{id}` | 任务状态查询 |
| `fetchTaskMessages(id)` | `GET /api/v1/tasks/{id}/messages` | 历史消息分页 |
| `fetchArtifacts(id)` | `GET /api/v1/tasks/{id}/artifacts` | 任务完成后 |
| `submitResume(...)` | `POST /api/v1/tasks/{id}/runs/{rid}/resume` | HIL 决策提交 |
| `cancelRun(...)` | `POST /api/v1/tasks/{id}/runs/{rid}/cancel` | 取消 Run |
| `getArtifactUrl(...)` | `GET /api/v1/tasks/{id}/artifacts/{aid}` | 下载产物 |
| `fetchSettings()` | `GET /api/v1/settings` | 加载用户设置（api_key 掩码）|
| `updateSettings(payload)` | `POST /api/v1/settings` | 保存用户设置 |
| `fetchVendors()` | `GET /api/v1/vendors` | 加载供应商列表 |
| `fetchModels(query, baseUrl)` | `GET /api/v1/models?query=&preview_base_url=` | 按搜索或预览 URL 发现模型 |
| `refreshModels()` | `GET /api/v1/models?use_current_settings=true` | 使用已保存凭据发现模型 |

### Vite 代理配置

```typescript
// vite.config.ts
server: {
  proxy: {
    '/api': {
      target: 'http://127.0.0.1:8000',
      changeOrigin: true,
    },
    '/api/v1/ws': {
      target: 'ws://127.0.0.1:8000',
      ws: true,
    },
  },
}
```

## 技术栈

| 类别 | 技术 | 版本 |
|------|------|------|
| **框架** | React | 19.2 |
| **语言** | TypeScript | 5.6 |
| **构建** | Vite | 5.4 |
| **CSS** | Tailwind CSS | v4.3 |
| **UI 组件** | shadcn/ui (base-nova) + @base-ui/react | — |
| **图标** | lucide-react + @phosphor-icons/react | — |
| **状态管理** | Zustand | 4.5 |
| **Markdown** | react-markdown + remark-gfm | 10.1 / 4.0 |
| **CSV 解析** | papaparse | 5.5 |
| **可调整面板** | react-resizable-panels | 4.12 |
| **测试** | Vitest + Testing Library + jsdom | 3.2 / 16.3 / 29.1 |
| **字体** | Inter Variable（@fontsource-variable/inter） | — |

### shadcn 组件清单

`src/components/ui/` 包含 36 个组件：

| 组件 | 用途 |
|------|------|
| `accordion` | 可折叠区域 |
| `alert` / `alert-dialog` | 警告框 / 警告对话框 |
| `attachment` | 附件展示 |
| `avatar` | 用户/机器人头像 |
| `badge` | 状态标签 |
| `bubble` | 消息气泡 |
| `button` | 按钮（default/outline/ghost） |
| `card` | 卡片容器 |
| `combobox` | 组合下拉框 |
| `command` | 命令面板（cmdk） |
| `dialog` | 模态对话框 |
| `dropdown-menu` | 下拉菜单 |
| `empty` | 空状态 |
| `field` | 表单字段容器 |
| `input` / `input-group` | 文本输入框 / 带标签输入组 |
| `label` | 标签 |
| `marker` | 标记/分隔符 |
| `message` / `message-scroller` | 消息行 / 自动滚动消息列表 |
| `progress` | 进度条 |
| `resizable` | 可调整大小面板 |
| `scroll-area` | 可滚动容器 |
| `separator` | 分隔线 |
| `sheet` | 侧滑面板（用于 ToolTrace） |
| `sidebar` | 侧边栏布局 |
| `skeleton` | 加载骨架屏 |
| `sonner` | toast 通知 |
| `spinner` | 加载旋转器 |
| `table` | 数据表格 |
| `tabs` | 标签页导航 |
| `textarea` | 多行文本输入 |
| `toggle` / `toggle-group` | 单一切换按钮 / 多选切换组 |
| `tooltip` | 悬浮提示 |

## 测试

```bash
pnpm test              # 运行所有测试
pnpm test:watch        # 监视模式
pnpm tsc               # TypeScript 类型检查
pnpm lint              # ESLint（0 warnings）
pnpm build             # TypeScript + Vite 生产构建
```

### 测试覆盖（17 文件 / 320+ 测试，2026-07-20）

| 测试文件 | 覆盖内容 |
|----------|----------|
| `app.test.tsx` | App 根布局渲染 |
| `api.test.ts` | useAPI REST 调用 |
| `agent-stream.test.ts` | useAgentStream WebSocket 事件解析 |
| `artifact-workspace.test.tsx` | ArtifactWorkspace Tab 切换与 CSV 预览 |
| `background-task-notifications.test.tsx` | 后台通知 View 失败反馈 |
| `chat-panel.test.tsx` | ChatPanel ConversationList 渲染 + 状态条简述 |
| `hydrate-compat.test.ts` | MessageRecord → ConversationItem 投影兼容 |
| `items-ordering.test.ts` | ConversationItem sequence 排序 + itemId 去重 |
| `markdown-streaming.test.tsx` | AssistantSegment 流式光标 + Markdown 渲染 |
| `realtime-stream-reducer.test.ts` | 实时 assistant_stream_delta 投影 |
| `results-viewer.test.tsx` | ResultsViewer 空判定与产物列表 |
| `runtime-controller.test.ts` | Controller REST + WS 协同 |
| `runtime-reducer.test.ts` | Reducer 事件投影（含 ConversationItem 项目化、stage_progress / user_input） |
| `session-sidebar.test.tsx` | SessionSidebar 任务列表 + 删除 |
| `store.test.ts` | Zustand Store 初始化 |
| `user-input-dialog.test.tsx` | UserInputDialog plan_confirmation / max_turns_reached |
| `conversation/__tests__/ConversationStep.test.tsx` | 8 种 kind 分发器渲染快照 |
| `conversation/__tests__/ToolCallStep.test.tsx` | running/completed/error 三态、展开/折叠、arguments/output |
| `conversation/__tests__/ReasoningBlock.test.tsx` | 默认折叠、流式展开、500ms 自动折叠、手动覆盖 |
| `conversation/__tests__/toolLabels.test.ts` | 13 个工具映射 + 兜底 |

## 待补充的内容建议

以下是在前端 README 体系中可以考虑补充的模块：

### 设计与规范

- **设计系统说明**：色彩变量（oklch）、间距、圆角、阴影等 Token 定义
- **组件文档**：每个业务组件的 Props、状态、使用示例
- **响应式断点**：当前仅在 `use-mobile.ts` 中定义了 768px 断点，需补充完整断点体系

### 开发规范

- **组件开发约定**：何时使用 shadcn 组件 vs 自定义组件
- **状态管理规范**：什么数据放 Store vs 组件本地状态 vs Context
- **命名约定**：文件、组件、Hook、事件的命名规则

### 运维与部署

- **静态部署**：`pnpm build` 产物为纯静态文件，可部署到 Nginx、CDN 等
- **环境变量**：生产环境 API 地址配置方案
- **性能优化**：代码分割、懒加载、图片优化策略

## 相关文档

- [项目架构设计（权威）](../docs/ARCHITECTURE.md)
- [后端 README](../backend/README.md)
- [开发 TODO](../docs/TODO.md)
- [2026-07-18 流程审查报告](../docs/REVIEW_2026-07-18.md)
