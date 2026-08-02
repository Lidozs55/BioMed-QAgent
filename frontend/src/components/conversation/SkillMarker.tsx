import { useState } from "react";
import {
  CaretDownIcon,
  CodeIcon,
  MagnifyingGlassIcon,
  SpinnerGapIcon,
} from "@phosphor-icons/react";

import { cn } from "@/lib/utils";
import type { ToolCallItem } from "@/runtime/types";
import { parseFindSkillOutput } from "./skillOutput";

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
      (value): value is string =>
        typeof value === "string" && value !== "",
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
