import { useMemo } from "react";

import { ScrollArea } from "@/components/ui/scroll-area";
import { highlightJson } from "@/lib/jsonHighlight";
import { cn } from "@/lib/utils";

import { CopyButton } from "./CopyButton";

interface JsonBlockProps {
  value: unknown;
  className?: string;
  maxHeightClassName?: string;
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** JSON 自动格式化块:pretty-print + 语义 token 高亮 + 复制。 */
export function JsonBlock({
  value,
  className,
  maxHeightClassName = "max-h-64",
}: JsonBlockProps) {
  const text = useMemo(() => safeStringify(value), [value]);
  const segments = useMemo(() => highlightJson(text), [text]);
  return (
    <div className={cn("relative", className)}>
      <CopyButton text={text} className="absolute top-1.5 right-1.5 z-10" />
      <ScrollArea className={cn("rounded-md bg-muted/50", maxHeightClassName)}>
        <pre
          data-testid="json-block"
          className="px-3 py-2 font-mono text-xs leading-5 break-words whitespace-pre-wrap text-foreground"
        >
          {segments.map((segment, index) =>
            segment.className ? (
              <span key={index} className={segment.className}>
                {segment.text}
              </span>
            ) : (
              segment.text
            ),
          )}
        </pre>
      </ScrollArea>
    </div>
  );
}
