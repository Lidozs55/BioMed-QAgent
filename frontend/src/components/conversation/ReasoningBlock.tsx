import { useEffect, useState } from "react";
import { BrainIcon, CaretDownIcon, SpinnerGapIcon } from "@phosphor-icons/react";

import { cn } from "@/lib/utils";
import type { ReasoningItem } from "@/runtime/types";

interface ReasoningBlockProps {
  item: ReasoningItem;
}

const AUTO_COLLAPSE_DELAY_MS = 500;

export function ReasoningBlock({ item }: ReasoningBlockProps) {
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const [graceExpanded, setGraceExpanded] = useState<boolean>(item.isStreaming);
  const [prevIsStreaming, setPrevIsStreaming] = useState<boolean>(item.isStreaming);

  // Adjust graceExpanded when the isStreaming prop changes (render-phase update,
  // per https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes).
  if (item.isStreaming !== prevIsStreaming) {
    setPrevIsStreaming(item.isStreaming);
    if (item.isStreaming) {
      setGraceExpanded(true);
    }
    // When isStreaming transitions from true to false, keep graceExpanded=true
    // and let the effect below schedule the auto-collapse timer.
  }

  useEffect(() => {
    if (userToggled !== null) return;
    if (item.isStreaming) return;
    if (!graceExpanded) return;
    const timer = window.setTimeout(() => {
      setGraceExpanded(false);
    }, AUTO_COLLAPSE_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [item.isStreaming, userToggled, graceExpanded]);

  const expanded = userToggled ?? graceExpanded;

  const handleToggle = () => {
    setUserToggled(!expanded);
  };

  return (
    <div className="my-1">
      <button
        type="button"
        onClick={handleToggle}
        aria-expanded={expanded}
        className="flex items-center gap-2 text-sm text-muted-foreground"
      >
        {item.isStreaming ? (
          <SpinnerGapIcon className="size-4 animate-spin" aria-hidden="true" />
        ) : (
          <BrainIcon className="size-4" aria-hidden="true" />
        )}
        <span>{item.isStreaming ? "思考中..." : "思维链"}</span>
        <CaretDownIcon
          className={cn("size-3.5 transition-transform", expanded && "rotate-180")}
          aria-hidden="true"
        />
      </button>
      {expanded && (
        <div className="mt-1 whitespace-pre-wrap border-l-2 border-muted pl-6 text-sm text-muted-foreground">
          {item.content}
          {item.isStreaming && (
            <span className="ml-0.5 inline-block animate-pulse" aria-hidden="true">
              ▋
            </span>
          )}
        </div>
      )}
    </div>
  );
}
