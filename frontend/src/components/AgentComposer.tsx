import { useState } from "react";
import {
  ArrowUpIcon,
  CaretDownIcon,
  FileIcon,
  ImageIcon,
  PlusIcon,
} from "@phosphor-icons/react";

import { DatabaseSelector } from "@/components/DatabaseSelector";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const MODELS = [
  { id: "default", label: "默认模型" },
  { id: "reasoning", label: "推理模型" },
  { id: "fast", label: "快速模型" },
] as const;

interface AgentComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder: string;
  ariaLabel: string;
  sendAriaLabel?: string;
  disabled?: boolean;
  sendDisabled?: boolean;
  pending?: boolean;
  showDataSources?: boolean;
  onDataSourceChange?: () => void;
  compact?: boolean;
  className?: string;
}

export function AgentComposer({
  value,
  onChange,
  onSubmit,
  onKeyDown,
  placeholder,
  ariaLabel,
  sendAriaLabel = "发送",
  disabled = false,
  sendDisabled = false,
  pending = false,
  showDataSources = false,
  onDataSourceChange,
  compact = false,
  className,
}: AgentComposerProps) {
  const [model, setModel] = useState("default");
  const modelLabel = MODELS.find((item) => item.id === model)?.label ?? "默认模型";

  return (
    <div
      data-slot="agent-composer"
      className={cn(
        "rounded-2xl border bg-card shadow-sm transition-shadow focus-within:ring-3 focus-within:ring-ring/20",
        className,
      )}
    >
      <Textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={ariaLabel}
        disabled={disabled}
        className={cn(
          "resize-none border-0 bg-transparent px-4 py-3 shadow-none focus-visible:ring-0 dark:bg-transparent",
          compact ? "min-h-18" : "min-h-28",
        )}
      />
      <div className="flex min-w-0 items-center gap-1.5 px-2 pb-2">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="添加附件"
                disabled={disabled}
              />
            }
          >
            <PlusIcon aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top">
            <DropdownMenuLabel>添加附件</DropdownMenuLabel>
            <DropdownMenuItem disabled>
              <ImageIcon aria-hidden="true" />
              上传图片（即将支持）
            </DropdownMenuItem>
            <DropdownMenuItem disabled>
              <FileIcon aria-hidden="true" />
              上传文件（即将支持）
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {showDataSources && (
          <DatabaseSelector
            onToggle={() => onDataSourceChange?.()}
            disabled={disabled || pending}
          />
        )}

        <div className="ml-auto flex min-w-0 items-center gap-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="max-w-32 gap-1 px-2 text-muted-foreground"
                  aria-label={`切换主模型，当前${modelLabel}`}
                  disabled={disabled}
                />
              }
            >
              <span className="truncate">{modelLabel}</span>
              <CaretDownIcon aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top">
              <DropdownMenuLabel>主模型</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuRadioGroup value={model} onValueChange={setModel}>
                {MODELS.map((item) => (
                  <DropdownMenuRadioItem key={item.id} value={item.id}>
                    {item.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            type="button"
            size="icon-sm"
            className="rounded-full"
            onClick={onSubmit}
            disabled={disabled || sendDisabled || pending}
            aria-label={pending ? "提交中" : sendAriaLabel}
          >
            {pending ? (
              <Spinner aria-hidden="true" />
            ) : (
              <ArrowUpIcon weight="bold" aria-hidden="true" />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}