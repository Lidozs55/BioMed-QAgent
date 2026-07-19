import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import {
  ArrowUpIcon,
  CaretDownIcon,
  FileIcon,
  ImageIcon,
  MagnifyingGlassIcon,
  PlusIcon,
} from "@phosphor-icons/react";

import { DatabaseSelector } from "@/components/DatabaseSelector";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { ModelInfo } from "@/hooks/useSettings";

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
  /** Available models from settings (non-empty = API key configured) */
  models?: ModelInfo[];
  /** Whether the user has configured an API key */
  hasApiKey?: boolean;
  /** Opens the settings panel */
  onOpenSettings?: () => void;
  /** Called when the user selects a different model */
  onModelChange?: (modelId: string) => void;
  /** Currently selected model ID */
  selectedModelId?: string;
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
  models = [],
  hasApiKey = false,
  onOpenSettings,
  onModelChange,
  selectedModelId,
}: AgentComposerProps) {
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!modelDropdownOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setModelDropdownOpen(false);
        setModelSearch("");
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [modelDropdownOpen]);

  // Sort: qwen models first, then by id
  const sortedModels = useMemo(() => {
    if (!models.length) return [];
    return [...models].sort((a, b) => {
      const aQwen = a.id.toLowerCase().startsWith("qwen") || a.name.toLowerCase().startsWith("qwen") ? 1 : 0;
      const bQwen = b.id.toLowerCase().startsWith("qwen") || b.name.toLowerCase().startsWith("qwen") ? 1 : 0;
      if (aQwen !== bQwen) return bQwen - aQwen;
      if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
      return a.id.localeCompare(b.id);
    });
  }, [models]);

  const selectedModelDisplay = useMemo(
    () => models.find((m) => m.id === selectedModelId),
    [models, selectedModelId],
  );

  const filteredModels = useMemo(
    () => sortedModels.filter(
      (m) => m.name.toLowerCase().includes(modelSearch.toLowerCase()) ||
        m.id.toLowerCase().includes(modelSearch.toLowerCase()),
    ),
    [sortedModels, modelSearch],
  );

  const handleOpenSettings = useCallback(() => onOpenSettings?.(), [onOpenSettings]);

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
          <div className="relative" ref={dropdownRef}>
            {hasApiKey && sortedModels.length > 0 ? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="max-w-40 gap-1 px-2 text-muted-foreground"
                  onClick={() => {
                    setModelDropdownOpen((v) => !v);
                    setModelSearch("");
                  }}
                  disabled={disabled}
                  aria-label={selectedModelDisplay ? `当前模型 ${selectedModelDisplay.name}，点击切换` : "点击选择模型"}
                >
                  <span className="truncate max-w-28">{selectedModelDisplay?.name ?? selectedModelId ?? "选择模型"}</span>
                  <CaretDownIcon aria-hidden="true" className="size-3.5 shrink-0" />
                </Button>
                {modelDropdownOpen && (
                  <div className="absolute right-0 bottom-full mb-1 z-50 w-64 overflow-hidden rounded-lg border bg-popover shadow-md">
                    <div className="p-2 pb-1">
                      <div className="relative">
                        <MagnifyingGlassIcon className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          placeholder="搜索模型..."
                          value={modelSearch}
                          onChange={(e) => setModelSearch(e.target.value)}
                          className="h-8 pl-7 text-sm"
                          autoFocus
                        />
                      </div>
                    </div>
                    <div className="max-h-72 overflow-y-auto [scrollbar-width:thin]">
                      <div className="p-1 pt-0">
                        {filteredModels.length === 0 ? (
                          <div className="px-3 py-4 text-center text-sm text-muted-foreground">
                            {modelSearch ? "没有匹配的模型" : "暂无可用模型"}
                          </div>
                        ) : (
                          <>
                            {filteredModels.map((model) => (
                              <button
                                key={model.id}
                                type="button"
                                className={cn(
                                  "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-accent transition-colors",
                                  model.id === selectedModelId && "bg-accent font-medium",
                                )}
                                onClick={() => {
                                  onModelChange?.(model.id);
                                  setModelDropdownOpen(false);
                                  setModelSearch("");
                                }}
                              >
                                <span className="flex-1 truncate">{model.name}</span>
                                {model.recommended && (
                                  <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">推荐</span>
                                )}
                                {model.capabilities.image && (
                                  <span className="shrink-0 rounded bg-emerald-100 px-1 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">图</span>
                                )}
                              </button>
                            ))}
                            <div className="border-t mt-1 px-3 py-2 text-center text-[11px] text-muted-foreground">
                              管理模型请前往
                              <button
                                type="button"
                                className="ml-1 text-primary underline-offset-2 hover:underline"
                                onClick={() => {
                                  setModelDropdownOpen(false);
                                  handleOpenSettings();
                                }}
                              >
                                设置
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="max-w-40 gap-1 px-2 text-muted-foreground"
                onClick={handleOpenSettings}
                disabled={disabled}
                aria-label="未配置 API Key，点击前往设置"
              >
                <span className="truncate">无可用模型</span>
                <CaretDownIcon aria-hidden="true" className="size-3.5 shrink-0" />
              </Button>
            )}
          </div>
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
