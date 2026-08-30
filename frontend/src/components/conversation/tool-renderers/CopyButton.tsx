import { CheckIcon, CopyIcon } from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import { useCopy } from "@/hooks/useCopy";
import { cn } from "@/lib/utils";

interface CopyButtonProps {
  text: string;
  label?: string;
  className?: string;
}

/** 图标式复制按钮,复制成功后短暂切换为对勾。 */
export function CopyButton({ text, label = "复制", className }: CopyButtonProps) {
  const { copied, copy } = useCopy();
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      className={cn(
        "bg-background/80 text-muted-foreground hover:text-foreground",
        className,
      )}
      onClick={() => copy(text)}
    >
      {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
    </Button>
  );
}
