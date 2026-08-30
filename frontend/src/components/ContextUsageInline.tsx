import { useCallback, useState } from "react";
import { ArrowsInIcon } from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverDescription,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { formatTokenCount } from "@/lib/tokenFormat";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

export interface ContextUsageInlineProps {
  /** Tokens currently used (runtime value when available). */
  usedTokens: number;
  /** Total context window capacity in tokens. */
  totalTokens: number;
  /** Whether compaction is in progress. */
  compacting?: boolean;
  /** Called when the user requests context compaction. */
  onCompact?: () => void;
  /** Whether the value came from Pi runtime usage or the UI fallback. */
  source?: "runtime" | "ui_estimate";
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function barColor(pct: number): string {
  if (pct >= 90) return "bg-destructive";
  if (pct >= 70) return "bg-warning";
  return "bg-primary";
}

function textColor(pct: number): string {
  if (pct >= 90) return "text-destructive";
  if (pct >= 70) return "text-warning";
  return "text-muted-foreground";
}

/* ------------------------------------------------------------------ */
/*  Component — compact inline indicator for the composer toolbar      */
/* ------------------------------------------------------------------ */

export function ContextUsageInline({
  usedTokens,
  totalTokens,
  compacting = false,
  onCompact,
  source = "ui_estimate",
}: ContextUsageInlineProps) {
  const [open, setOpen] = useState(false);

  const pct = totalTokens > 0 ? Math.max(0, Math.round((usedTokens / totalTokens) * 100)) : 0;
  const barPct = Math.min(100, pct);

  const handleCompact = useCallback(() => {
    onCompact?.();
  }, [onCompact]);

  // Hide if no meaningful capacity data
  if (totalTokens <= 0) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 transition-colors hover:bg-muted/60"
            aria-label={`上下文窗口已使用 ${pct}%${source === "ui_estimate" ? "（估算）" : "（运行时）"}`}
          >
            {/* Mini progress bar */}
            <div className="relative h-1 w-10 overflow-hidden rounded-full bg-muted">
              <div
                className={cn("h-full rounded-full transition-all duration-300", barColor(pct))}
                style={{ width: `${barPct}%` }}
              />
            </div>
            <span className={cn("font-mono text-[9px] tabular-nums", textColor(pct))}>
              {pct}%
            </span>
          </button>
        }
      />
      <PopoverContent align="start" side="top" className="w-80">
        <PopoverHeader>
          <div className="flex items-center justify-between">
            <PopoverTitle className="text-sm">上下文窗口</PopoverTitle>
            <span className={cn("font-mono text-sm font-semibold tabular-nums", textColor(pct))}>
              {pct}%
            </span>
          </div>
          <PopoverDescription className="text-xs leading-relaxed">
            压缩会摘要早期内容以释放上下文空间，需等待片刻。
          </PopoverDescription>
        </PopoverHeader>
        <div className="flex flex-col gap-2.5">
          {/* Progress bar */}
          <div className="relative h-2 overflow-hidden rounded-full bg-muted">
            <div
              className={cn("h-full rounded-full transition-all duration-300", barColor(pct))}
              style={{ width: `${barPct}%` }}
            />
          </div>
          {/* Token count detail */}
          <p className="text-[11px] text-muted-foreground">
            {formatTokenCount(usedTokens)} / {formatTokenCount(totalTokens)} tokens · {source === "runtime" ? "运行时" : "估算"}
          </p>
          {/* Compact button */}
          <Button
            size="sm"
            variant="outline"
            className="h-8 w-full gap-1.5 text-xs"
            disabled={compacting}
            onClick={handleCompact}
          >
            {compacting ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <ArrowsInIcon data-icon="inline-start" />
            )}
            {compacting ? "压缩中..." : "压缩上下文"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
