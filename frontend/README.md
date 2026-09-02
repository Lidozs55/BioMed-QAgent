# BioMed-QAgent Frontend

React 19 前端通过 TypeScript Application Host 的同一端口提供任务对话、durable 事件投影、人在回路、Family Host 拓扑、模型设置和正式产物查看。

## 开发入口

正常开发必须从仓库根启动：

```bash
pnpm install --frozen-lockfile
pnpm dev
```

打开 `http://127.0.0.1:5173`。Vite 以 middleware 形式运行在 TS Host 内；仓库根 `pnpm-lock.yaml` 是唯一 lockfile。

`frontend/` 下的 `pnpm dev` 只是定向诊断。它不会启动 Host；如确需使用，先单独启动根 Host，并通过 `VITE_BACKEND_TARGET` 指向其地址。默认同样指向 `http://127.0.0.1:5173`，因此不能与 Host 同时占用 5173，通常需要显式覆盖 Vite 端口。

## 定向命令

在 `frontend/` 执行：

```bash
pnpm build        # tsc -b + Vite production build
pnpm tsc          # TypeScript project check
pnpm lint         # ESLint，0 warnings
pnpm test         # Vitest 单次运行
pnpm test:watch   # Vitest watch
pnpm preview      # 预览已构建静态资源
```

任务结束时从仓库根执行 workspace 级质量门（`lint` / `typecheck` / `build`）与受影响区域的测试；全量 `pnpm test` 仅在跨共享边界改动时需要：

```bash
pnpm --filter @biomed/frontend test   # 定向测试
pnpm lint
pnpm typecheck
pnpm build
```

## 代码边界

```text
src/
├── api/            HTTP client 与 wire parsing
├── runtime/        durable event transport/controller/reducer
├── stores/         Zustand 投影状态与 selectors
├── hooks/          页面级数据和交互 hooks
├── components/
│   ├── artifacts/  正式产物与预览
│   ├── conversation/ 对话事件投影
│   ├── family-host/ Family Host 拓扑与详情
│   ├── intervention/ HIL / permission UI
│   ├── settings/   模型与权限设置
│   └── ui/         shadcn/Base UI primitives
├── styles/         Tailwind v4 与主题 token
└── test/           共享测试 setup/fixtures
```

- Wire DTO 先定义在 `@biomed/contracts`，前端不得维护第二份协议真相。
- durable task 事实来自后端事件流；Zustand 只保存投影和 UI 状态。
- WebSocket 负责实时 fan-out，断线后按 sequence 通过 HTTP replay 补齐。
- 产物是否正式以服务端 Publication/manifest 为准，前端不通过文件数量或错误字符串推断。
- 使用 `@/` alias；禁止 `as any`、`@ts-ignore` 和 `@ts-expect-error`。

## UI 约定

修改前先读 [`AGENTS.md`](AGENTS.md)。优先复用 `src/components/ui/` 与现有业务组件，并通过仓库 shadcn 工作流查询/添加组件；不要手写第二套 primitive。新增交互需覆盖键盘、aria label、loading/error/empty 状态和亮暗主题。

组件 API 和实际目录以代码为准，不在 README 维护易漂移的逐文件清单。架构说明见 [`docs/architecture/agent-frontend.md`](https://github.com/Lidozs55/BioMed-QAgent/blob/dev/docs/architecture/agent-frontend.md)。

## 生产构建

根 `pnpm build` 生成 `frontend/dist/` 和 `server/dist/`；`pnpm start` 由 TS Host 静态托管前端并提供 `/api/v1`。打包流水线见 [`.github/workflows/package.yml`](../.github/workflows/package.yml)。不存在 Python `:8000` 后端或 PyInstaller 运行路径。

## 相关文档

- [`docs/DEVELOPER_QUICKSTART.md`](https://github.com/Lidozs55/BioMed-QAgent/blob/dev/docs/DEVELOPER_QUICKSTART.md)：全仓开发流程。
- [`docs/architecture/agent-frontend.md`](https://github.com/Lidozs55/BioMed-QAgent/blob/dev/docs/architecture/agent-frontend.md)：事件投影与前端架构。
- [`docs/ARCHITECTURE.md`](https://github.com/Lidozs55/BioMed-QAgent/blob/dev/docs/ARCHITECTURE.md)：系统边界。
- [`docs/TODO.md`](https://github.com/Lidozs55/BioMed-QAgent/blob/dev/docs/TODO.md)：当前开放工作。
