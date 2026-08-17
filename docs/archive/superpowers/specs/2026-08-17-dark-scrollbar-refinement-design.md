# 暗色模式滚动条统一优化设计

## 目标

统一聊天消息区和普通滚动面板的滚动条视觉，降低暗色模式下亮色滚动条的突兀感，同时不改变自动跟随、滚动锚点、跳转到最新或滚动区域布局行为。

## 现状与组件选择

项目已经使用 shadcn 的 `MessageScroller` 和 `ScrollArea`。shadcn registry 没有独立的全局 `Scrollbar` 组件；`ScrollArea` 的 `ScrollBar` 是其组合部件。聊天区不能替换为普通 `ScrollArea`，因为 `MessageScroller` 还负责流式跟随与消息锚点。

## 设计

- 在 `frontend/src/styles/global.css` 增加统一的滚动条语义样式：暗色模式使用低对比度 thumb 和透明 track，悬停/滚动时提高可见度；同时提供 Firefox 的 `scrollbar-color` 与 `scrollbar-width`。
- 在 `MessageScrollerViewport` 复用统一样式类，保留现有自动滚动时透明 thumb/track 行为。
- 在 shadcn `ScrollArea` 的 `ScrollBar` 中复用同一组语义样式类，覆盖 thumb 与 track 的状态；普通业务页面不需要逐个修改。
- 不添加依赖、不改变公开组件 API、不修改业务页面布局。

## 验证

- 前端组件测试锁定聊天 viewport 和普通 ScrollArea 使用统一样式契约。
- 运行前端测试、lint、typecheck 和 build。
- 在已有浏览器页面检查暗色聊天区滚动条是否更低调，且滚动仍可操作。
