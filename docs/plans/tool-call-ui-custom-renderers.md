# 计划:工具调用 UI 定制渲染器(JSON 自动格式化 + read/write/edit/bash 专用视图)

> 状态:设计定稿,待实施。分支 `feat/tool-call-renderers`,worktree
> `D:/coding/BioMed-QAgent-toolui`。
> 本文自足,不依赖会话上下文;实施者只需读本文件 + 下列现状代码。

## 1. 背景与现状

- 所有工具调用统一渲染于
  `frontend/src/components/conversation/ToolCallStep.tsx`:ghost bubble + 状态图标
  + `toolLabels.ts` 的中文「动词 目标」标签 + 展开后的原始 JSON 参数
  (`JSON.stringify(args, null, 2)` 直接塞 `<pre>`)与原始文本输出。
- Pi 会话在 `server/src/agent/pi-adapter.ts` 以 `noTools: "builtin"` /
  `"all"` 双模式运行;内置编码工具 `read` / `write` / `edit` / `bash` /
  `grep` / `find` / `ls` 可用,权限层(`fs.read` / `fs.write` / `fs.edit` /
  `exec`)已按能力拦截。这些「系统操作」目前与领域工具共用同一模板:
  - 参数显示为原始 JSON,人读成本高;
  - `edit` 的 oldText/newText 本质是 diff,却以两个 JSON 字符串字段呈现;
  - `bash` 的命令混在 JSON 里,输出没有终端语境。
- 事件契约(`tool_started` / `tool_completed` → `ToolCallItem`)与 reducer
  数据流**不变**,本次只动渲染层。`ToolCallItem`:
  `frontend/src/runtime/types.ts:236`(toolName / arguments / status /
  output / progress)。

### 内置工具参数结构(源自
`@earendil-works/pi-coding-agent/dist/core/tools/*.js`)

| 工具   | 参数                              | 输出特征                     |
| ------ | --------------------------------- | ---------------------------- |
| read   | `path`, `offset?`, `limit?`       | 文件文本(可能带截断提示) |
| write  | `path`, `content`                 | 写入确认摘要                 |
| edit   | `path`, `oldText`, `newText`      | 编辑确认摘要                 |
| bash   | `command`, `timeout?`             | stdout/stderr 文本           |
| grep   | `pattern`, `path?`                | 匹配行文本                   |
| find   | `pattern`, `path?`                | 路径列表                     |
| ls     | `path?`                           | 目录列表                     |

## 2. 目标 / 非目标

目标:

1. **通用工具**(领域检索/下载/分析等)保持现有 ghost bubble 形态;参数与
   输出 JSON 自动格式化(pretty + 语法高亮 + 复制 + 限高滚动)。
2. **专用渲染器**:`read` / `write` / `edit`(读写改)与 `bash`(执行命令)
   四类各得其所:收起态即可读出「对哪个文件 / 执行了什么」,展开态给出代码
   预览 / 新增视图 / diff / 终端块。
3. `grep` / `find` / `ls` 补 `toolLabels.ts` 中文标签(仍走通用渲染)。

非目标:

- 不改 runtime reducer、事件契约、权限卡片(`PermissionStep`)、下载进度
  (`DownloadProgress`)、动态家族发布卡片(`FamilyHostStatusCard`)。
- 不新增任何依赖(JSON 高亮手写 tokenizer,不用 shiki/prism);图标沿用
  `@phosphor-icons/react`(components.json `iconLibrary: phosphor`)。
- 不做 read 输出的图片预览、不做虚拟滚动;`max-h` + 滚动即可。
- 不展示执行耗时(事件里没有 duration 数据)。

## 3. 组件结构

```
frontend/src/components/conversation/
  ToolCallStep.tsx              # 改造为按 toolName 分发的 dispatcher,
                                # 保留 download / dynamicFamily 现有逻辑
  toolLabels.ts                 # 新增 read/write/edit/bash/grep/find/ls 兜底标签
  tool-renderers/
    ToolHeader.tsx              # 通用折叠头(状态图标+工具图标+标题+Badge+caret)
    CodeBlock.tsx               # 等宽文本块 + 复制按钮 + max-h 滚动
    JsonBlock.tsx               # JSON 自动格式化 + 高亮 + 复制(CodeBlock 之上)
    DiffView.tsx                # 行级 diff 渲染(deleted/added 行;write 复用 added-only)
    FileReadTool.tsx            # read 专用
    FileWriteTool.tsx           # write 专用
    FileEditTool.tsx            # edit 专用
    BashTool.tsx                # bash 专用
  __tests__/
    (新增 tool-renderers 各自的 *.test.tsx)
frontend/src/lib/
  jsonHighlight.ts              # JSON tokenizer → 带 className 的 span 片段
frontend/src/hooks/
  useCopy.ts                    # 复制 + 1.5s 成功反馈(clipboard API,失败降级 execCommand 不做,直接吞错并保持图标)
```

