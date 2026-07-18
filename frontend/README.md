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
    │   ├── useTheme.ts         # 主题切换 Hook（localStorage 持久化）
    │   └── use-mobile.ts       # 移动端检测 Hook（断点 768px）
    ├── components/
    │   ├── AgentComposer.tsx          # 任务创建 / 续跑 composer（输入 + 数据库选择）
    │   ├── AgentProgress.tsx          # Agent 模式 stage/进度卡片（含 AgentStageList）
    │   ├── ArtifactWorkspace.tsx      # 产物工作区（按 Tab 分类展示 14 个 artifact）
    │   ├── BackgroundTaskNotifications.tsx # 后台任务 toast 通知 + View 失败反馈
    │   ├── ChatPanel.tsx              # 主工作区对话面板（assistant delta + 工具卡片穿插）
    │   ├── DatabaseSelector.tsx       # 数据库选择器（分类分组、ToggleGroup）
    │   ├── MarkdownContent.tsx        # Markdown 渲染（react-markdown + remark-gfm）
    │   ├── ResearchPipeline.tsx       # 5 阶段管道进度条 + 跨模式 stage 投影
    │   ├── ResultsViewer.tsx          # 产物展示（来源清单、文件卡片、CSV 预览）
    │   ├── SessionSidebar.tsx         # 会话历史侧边栏（任务列表、状态 Badge、删除）
    │   ├── ThemeToggle.tsx            # 亮/暗主题切换按钮
    │   ├── ToolTrace.tsx              # 工具调用追踪面板（shadcn Sheet，右侧滑出）
    │   ├── UserInputDialog.tsx        # 人在回路统一 Dialog（plan_confirmation / max_turns_reached / data_correction）
    │   ├── taskStatus.tsx             # 任务状态 Badge 组件
    │   ├── taskStatusMeta.ts          # 任务状态元数据（颜色、图标、文案映射）
    │   ├── artifactPanelControl.ts    # Artifact 面板状态控制
    │   └── ui/                        # 36 个 shadcn/ui 组件（见下方清单）
    └── test/
        ├── setup.ts                   # Vitest 配置导入（jest-dom、jsdom）
        ├── app.test.tsx               # App 根布局渲染
        ├── api.test.ts                # useAPI REST 调用
        ├── agent-progress.test.tsx    # AgentProgress + AgentStageList
        ├── agent-stream.test.ts       # useAgentStream WebSocket 事件解析
        ├── artifact-workspace.test.tsx # ArtifactWorkspace Tab 切换与 CSV 预览
        ├── background-task-notifications.test.tsx # 后台通知 View 失败反馈
        ├── chat-panel.test.tsx        # ChatPanel 消息渲染 + 多行换行
        ├── research-pipeline.test.tsx # ResearchPipeline 阶段卡片
        ├── results-viewer.test.tsx    # ResultsViewer 空判定与产物列表
        ├── runtime-controller.test.ts # Controller REST + WS 协同
        ├── runtime-reducer.test.ts    # Reducer 事件投影
        ├── session-sidebar.test.tsx   # SessionSidebar 任务列表 + 删除
        ├── store.test.ts              # Zustand Store 初始化
        ├── tool-trace.test.tsx        # ToolTrace Sheet 展开/折叠
        └── user-input-dialog.test.tsx # UserInputDialog plan_confirmation / max_turns_reached
```

## 组件树

```
<App>
  <SidebarProvider>
    <SessionSidebar />              ← 左侧：任务历史、运行中 N/4、当前任务信息
    <SidebarInset>
      <header>                       ← 顶部：侧边栏触发器 + 标题 + 主题切换
        <ThemeToggle />
      </header>
      <main>
        <AgentComposer />            ← 任务创建 / 续跑输入区
        <ResearchPipeline />         ← 5 阶段进度卡片（跨模式 stage 投影）
        <AgentProgress />            ← Agent 模式 stage/进度 chips
        <ChatPanel>                  ← 主对话区
          <MessageScroller>
            <Message> + <Bubble>     ← assistant_delta + 工具卡片穿插
          </MessageScroller>
          <MarkdownContent />        ← Markdown 渲染
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
        <ToolTrace />                ← 右下角浮动按钮 → Sheet 面板
        <UserInputDialog />          ← HIL 模态（按 prompt_kind 渲染分支）
        <BackgroundTaskNotifications /> ← toast 通知（含 View 失败反馈）
      </main>
    </SidebarInset>
  </SidebarProvider>
