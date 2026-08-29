import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

import { CopyButton } from "./CopyButton";

interface CodeBlockProps {
  text: string;
  /** error 输出使用 destructive 底色。 */
  tone?: "default" | "error";
  className?: string;
  maxHeightClassName?: string;
}

/** 等宽文本块:ScrollArea 限高滚动 + 右上角复制。 */
export function CodeBlock({
  text,
  tone = "default",
  className,
  maxHeightClassName = "max-h-72",
}: CodeBlockProps) {
  return (
    <div className={cn("relative", className)}>
      <CopyButton text={text} className="absolute top-1.5 right-1.5 z-10" />
      <ScrollArea
        className={cn(
          "rounded-md",
          maxHeightClassName,
          tone === "error" ? "bg-destructive/10" : "bg-muted/50",
        )}
      >
        <pre className="px-3 py-2 font-mono text-xs leading-5 break-words whitespace-pre-wrap text-foreground">
          {text}
        </pre>
      </ScrollArea>
    </div>
  );
}
