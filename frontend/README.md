# BioMed-QAgent Frontend

BioMed-QAgent 的前端界面 —— 基于 React 19、Vite 5、Tailwind CSS v4 和 shadcn/ui 构建的单页应用。

提供研究主题输入、数据库选择、Agent 实时交互流、工具调用追踪和结果下载等完整工作流。

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
| `pnpm tsc` | 仅运行 TypeScript 类型检查（不构建） |
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

```
frontend/
├── index.html                  # Vite 入口 HTML（lang="zh-CN"）
├── package.json                # 项目配置、脚本、依赖
├── pnpm-lock.yaml              # pnpm 锁文件（规范来源）
├── vite.config.ts              # Vite 配置（React、Tailwind v4、代理、别名）
├── vitest.config.ts            # Vitest 配置（jsdom、@/ 别名）
├── tsconfig.json               # TypeScript 根配置（项目引用）
├── tsconfig.app.json           # 应用 TS 配置（strict、react-jsx）
├── tsconfig.node.json          # Node 端 TS 配置
├── components.json             # shadcn/ui 配置（base-nova、phosphor、Tailwind v4）
└── src/
    ├── main.tsx                # React 入口（字体、全局样式、渲染 <App/>）
    ├── App.tsx                 # 根布局：侧边栏 + 主区域（ChatPanel + ToolTrace）
    ├── styles/
    │   └── global.css          # Tailwind v4 导入、CSS 变量 (oklch)、亮/暗主题
    ├── lib/
    │   └── utils.ts            # cn() 工具函数（clsx + tailwind-merge）
    ├── stores/
    │   └── agentStore.ts       # Zustand 状态管理（消息、Trace、会话、数据库）
    ├── hooks/
    │   ├── useAgentStream.ts   # WebSocket Hook（连接/断开/发送/解析事件）
    │   ├── useAPI.ts           # REST API Hook（数据库、任务、产物）
    │   ├── useTheme.ts         # 主题切换 Hook（localStorage 持久化）
    │   └── use-mobile.ts       # 移动端检测 Hook（断点 768px）
    ├── components/
    │   ├── SessionSidebar.tsx   # 会话历史侧边栏（会话列表、连接状态、主题切换）
    │   ├── Sidebar.tsx          # 旧版侧边栏（已替换，保留引用）
    │   ├── ChatPanel.tsx        # 主工作区 3 标签页（设置/对话/结果）
    │   ├── ToolTrace.tsx        # 工具调用追踪面板（shadcn Sheet，右侧滑出）
    │   ├── ResearchPipeline.tsx # 5 阶段管道进度条 + 超时保护
    │   ├── ResultsViewer.tsx    # 产物展示（来源清单、文件卡片、CSV 预览）
    │   ├── DatabaseSelector.tsx # 数据库选择器（分类分组、全选）
    │   ├── ThemeToggle.tsx      # 亮/暗主题切换按钮
    │   └── ui/                  # 28 个 shadcn/ui 组件（见下方列表）
    └── test/
        ├── setup.ts            # Vitest 配置导入
        └── store.test.ts       # agentStore 单元测试
```

## 组件树

```
<App>
  <SidebarProvider>
    <SessionSidebar />            ← 左侧：会话历史、当前会话信息
    <SidebarInset>
      <header>                     ← 顶部：侧边栏触发器 + 标题 + 主题切换
        <ThemeToggle />
      </header>
      <main>
        <ChatPanel>               ← 主工作区
          <Tabs>
            <TabsContent "设置">    ← 研究目标输入 + 数据库选择
              <DatabaseSelector />
            </TabsContent>
            <TabsContent "对话">    ← Agent 交互
              <ResearchPipeline />  ← 进度条
              <MessageScroller>     ← 消息列表
                <Message> + <Bubble>
              </MessageScroller>
              <Textarea>            ← 用户输入
            </TabsContent>
            <TabsContent "结果">    ← 产物展示
              <ResultsViewer />
            </TabsContent>
          </Tabs>
        </ChatPanel>
        <ToolTrace />              ← 右下角浮动按钮 → Sheet 面板
      </main>
    </SidebarInset>
  </SidebarProvider>
</App>
```

### 页面说明

当前应用为**单页应用**，不使用 React Router。导航通过 shadcn `<Tabs>` 组件实现三个工作区切换：

