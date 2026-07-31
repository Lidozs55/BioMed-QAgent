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
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

export interface ContextUsageBarProps {
  /** Tokens currently used in the conversation. */
  usedTokens: number;
  /** Total context window capacity in tokens. */
  totalTokens: number;
  /** Whether a compaction is currently in progress. */
  compacting?: boolean;
  /** Called when the user requests context compaction. */
  onCompact?: () => void;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function formatTokens(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)}M`;
  if (n >= 1_024) return `${(n / 1_024).toFixed(1)}K`;
  return String(n);
}

function usageColor(pct: number): string {
  if (pct >= 90) return "bg-destructive";
  if (pct >= 70) return "bg-amber-500";
  return "bg-emerald-500";
}

function usageTextColor(pct: number): string {
  if (pct >= 90) return "text-destructive";
  if (pct >= 70) return "text-amber-600";
  return "text-emerald-600";
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function ContextUsageBar({
  usedTokens,
  totalTokens,
  compacting = false,
  onCompact,
}: ContextUsageBarProps) {
  const [open, setOpen] = useState(false);

  const pct = totalTokens > 0 ? Math.min(100, Math.round((usedTokens / totalTokens) * 100)) : 0;

  const handleCompact = useCallback(() => {
    onCompact?.();
    setOpen(false);
  }, [onCompact]);

  // Hide if no meaningful data
  if (totalTokens <= 0) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="group flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 transition-colors hover:bg-muted/60"
          >
            <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className={cn("h-full rounded-full transition-all duration-500", usageColor(pct))}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span
              className={cn(
                "min-w-[3.5rem] text-right font-mono text-[10px] tabular-nums transition-colors",
                usageTextColor(pct),
              )}
            >
              {pct}%
            </span>
          </button>
        }
      />
      <PopoverContent align="center" className="w-56">
        <PopoverHeader>
          <PopoverTitle>上下文窗口使用</PopoverTitle>
          <PopoverDescription>
            {formatTokens(usedTokens)} / {formatTokens(totalTokens)} tokens
          </PopoverDescription>
        </PopoverHeader>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">已使用</span>
            <span className={cn("font-mono font-medium tabular-nums", usageTextColor(pct))}>
              {pct}%
            </span>
          </div>
          <div className="relative h-2 overflow-hidden rounded-full bg-muted">
            <div
              className={cn("h-full rounded-full", usageColor(pct))}
              style={{ width: `${pct}%` }}
            />
          </div>
          {onCompact && (
            <Button
              size="sm"
              variant="outline"
              className="mt-1 w-full gap-1.5"
              disabled={compacting || pct < 10}
              onClick={handleCompact}
            >
              {compacting ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <ArrowsInIcon data-icon="inline-start" />
              )}
              {compacting ? "压缩中..." : "压缩上下文"}
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
