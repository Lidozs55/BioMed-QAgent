# 前端项目AGENT守则

必须使用 shadcn 的 skills 进行工作，检索相关组件，而不要自己重复造轮子

正常开发从仓库根目录执行 `pnpm dev`，由 TypeScript Host 内嵌 Vite 并提供唯一公开端口。
`frontend/` 内的 `pnpm dev` 仅用于 `pnpm dev:frontend-standalone` 诊断，不是正式启动入口。
