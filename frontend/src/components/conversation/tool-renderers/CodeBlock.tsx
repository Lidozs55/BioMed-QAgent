import { useState } from "react";
import { BracketsCurlyIcon } from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

import { CopyButton } from "./CopyButton";

interface CodeBlockProps {
  text: string;
  /**
   * 原始(未解包)输出;提供时在复制旁显示「原始输出」切换按钮。
   */
  rawText?: string;
  /** error 输出使用 destructive 底色。 */
  tone?: "default" | "error";
  className?: string;
  maxHeightClassName?: string;
}

/** 等宽文本块:ScrollArea 限高滚动 + 原始输出切换 + 复制。 */
export function CodeBlock({
  text,
  rawText,
  tone = "default",
  className,
  maxHeightClassName = "max-h-72",
}: CodeBlockProps) {
  const [showRaw, setShowRaw] = useState(false);
  const hasRawToggle = rawText !== undefined && rawText !== text;
  const content = showRaw && rawText !== undefined ? rawText : text;
  return (
    <div className={cn("relative", className)}>
      <div className="absolute top-1.5 right-1.5 z-10 flex gap-1">
        {hasRawToggle && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="原始输出"
            aria-pressed={showRaw}
            title="原始输出"
            className={cn(
              "bg-background/80 text-muted-foreground hover:text-foreground",
              showRaw && "bg-muted text-foreground",
            )}
            onClick={() => setShowRaw((prev) => !prev)}
          >
            <BracketsCurlyIcon aria-hidden="true" />
          </Button>
        )}
        <CopyButton text={content} />
      </div>
      <ScrollArea
        className={cn(
          "rounded-md",
          maxHeightClassName,
          tone === "error" ? "bg-destructive/10" : "bg-muted/50",
        )}
      >
        <pre className="px-3 py-2 font-mono text-xs leading-5 break-words whitespace-pre-wrap text-foreground">
          {content}
        </pre>
      </ScrollArea>
    </div>
  );
}