## 4. 分发规则(ToolCallStep)

```
toolName ∈ {read, write, edit, bash}  → 对应专用渲染器(outline 卡片)
其余                                  → GenericToolCall(现 ghost bubble + JsonBlock)
```

- `isDownload`(progress.kind === "downloaded_bytes")与
  `dynamicFamilyOutput` 的现有旁路逻辑**原样保留**,先于分发判断。
- 未知未来工具自动落入 GenericToolCall,行为与现状兼容。
- 现有展开/收起状态由各渲染器自管;ToolHeader 提供统一的
  `button[aria-expanded]` 行为。

## 5. 样式设计(shadcn 规则约束下)

遵循 shadcn Critical Rules:语义 token、无裸色值、无手动 `dark:`、`gap-*`
组合、`size-*`、`truncate`、`cn()`、Badge 代替自绘 span、Button 图标走
`data-icon`。项目 `style: base-nova`、Tailwind v4(`frontend/src/styles/global.css`
已注册 `--color-success`,diff「新增」行直接用 `success` 语义类)。

### 5.0 通用容器

- 专用渲染器:`<Message align="start"><MessageContent className="w-full">`
  内 `<Bubble variant="outline" className="w-full max-w-full overflow-hidden rounded-lg">`
  —— outline 自带 `border-border + bg-background`,给系统操作以卡片边界;
  注意 bubble 默认 `max-w-[80%]`,须显式 `max-w-full`。
- 通用工具:维持现有 `variant="ghost"`(`ghost` 自带 `max-w-full`)。

### 5.1 ToolHeader(专用渲染器共用折叠头)

```
[状态图标] [工具图标] 标题(font-mono truncate)   [Badge 元信息…] [⌄]
```

- 状态图标沿用现状:`running`→`Spinner`,`error`→`WarningCircleIcon`
  (destructive),否则 `CheckCircleIcon`,均 `size-4 shrink-0`。
- 工具图标(phosphor,`size-4 text-muted-foreground`):
  read=`FileTextIcon`,write=`FilePlusIcon`,edit=`FileDiffIcon`,
  bash=`TerminalIcon`。
- 标题 `font-mono text-sm truncate`;右侧 Badge 用
  `variant="secondary"` + `font-mono text-[11px]`;行整体为
  `button aria-expanded`,点击切换展开,`CaretDownIcon` 旋转 180°。

### 5.2 read — FileReadTool

收起态:

```
[✓] 📄 src/lib/utils.ts                        L1–L80  ⌄
```

- 标题 = `path`(若以 cwd 绝对路径呈现,仅做显示层截断,不裁路径语义);
  Badge = 行范围:有 `offset`/`limit` 时 `L{offset+1}–L{offset+limit}`,
  否则完成后按输出行数 `L1–L{n}`(运行中不显示)。
- 展开态:`<CodeBlock text={output} maxClassName="max-h-72" />` ——
  `font-mono text-xs leading-5`,`bg-muted/50 rounded-md p-3`,
  `overflow-auto`,右上角复制按钮(`Button variant="ghost" size="icon-xs"`,
  `CopyIcon`↔`CheckIcon` 反馈)。输出末尾 Pi 的截断提示文本自然可见,不特殊
  解析。

### 5.3 write — FileWriteTool

收起态:

```
[✓] ➕ docs/plans/xxx.md                       +42  ⌄
```

- Badge `+{content 行数}`,内层 span `text-success`。
- 展开态:`<DiffView added={content.split("\n")} />` added-only 模式 ——
  每行 `border-l-2 border-l-success bg-success/10 pl-2`,行首 `+` 前缀
  `text-success/80 select-none`;外层同 CodeBlock 的限高滚动。

### 5.4 edit — FileEditTool

收起态:

```
[✓] 📝 server/src/runtime/task-repository.ts     +3 −1  ⌄
```

- Badge 一个,内两个 span:`+{newText 行数}`(text-success)、
  `−{oldText 行数}`(text-destructive)。
- 展开态 DiffView(参数只有 oldText/newText,无上下文行,无行号基线):

```
│− const previous = state;          │  border-l-destructive bg-destructive/10
│+ const previous = state ?? {};    │  border-l-success bg-success/10
```

