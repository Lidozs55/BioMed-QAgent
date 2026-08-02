# Skill 工具调用 Marker 化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `find_skill` 与 `invoke_skill` 两个工具调用的前端表现从 Bubble 改为与思维链（ReasoningBlock）样式一致的 Marker：`find_skill` 折叠态显示 `检索技能中`，展开显示关键词与结果摘要（前两个技能名 + 总数）；`invoke_skill` 折叠态显示 `调用 <技能名>`，展开直接平铺显示输入与输出（不再二级折叠）。

**Architecture:** 新增 `SkillMarker` 组件（`frontend/src/components/conversation/SkillMarker.tsx`）；渲染路由用**注册表**（`frontend/src/components/conversation/toolRenderers.tsx` 导出 `toolRenderers: Readonly<Record<string, ToolRenderer>>`，`find_skill`/`invoke_skill` 映射到 `SkillMarker`），`ToolCallStep` 查表命中则渲染自定义渲染器、未命中走原 Bubble——后续新工具只需向注册表加条目，无需改 `ToolCallStep` 主体。`find_skill` 的输出是 JSON（`{"status","skills":[{name,display_name,...}]}`），组件内解析前两个 `display_name`（fallback `name`）并显示总数，解析失败时兜底显示原始输出。`toolLabels.ts` 增加两条映射，让 ChatPanel 顶部活跃工具状态行也显示正确文案。无后端改动。

**Tech Stack:** React 19 + TypeScript + Tailwind CSS v4 + @phosphor-icons/react（icon 库）；vitest + @testing-library/react（测试）。

## Global Constraints

- **仅前端改动**：不触碰 `backend/`、`AGENTS.md`。
- **分支**：从 `main` 开 `feat/skill-marker-ui`，merge 用 `git merge --no-ff`，提交信息用 conventional commit（`feat:` 前缀）。
- **质量门**：`pnpm lint`（`--max-warnings 0`，0 警告）、`pnpm tsc --noEmit`、`pnpm test`（vitest 全量）、`pnpm build` 全部通过后才可合并。
- **Icon**：仅使用已验证存在的 @phosphor-icons/react 导出：`MagnifyingGlassIcon`（find_skill）、`CodeIcon`（invoke_skill）、`CaretDownIcon`、`SpinnerGapIcon`（均已在 `node_modules` 中确认存在）。
- **Marker 样式**：与 `ReasoningBlock.tsx` 一致 —— 外层 `my-1` 容器 + `<button>`（`flex items-center gap-2 text-sm text-muted-foreground`）+ icon + 文案 + `CaretDownIcon`（展开时 `rotate-180`），展开面板 `mt-1 border-l-2 border-muted pl-6 text-sm`。**不使用** `ui/marker.tsx`（那是系统状态行组件，样式与思维链不同）。
- **统一规定（用户要求）**：两个新 Marker 展开后**直接平铺显示输入与输出**，不再有当前 ToolCallStep 的 `<details>/<summary>` 二级折叠。展开面板内不得出现 `<details>` 元素。
- **范围外**：`find_skill`/`invoke_skill` 之外的工具（PubMed/GEO 等）继续走现有 ToolCallStep Bubble 渲染，不改。
- **运行目录**：所有前端命令从 `frontend/` 运行。

---

### Task 1: SkillMarker 组件 + 单元测试

**Files:**
- Create: `frontend/src/components/conversation/SkillMarker.tsx`
- Test: `frontend/src/components/conversation/__tests__/SkillMarker.test.tsx`

**Interfaces:**
- Consumes: `ToolCallItem`（`frontend/src/runtime/types.ts`）—— `kind:"tool_call"`、`toolName: string`、`arguments: Record<string, unknown> | null`、`status: "running"|"completed"|"error"`、`output: string | null`。
- Produces:
  - `export interface FindSkillSummary { total: number; names: string[] }`
  - `export function parseFindSkillOutput(output: string | null): FindSkillSummary | null` —— 解析 find_skill 的 JSON 输出；`null`/空/解析失败返回 `null`；`skills` 非数组返回 `null`；`names` 取 `display_name ?? name`（跳过空串）。
  - `export function SkillMarker({ item }: { item: ToolCallItem })` —— Task 2 使用。