| 标签页 | 功能 |
|--------|------|
| **设置** | 输入研究目标、选择数据库范围（按发现/采集/处理分类）、启动任务 |
| **对话** | 实时显示 Agent 输出、工具调用进度（管道条）、发送后续指令 |
| **结果** | 查看产物文件列表、来源清单、下载产物 |

## 状态管理

使用 **Zustand** 单一 Store（`agentStore.ts`），通过 `persist` 中间件将 `sessions[]` 持久化到 `localStorage`（键名 `biomed-sessions`）。

### Store 结构

```typescript
interface AgentState {
  // 实时状态
  messages: ChatMessage[]         // 对话消息列表
  traces: TraceItem[]             // 工具调用追踪记录
  isConnected: boolean            // WebSocket 连接状态
  isRunning: boolean              // Agent 是否运行中
  pipelineStage: PipelineStage    // 当前管道阶段

  // 配置
  databases: DatabaseInfo[]       // 可用数据库列表
  selectedDatabases: string[]     // 用户选择的数据库

  // 产物
  artifacts: Artifact[]           // 产物文件列表
  taskId: string | null           // 当前任务 ID

  // 会话（持久化）
  sessions: Session[]             // 历史会话列表
  currentSessionId: string | null // 当前会话 ID
}
```

## 数据流

### WebSocket 实时通信

`useAgentStream.ts` 管理 WebSocket 连接生命周期：

```
连接 ws://host/api/v1/ws
        │
        ├── 发送 { type: "run", input, databases }
        │
        ▼
接收 WSEvent（9 种事件类型）：
  ├── text              → store.addMessage()
  ├── tool_call         → store.addTrace()
  ├── tool_output       → store.addTrace()
  ├── skill_loaded      → store.addMessage()
  ├── artifact_produced → store.addArtifact()
  ├── file_downloaded   → store.addMessage()
  ├── confirm           → store.addMessage()（请求用户确认）
  ├── done              → store.setRunning(false)、ChatPanel 自动获取产物
  └── error             → store.addMessage()（错误提示）
```

### REST API 补充数据

`useAPI.ts` 通过 HTTP 获取初始化数据和静态资源：

| 调用 | 端点 | 时机 |
|------|------|------|
| `fetchDatabases()` | `GET /api/v1/databases` | 页面加载时 |
| `fetchTaskStatus()` | `GET /api/v1/tasks/{id}` | 查询任务进度 |
| `fetchArtifacts()` | `GET /api/v1/tasks/{id}/artifacts` | 任务完成后 |
| `getArtifactUrl()` | `GET /api/v1/tasks/{id}/artifacts/{name}` | 下载产物文件 |

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
| **UI 组件** | shadcn/ui (base-nova) | — |
| **图标** | lucide-react + @phosphor-icons/react | — |
| **状态管理** | Zustand | 4.5 |
| **测试** | Vitest + Testing Library | 3.2 / 16.3 |
| **字体** | Inter Variable | — |

### shadcn 组件清单

`src/components/ui/` 包含 28 个组件：

| 组件 | 用途 |
|------|------|
| `accordion` | 可折叠区域 |
| `avatar` | 用户/机器人头像 |
| `badge` | 状态标签 |
| `bubble` | 消息气泡 |
| `button` | 按钮（default/outline/ghost） |
| `card` | 卡片容器 |
| `command` | 命令面板（cmdk） |
| `dialog` | 模态对话框 |
| `dropdown-menu` | 下拉菜单 |
| `input` | 文本输入框 |
| `input-group` | 带标签的输入组 |
| `marker` | 标记/分隔符 |
| `message` | 消息行（头像 + 内容） |
| `message-scroller` | 自动滚动消息列表 |
| `progress` | 进度条 |
| `scroll-area` | 可滚动容器 |
| `separator` | 分隔线 |
| `sheet` | 侧滑面板（用于 ToolTrace） |
| `sidebar` | 侧边栏布局 |
| `skeleton` | 加载骨架屏 |
| `spinner` | 加载旋转器 |
| `table` | 数据表格 |
| `tabs` | 标签页导航 |
| `textarea` | 多行文本输入 |
| `toggle` | 单一切换按钮 |
| `toggle-group` | 多选切换组（用于 DatabaseSelector） |
| `tooltip` | 悬浮提示 |

## 测试

```bash
pnpm test              # 运行所有测试
pnpm test:watch        # 监视模式
pnpm tsc               # TypeScript 类型检查
```

当前测试覆盖：
- `store.test.ts`：Zustand Store 初始化、会话增删、管道阶段切换、reset 保留会话

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