</App>
```

### 页面说明

当前应用为**单页应用**，不使用 React Router。任务工作台按以下分区组织：

| 分区 | 组件 | 功能 |
|------|------|------|
| **任务创建** | `AgentComposer` + `DatabaseSelector` | 输入研究目标、选择数据库、启动任务或续跑 |
| **进度可视化** | `ResearchPipeline` + `AgentProgress` | 跨模式 stage 投影、Agent 模式进度 chips、N 篇/M 条/K 行中间进度 |
| **对话** | `ChatPanel` + `MarkdownContent` | 实时 assistant_delta、工具卡片穿插、用户后续指令 |
| **结果** | `ArtifactWorkspace` + `ResultsViewer` | 14 个 artifact 按 Tab 分类展示，CSV 预览、下载 |
| **人在回路** | `UserInputDialog` | 计划确认 / max_turns_reached / 数据修正统一 Dialog，按 Run+request_id 隔离 |
| **工具追踪** | `ToolTrace` | 工具调用完整 trace，默认折叠，按需展开 |
| **后台通知** | `BackgroundTaskNotifications` | 任务终态、View 失败、HIL 等异步通知 |

## 状态管理

使用 **Zustand** 单一 Store（`agentStore.ts`），通过 selector 派生视图层数据。Store 不持久化会话事实到 localStorage（会话事实由后端 durable runtime 持有）；前端只缓存 UI 偏好与主题。

### Store 结构

```typescript
interface AgentStore {
  // 任务投影（按 task_id 索引）
  tasksById: Record<string, TaskProjection>
  activitiesById: Record<string, ActivityRecord>    // stage / progress / tool 事件
  artifactsById: Record<string, ArtifactRecord>

  // 当前活动任务
  activeTaskId: string | null

  // 配置
  databases: DatabaseInfo[]
  selectedDatabases: string[]

  // 连接状态
  isWebSocketConnected: boolean

  // 人在回路
  pendingUserInput: PendingUserInput | null  // 绑定 task_id + run_id + request_id
}
```

完整类型定义见 [`runtime/types.ts`](src/runtime/types.ts)，派生选择器见 [`stores/agentSelectors.ts`](src/stores/agentSelectors.ts)。

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

`hooks/useAPI.ts` 通过 HTTP 获取初始化数据和静态资源：

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

### 测试覆盖（15 文件 / 200+ 测试，2026-07-19）

| 测试文件 | 覆盖内容 |
|----------|----------|
| `app.test.tsx` | App 根布局渲染 |
| `api.test.ts` | useAPI REST 调用 |
| `agent-progress.test.tsx` | AgentProgress + AgentStageList 渲染 |
| `agent-stream.test.ts` | useAgentStream WebSocket 事件解析 |
| `artifact-workspace.test.tsx` | ArtifactWorkspace Tab 切换与 CSV 预览 |
| `background-task-notifications.test.tsx` | 后台通知 View 失败反馈 |
| `chat-panel.test.tsx` | ChatPanel 消息渲染 + 多行换行保留 |
| `research-pipeline.test.tsx` | ResearchPipeline 阶段卡片 |
| `results-viewer.test.tsx` | ResultsViewer 空判定与产物列表 |
| `runtime-controller.test.ts` | Controller REST + WS 协同 |
| `runtime-reducer.test.ts` | Reducer 事件投影（含 stage_progress / user_input） |
| `session-sidebar.test.tsx` | SessionSidebar 任务列表 + 删除 |
| `store.test.ts` | Zustand Store 初始化 |
| `tool-trace.test.tsx` | ToolTrace Sheet 展开/折叠 |
| `user-input-dialog.test.tsx` | UserInputDialog plan_confirmation / max_turns_reached |

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