- [ ] **Step 1: 创建分支**

```bash
cd D:/coding/BioMed-QAgent
git checkout main && git pull --ff-only origin main
git checkout -b feat/skill-marker-ui
```
Expected: 分支存在，工作区干净。

- [ ] **Step 2: 写失败测试**

创建 `frontend/src/components/conversation/__tests__/SkillMarker.test.tsx`：

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  parseFindSkillOutput,
  SkillMarker,
} from "@/components/conversation/SkillMarker";
import type { ToolCallItem } from "@/runtime/types";

const TIMESTAMP = "2026-07-20T00:00:00Z";

function makeSkillCall(overrides: Partial<ToolCallItem>): ToolCallItem {
  return {
    itemId: "skill-call-1",
    runId: "run-1",
    sequence: 1,
    createdAt: TIMESTAMP,
    kind: "tool_call",
    toolCallId: "call-1",
    toolName: "find_skill",
    arguments: { text: "网页截图" },
    status: "completed",
    output: null,
    completedSequence: 2,
    ...overrides,
  };
}

describe("parseFindSkillOutput", () => {
  it("extracts names and total from find_skill output", () => {
    const summary = parseFindSkillOutput(
      JSON.stringify({
        status: "ok",
        skills: [
          { name: "web_visual_capture", display_name: "网页视觉采集" },
          { name: "parse_excel", display_name: "Excel 解析" },
          { name: "parse_pdf", display_name: "PDF 解析" },
        ],
      }),
    );
    expect(summary).toEqual({
      total: 3,
      names: ["网页视觉采集", "Excel 解析", "PDF 解析"],
    });
  });

  it("falls back to name when display_name is missing", () => {
    const summary = parseFindSkillOutput(
      JSON.stringify({ status: "ok", skills: [{ name: "parse_excel" }] }),
    );
    expect(summary?.names).toEqual(["parse_excel"]);
  });

  it("returns null for null, empty, or unparseable output", () => {
    expect(parseFindSkillOutput(null)).toBeNull();
    expect(parseFindSkillOutput("")).toBeNull();
    expect(parseFindSkillOutput('{"status":"ok","skills":[')).toBeNull();
    expect(parseFindSkillOutput("not json")).toBeNull();
  });
});