- 删行 `border-l-2 border-l-destructive bg-destructive/10`,增行同理用
  success;行前缀 `−` / `+` 各配 `text-destructive/80` / `text-success/80`
  且 `select-none`(复制时只复制代码)。行间不加分隔,保留原始缩进
  (`whitespace-pre-wrap`),`max-h-72 overflow-auto font-mono text-xs`。

### 5.5 bash — BashTool

收起态:

```
[✓] ▮ $ pnpm --filter @biomed/server test            ⌄
```

- 标题 = `command` 首行(`split("\n")[0]`,`font-mono truncate`);多行命令
  收起时仅显首行。无时长 Badge。
- 展开态「终端块」(两种主题下都是反转卡片,纯语义 token):

```
┌──────────────────────────────────────────┐
│ $ pnpm --filter @biomed/server test      │  bg-card-foreground text-background
│ stdout / stderr 原文…                    │  rounded-md p-3 font-mono text-xs
└──────────────────────────────────────────┘
```

- 容器 `bg-card-foreground text-background`(明→黑底白字,暗→白底黑字,
  自动反转,合规且省一个终端配色方案);`$` 提示符
  `<span className="select-none opacity-60">$ </span>`。
- `status === "error"` 时输出段叠 `bg-destructive/20` 并在终端块顶部保留
  原状态图标语义。输出限高 `max-h-72 overflow-auto`。

### 5.6 GenericToolCall(通用工具)

- 头部、下载条、FamilyHostStatusCard 全部不变。
- 「输入参数」:`<pre>{JSON.stringify(...)}</pre>` →
  `<JsonBlock value={item.arguments} />`。
- 「输出」:`JSON.parse(output)` 成功且为 object/array → `JsonBlock`;
  否则 → `CodeBlock`(纯文本 + 复制)。错误输出容器保留
  `bg-destructive/10` 现状。

### 5.7 JsonBlock + jsonHighlight

- `JSON.stringify(value, null, 2)`;
  `text-xs font-mono max-h-64 overflow-auto rounded-md bg-muted/50 p-2`;
  复制按钮同 CodeBlock(绝对定位于右上,`bg-background/80` 提高可读性)。
- 高亮(jsonHighlight.ts,单遍正则 tokenizer,返回 span 数组,由 JsonBlock
  渲染;>100_000 字符跳过高亮直接纯文本,性能护栏):
  - 键(冒号尾字符串)→ `text-primary font-medium`
  - 字符串 → `text-success`
  - 数字 / `true|false|null` → `text-muted-foreground`
  - 其余标点默认前景
  - 全部语义 token,明暗主题自适应。
- 正则:`/"(\\.|[^"\\])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g`。

## 6. 测试计划(vitest + testing-library,随实现同步写)

| 文件 | 覆盖 |
| --- | --- |
| `lib/jsonHighlight.test.ts` | 键/字符串/数字/布尔/null 分类;转义与 unicode;超长护栏 |
| `tool-renderers/JsonBlock` | 对象格式化、复制按钮、高亮类名 |
| `tool-renderers/FileReadTool` | path 展示、L 范围 Badge、CodeBlock 渲染 |
| `tool-renderers/FileWriteTool` | +N Badge、added 行渲染 |
| `tool-renderers/FileEditTool` | +n/−m Badge、删/增行着色类 |
| `tool-renderers/BashTool` | 命令首行、$ 前缀、error 态 |
| `__tests__/ToolCallStep.test.tsx` | 分发:read→FileReadTool、bash→BashTool、`search_pubmed`→通用形态;download/动态家族旁路不回归 |

现有 `ToolCallStep.test.tsx` 与 `toolLabels.test.ts` 全量保持通过。

## 7. 实施顺序

1. `lib/jsonHighlight.ts` + 单测;
2. `tool-renderers/` 共享件 ToolHeader / CodeBlock / JsonBlock / DiffView +
   `hooks/useCopy.ts` + 单测;
3. 四个专用渲染器 + 单测;
4. ToolCallStep 改 dispatcher + 分发单测;
5. `toolLabels.ts` 补 7 个内置工具兜底标签 + 更新标签单测;
6. 门禁:`pnpm --filter @biomed/frontend test && pnpm --filter @biomed/frontend lint && pnpm --filter @biomed/frontend tsc`。

## 8. 验收标准

- read/write/edit/bash 在收起态即可读出目标文件 / 命令;展开态分别是代码
  预览、全绿新增、红删绿增 diff、终端块。
- 通用工具参数/输出 JSON 自动 pretty + 高亮 + 一键复制。
- 明暗主题零裸色值;shadcn 规则(语义 token、gap、size、truncate、Badge)
  全部满足。
- 现有前端测试零回归;新组件测试齐。