describe("SkillMarker", () => {
  it("shows '检索技能中...' with spinner while find_skill is running", () => {
    render(
      <SkillMarker item={makeSkillCall({ status: "running", output: null })} />,
    );
    expect(screen.getByText("检索技能中...")).toBeInTheDocument();
    expect(document.querySelector(".animate-spin")).not.toBeNull();
    expect(screen.queryByText("结果摘要")).not.toBeInTheDocument();
  });

  it("shows '检索技能' when find_skill completes and expands to keywords + summary", () => {
    render(
      <SkillMarker
        item={makeSkillCall({
          output: JSON.stringify({
            status: "ok",
            skills: [
              { name: "web_visual_capture", display_name: "网页视觉采集" },
              { name: "parse_excel", display_name: "Excel 解析" },
              { name: "parse_pdf", display_name: "PDF 解析" },
            ],
          }),
        })}
      />,
    );
    expect(screen.getByText("检索技能")).toBeInTheDocument();
    expect(screen.queryByText("调用 find_skill")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("关键词")).toBeInTheDocument();
    expect(screen.getByText("网页截图")).toBeInTheDocument();
    expect(screen.getByText("结果摘要")).toBeInTheDocument();
    expect(
      screen.getByText("共 3 个技能：网页视觉采集、Excel 解析 …"),
    ).toBeInTheDocument();
  });

  it("shows only the first two names plus the total", () => {
    const skills = Array.from({ length: 5 }, (_, i) => ({
      name: `skill_${i}`,
    }));
    render(
      <SkillMarker
        item={makeSkillCall({
          output: JSON.stringify({ status: "ok", skills }),
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("共 5 个技能：skill_0、skill_1 …")).toBeInTheDocument();
  });

  it("shows '未找到匹配技能' when find_skill found nothing", () => {
    render(
      <SkillMarker
        item={makeSkillCall({
          output: JSON.stringify({ status: "ok", skills: [] }),
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("未找到匹配技能")).toBeInTheDocument();
  });

  it("falls back to the raw output when find_skill output is truncated", () => {
    render(
      <SkillMarker
        item={makeSkillCall({ output: '{"status":"ok","skills":[' })}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText('{"status":"ok","skills":[')).toBeInTheDocument();
  });

  it("shows '无输出' when find_skill has no output", () => {
    render(<SkillMarker item={makeSkillCall({})} />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("无输出")).toBeInTheDocument();
  });

  it("labels invoke_skill as '调用 <skill>' and expands flat to input + output", () => {
    render(
      <SkillMarker
        item={makeSkillCall({
          toolName: "invoke_skill",
          arguments: {
            skill: "web_visual_capture",
            operation: "capture_web_page",
            arguments: { url: "https://example.com" },
          },
          output: '{"status":"ok","result":"done"}',
        })}
      />,
    );
    expect(screen.getByText("调用 web_visual_capture")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("输入参数")).toBeInTheDocument();
    expect(screen.getByText(/"operation": "capture_web_page"/)).toBeInTheDocument();
    expect(screen.getByText("输出")).toBeInTheDocument();
    expect(
      screen.getByText('{"status":"ok","result":"done"}'),
    ).toBeInTheDocument();
    // 统一规定：展开后输入输出直接平铺，不再嵌套折叠
    expect(document.querySelectorAll("details")).toHaveLength(0);
  });

  it("shows spinner while invoke_skill is running", () => {
    render(
      <SkillMarker
        item={makeSkillCall({
          toolName: "invoke_skill",
          arguments: { skill: "web_visual_capture" },
          status: "running",
        })}
      />,
    );
    expect(screen.getByText("调用 web_visual_capture")).toBeInTheDocument();
    expect(document.querySelector(".animate-spin")).not.toBeNull();
  });

  it("marks invoke_skill error output and omits 输入参数 when arguments is null", () => {
    render(
      <SkillMarker
        item={makeSkillCall({
          toolName: "invoke_skill",
          arguments: null,
          status: "error",
          output: "boom",
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("输出（错误）")).toBeInTheDocument();
    expect(screen.queryByText("输入参数")).not.toBeInTheDocument();
    expect(screen.getByText("调用 技能")).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

```bash
cd D:/coding/BioMed-QAgent/frontend
pnpm vitest run src/components/conversation/__tests__/SkillMarker.test.tsx 2>&1 | tail -8
```
Expected: FAIL —— `Cannot find module '@/components/conversation/SkillMarker'`（模块不存在）。

- [ ] **Step 4: 实现 SkillMarker**

创建 `frontend/src/components/conversation/SkillMarker.tsx`：

```tsx
import { useState } from "react";
import {
  CaretDownIcon,
  CodeIcon,
  MagnifyingGlassIcon,
  SpinnerGapIcon,
} from "@phosphor-icons/react";

import { cn } from "@/lib/utils";
import type { ToolCallItem } from "@/runtime/types";

export interface FindSkillSummary {
  total: number;
  names: string[];
}

/** Parse find_skill's JSON output; null when missing/unparseable. */
export function parseFindSkillOutput(
  output: string | null,
): FindSkillSummary | null {
  if (!output) return null;
  try {
    const parsed = JSON.parse(output) as {
      skills?: Array<{ name?: string; display_name?: string }>;
    };
    if (!Array.isArray(parsed.skills)) return null;
    const names = parsed.skills
      .map((skill) => skill.display_name ?? skill.name ?? "")
      .filter((name) => name.length > 0);
    return { total: names.length, names };
  } catch {
    return null;
  }
}

interface SkillMarkerProps {
  item: ToolCallItem;
}

export function SkillMarker({ item }: SkillMarkerProps) {
  const [expanded, setExpanded] = useState(false);
  const isFindSkill = item.toolName === "find_skill";
  const isRunning = item.status === "running";
  const isError = item.status === "error";
  const skillName =
    typeof item.arguments?.skill === "string"
      ? item.arguments.skill
      : "技能";
  const label = isFindSkill
    ? isRunning
      ? "检索技能中..."
      : "检索技能"
    : `调用 ${skillName}`;
  const summary = isFindSkill ? parseFindSkillOutput(item.output) : null;
  const keywords =
    [item.arguments?.text, item.arguments?.source, item.arguments?.category].find(
      (value) => typeof value === "string" && value !== "",
    ) ?? null;

  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        className="flex items-center gap-2 text-sm text-muted-foreground"
      >
        {isRunning ? (
          <SpinnerGapIcon className="size-4 animate-spin" aria-hidden="true" />
        ) : isFindSkill ? (
          <MagnifyingGlassIcon className="size-4" aria-hidden="true" />
        ) : (
          <CodeIcon className="size-4" aria-hidden="true" />
        )}
        <span>{label}</span>
        <CaretDownIcon
          className={cn(
            "size-3.5 transition-transform",
            expanded && "rotate-180",
          )}
          aria-hidden="true"
        />
      </button>
      {expanded && (
        <div className="mt-1 space-y-2 border-l-2 border-muted pl-6 text-sm">
          {isFindSkill ? (
            <>
              {keywords !== null && (
                <div>
                  <div className="text-muted-foreground">关键词</div>
                  <pre className="mt-1 overflow-x-auto rounded bg-muted/50 p-2 text-xs">
                    {keywords}
                  </pre>
                </div>
              )}
              <div>
                <div className="text-muted-foreground">结果摘要</div>
                <pre className="mt-1 overflow-x-auto rounded bg-muted/50 p-2 text-xs">
                  {summary === null
                    ? (item.output ?? "无输出")
                    : summary.total === 0
                      ? "未找到匹配技能"
                      : `共 ${summary.total} 个技能：${summary.names
                          .slice(0, 2)
                          .join("、")}${summary.total > 2 ? " …" : ""}`}
                </pre>
              </div>
            </>
          ) : (
            <>
              {item.arguments !== null && (
                <div>
                  <div className="text-muted-foreground">输入参数</div>
                  <pre className="mt-1 overflow-x-auto rounded bg-muted/50 p-2 text-xs">
                    {JSON.stringify(item.arguments, null, 2)}
                  </pre>
                </div>
              )}
              {item.output !== null && (
                <div>
                  <div className="text-muted-foreground">
                    输出{isError ? "（错误）" : ""}
                  </div>
                  <pre
                    className={cn(
                      "mt-1 overflow-x-auto rounded p-2 text-xs",
                      isError ? "bg-destructive/10" : "bg-muted/50",
                    )}
                  >
                    {item.output}
                  </pre>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd D:/coding/BioMed-QAgent/frontend
pnpm vitest run src/components/conversation/__tests__/SkillMarker.test.tsx 2>&1 | tail -5
```
Expected: PASS —— `Tests  11 passed (11)`。

- [ ] **Step 6: 提交**

```bash
cd D:/coding/BioMed-QAgent
git add frontend/src/components/conversation/SkillMarker.tsx \
  frontend/src/components/conversation/__tests__/SkillMarker.test.tsx
git commit -m "feat: add SkillMarker for find_skill/invoke_skill tool calls"
```

---

### Task 2: ToolCallStep 分流 + 状态行文案

**Files:**
- Create: `frontend/src/components/conversation/toolRenderers.tsx`
- Modify: `frontend/src/components/conversation/ToolCallStep.tsx:19-20`
- Modify: `frontend/src/components/conversation/toolLabels.ts:53`（TOOL_LABEL_MAP 末尾、`};` 前）
- Test: `frontend/src/components/conversation/__tests__/ToolCallStep.test.tsx`（末尾追加）
- Test: `frontend/src/components/conversation/__tests__/toolLabels.test.ts`（末尾追加）

**Interfaces:**
- Consumes: Task 1 的 `SkillMarker`。
- Produces:
  - `export type ToolRenderer = (item: ToolCallItem) => ReactElement`
  - `export const toolRenderers: Readonly<Record<string, ToolRenderer>>` —— 工具名 → 自定义渲染器注册表；未注册的工具由 `ToolCallStep` 走默认 Bubble。后续新工具只需向注册表加条目，无需改 `ToolCallStep` 主体。
- `ToolCallStep` 查表路由：注册表命中返回自定义渲染器，未命中走原 Bubble。


- [ ] **Step 1: 写失败测试**

在 `frontend/src/components/conversation/__tests__/ToolCallStep.test.tsx` 的 `describe("ToolCallStep", ...)` 内、最后一个 `});` 之前追加：

```tsx
  it("renders find_skill via SkillMarker instead of '调用 find_skill'", () => {
    render(
      <ToolCallStep
        item={makeToolCall({
          toolName: "find_skill",
          arguments: { text: "网页截图" },
          output: null,
        })}
      />,
    );
    expect(screen.getByText("检索技能")).toBeInTheDocument();
    expect(screen.queryByText(/调用 find_skill/)).not.toBeInTheDocument();
  });

  it("renders invoke_skill via SkillMarker with the skill name", () => {
    render(
      <ToolCallStep
        item={makeToolCall({
          toolName: "invoke_skill",
          arguments: { skill: "web_visual_capture" },
          output: null,
        })}
      />,
    );
    expect(screen.getByText("调用 web_visual_capture")).toBeInTheDocument();
  });

在 `ToolCallStep.test.tsx` 顶部 import 区加 `import { toolRenderers } from "@/components/conversation/toolRenderers";`，并在同一 `describe` 内追加注册表结构测试：

```tsx
  it("registers custom renderers for find_skill and invoke_skill", () => {
    expect(Object.keys(toolRenderers).sort()).toEqual([
      "find_skill",
      "invoke_skill",
    ]);
  });
```

在 `frontend/src/components/conversation/__tests__/toolLabels.test.ts` 的 `describe("formatToolCall", ...)` 内、最后一个 `});` 之前追加：

```ts
  it("maps find_skill", () => {
    const label = formatToolCall("find_skill", { text: "网页截图" });
    expect(label).toEqual({ verb: "检索", target: "技能" });
  });

  it("maps invoke_skill with skill name", () => {
    const label = formatToolCall("invoke_skill", {
      skill: "web_visual_capture",
      operation: "capture_web_page",
    });
    expect(label).toEqual({
      verb: "调用",
      target: "web_visual_capture",
    });
  });

  it("maps invoke_skill without args", () => {
    const label = formatToolCall("invoke_skill", null);
    expect(label).toEqual({ verb: "调用", target: "技能" });
  });
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd D:/coding/BioMed-QAgent/frontend
pnpm vitest run src/components/conversation/__tests__/ToolCallStep.test.tsx \
  src/components/conversation/__tests__/toolLabels.test.ts 2>&1 | tail -8
```
Expected: FAIL —— ToolCallStep 新用例显示 `调用 find_skill`（当前 fallback 文案）而非 `检索技能`；toolLabels 新用例 `toHaveLength`/`toEqual` 断言失败（无对应映射，`invoke_skill` 走 fallback `调用 invoke_skill`）。

- [ ] **Step 3: 实现注册表路由 + 映射**

创建 `frontend/src/components/conversation/toolRenderers.tsx`：

```tsx
import type { ComponentType } from "react";

import type { ToolCallItem } from "@/runtime/types";
import { SkillMarker } from "./SkillMarker";

export type ToolRenderer = ComponentType<{ item: ToolCallItem }>;

/** 工具名 → 自定义渲染器。未注册的工具由 ToolCallStep 走默认 Bubble。 */
export const toolRenderers: Readonly<Record<string, ToolRenderer>> = {
  find_skill: SkillMarker,
  invoke_skill: SkillMarker,
};
```

`frontend/src/components/conversation/ToolCallStep.tsx`：在 import 区加 `import { toolRenderers } from "./toolRenderers";`，并把 `export function ToolCallStep({ item }: ToolCallStepProps) {` 后的第一行改为：

```tsx
  const Renderer = toolRenderers[item.toolName];
  if (Renderer !== undefined) {
    return <Renderer item={item} />;
  }
```

`frontend/src/components/conversation/toolLabels.ts`：在 `TOOL_LABEL_MAP` 对象内、`};` 之前追加两条：

```ts
  find_skill: () => ({ verb: "检索", target: "技能" }),
  invoke_skill: (args) => ({
    verb: "调用",
    target: args?.skill ? String(args.skill) : "技能",
  }),
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd D:/coding/BioMed-QAgent/frontend
pnpm vitest run src/components/conversation/__tests__/ToolCallStep.test.tsx \
  src/components/conversation/__tests__/toolLabels.test.ts \
  src/components/conversation/__tests__/SkillMarker.test.tsx 2>&1 | tail -5
```
Expected: PASS —— `Tests  N passed (N)`，无失败。

- [ ] **Step 5: 提交**

```bash
cd D:/coding/BioMed-QAgent
git add frontend/src/components/conversation/ToolCallStep.tsx \
  frontend/src/components/conversation/toolLabels.ts \
  frontend/src/components/conversation/toolRenderers.tsx \
  frontend/src/components/conversation/__tests__/ToolCallStep.test.tsx \
  frontend/src/components/conversation/__tests__/toolLabels.test.ts
git commit -m "feat: route find_skill/invoke_skill through tool renderer registry"
```

---

### Task 3: 质量门 + 合并

**Files:** 无新增。

- [ ] **Step 1: 前端质量门全量验证**

```bash
cd D:/coding/BioMed-QAgent/frontend
pnpm lint && pnpm tsc --noEmit && pnpm test && pnpm build
```
Expected: `lint` 0 错误；`tsc` 无输出（成功）；`pnpm test` 全量 `Test Files  N passed` / `Tests  N passed`；`build` 以 `✓ built in ...` 结束（chunk 大小警告是既有问题，非本次引入，可忽略）。

- [ ] **Step 2: 合并到 main 并推送**

```bash
cd D:/coding/BioMed-QAgent
git checkout main
git merge --no-ff feat/skill-marker-ui -m "feat: skill tool-call markers (find_skill/invoke_skill)"
git push origin main
git branch -d feat/skill-marker-ui
```
Expected: merge 无冲突；push 成功；本地分支删除。

- [ ] **Step 3: 发布 [DONE]（若连接 Commonly）**

在 pod `6a520e34f4baa9b280bba195` 发消息，格式：

```
[DONE] find_skill/invoke_skill 前端表现改为思维链样式 Marker 并合并 main。
- find_skill：折叠态「检索技能中…/检索技能」，展开显示关键词 + 结果摘要（前两个技能名 + 总数），输出 JSON 解析失败时兜底显示原文。
- invoke_skill：折叠态「调用 <技能名>」，展开平铺显示输入参数 + 输出，无二级折叠。
- 新增 SkillMarker 组件 + 11 个单测；ToolCallStep 按 toolName 分流；toolLabels 增加两条映射（ChatPanel 状态行同步）。
- 质量门：pnpm lint/tsc/test/build 全绿。分支 feat/skill-marker-ui 已合并清理。
```

---

## Self-Review

**1. Spec coverage:**
- find_skill → Marker、`检索技能中`、展开显示关键词+结果摘要（前两个技能名+总数）：Task 1 ✓
- invoke_skill → Marker、`调用 <技能名>`、展开显示输入输出详情：Task 1 ✓
- 两个 Marker 与思维链样式一致、icon 不同（MagnifyingGlass/Code）：Task 1 Step 4 ✓
- 统一规定（无二级展开、点击直接显示输入输出、无 `<details>`）：Task 1 测试 `document.querySelectorAll("details")` 断言 + 实现 ✓
- 不直接显示 `调用 find_skill`：Task 1 测试 + Task 2 分流 ✓

**2. Placeholder scan:** 无 TBD/TODO；每个代码步骤含完整代码；命令含预期输出。

**3. Type consistency:**
- `parseFindSkillOutput` / `FindSkillSummary` / `SkillMarker` 在 Task 1 定义、Task 2 引用，签名一致 ✓
- `ToolCallItem` 字段（`toolName`/`arguments`/`status`/`output`）与实际类型一致 ✓
- icon 名（`MagnifyingGlassIcon`/`CodeIcon`/`CaretDownIcon`/`SpinnerGapIcon`）已在 node_modules 验证存在 ✓
