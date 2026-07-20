import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpIcon,
  CaretDownIcon,
  FileIcon,
  ImageIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  XIcon,
} from "@phosphor-icons/react";

import { DatabaseSelector } from "@/components/DatabaseSelector";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { ModelInfo } from "@/hooks/useSettings";

export const MAX_IMPORT_FILES = 10;
export const MAX_IMPORT_FILE_BYTES = 500 * 1024 * 1024;
export const MAX_IMPORT_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

const LEGACY_MODELS = [
  { id: "qwen-plus", label: "Qwen Plus" },
  { id: "qwen-max", label: "Qwen Max" },
  { id: "qwen-turbo", label: "Qwen Turbo" },
  { id: "qwq-plus", label: "QWQ Plus" },
];

function sanitizeUploadFilename(name: string): string {
  const parts = name.split(/[\\/]/);
  const baseName = parts[parts.length - 1] ?? "";
  return baseName.replace(/[^A-Za-z0-9._-]/g, "_");
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

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
  /**
   * 文件上传回调。若提供，则启用"上传文件"菜单项；用户附加文件后，
   * 发送按钮触发此回调而非 `onSubmit`，进入 IMPORT 任务流程。
   */
  onSubmitFiles?: (files: File[], note: string) => Promise<void>;
  onAttachmentError?: (message: string) => void;
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
  onSubmitFiles,
  onAttachmentError,
  compact = false,
  className,
  models,
  hasApiKey = false,
  onOpenSettings,
  onModelChange,
  selectedModelId,
}: AgentComposerProps) {
  // Attachment state (legacy, always applicable)
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [submittingFiles, setSubmittingFiles] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Model selector state (new settings integration)
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Legacy model selector (backward compat when models prop is absent)
  const [model, setModel] = useState("default");

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

  const modelsList = useMemo(() => models ?? [], [models]);

  const sortedModels = useMemo(() => {
    if (modelsList.length === 0) return [];
    return [...modelsList].sort((a, b) => {
      const aQwen = a.id.toLowerCase().startsWith("qwen") || a.name.toLowerCase().startsWith("qwen") ? 1 : 0;
      const bQwen = b.id.toLowerCase().startsWith("qwen") || b.name.toLowerCase().startsWith("qwen") ? 1 : 0;
      if (aQwen !== bQwen) return bQwen - aQwen;
      if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
      return a.id.localeCompare(b.id);
    });
  }, [modelsList]);

  const selectedModelDisplay = useMemo(
    () => modelsList.find((m) => m.id === selectedModelId),
    [modelsList, selectedModelId],
  );

  const filteredModels = useMemo(
    () => sortedModels.filter(
      (m) => m.name.toLowerCase().includes(modelSearch.toLowerCase()) ||
        m.id.toLowerCase().includes(modelSearch.toLowerCase()),
    ),
    [sortedModels, modelSearch],
  );

  const handleOpenSettings = useCallback(() => onOpenSettings?.(), [onOpenSettings]);

  const hasFiles = pendingFiles.length > 0;
  const attachmentBusy = disabled || pending || submittingFiles;
  const canSubmitFiles =
    hasFiles &&
    onSubmitFiles !== undefined &&
    !attachmentBusy;

  const handleFilePick = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (attachmentBusy) {
      event.target.value = "";
      return;
    }
    const picked = event.target.files;
    if (picked === null) return;
    const incoming = Array.from(picked);
    if (incoming.length === 0) return;
    setPendingFiles((current) => {
      if (current.length + incoming.length > MAX_IMPORT_FILES) {
        onAttachmentError?.(`最多上传 ${MAX_IMPORT_FILES} 个文件`);
        return current;
      }
      const seen = new Set(current.map((file) => sanitizeUploadFilename(file.name)));
      let totalBytes = current.reduce((total, file) => total + file.size, 0);
      for (const file of incoming) {
        if (file.size > MAX_IMPORT_FILE_BYTES) {
          onAttachmentError?.("单个文件不能超过 500 MiB");
          return current;
        }
        totalBytes += file.size;
        if (totalBytes > MAX_IMPORT_TOTAL_BYTES) {
          onAttachmentError?.("单次上传总大小不能超过 2 GiB");
          return current;
        }
        const sanitizedName = sanitizeUploadFilename(file.name);
        if (!sanitizedName || seen.has(sanitizedName)) {
          onAttachmentError?.("文件名重复");
          return current;
        }
        seen.add(sanitizedName);
      }
      return [...current, ...incoming];
    });
    // 清空 input.value 让同一文件可再次选择
    event.target.value = "";
  };

  const handleRemoveFile = (name: string) => {
    setPendingFiles((current) => current.filter((file) => file.name !== name));
  };

  const handleSubmit = async (): Promise<void> => {
    if (hasFiles && onSubmitFiles !== undefined) {
      if (!canSubmitFiles) return;
      setSubmittingFiles(true);
      try {
        await onSubmitFiles(pendingFiles, value);
        setPendingFiles([]);
      } catch {
        // The parent owns the user-visible import error and leaves the draft intact.
      } finally {
        setSubmittingFiles(false);
      }
      return;
    }
    onSubmit();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 当已附加文件时，Enter 直接触发 IMPORT 提交；否则交给父组件处理。
    if (
      hasFiles &&
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void handleSubmit();
      return;
    }
    onKeyDown(event);
  };

  const sendDisabledFinal = pending || (hasFiles ? !canSubmitFiles : sendDisabled);

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
        onKeyDown={handleKeyDown}
        placeholder={hasFiles ? "可选：为导入文件补充说明..." : placeholder}
        aria-label={ariaLabel}
        disabled={disabled}
        className={cn(
          "resize-none border-0 bg-transparent px-4 py-3 shadow-none focus-visible:ring-0 dark:bg-transparent",
          compact ? "min-h-18" : "min-h-28",
        )}
      />
      {hasFiles && (
        <AttachmentGroup className="px-3 pb-1.5">
          {pendingFiles.map((file) => (
            <Attachment
              key={file.name}
              size="xs"
              state={submittingFiles || pending ? "uploading" : "idle"}
            >
              <AttachmentMedia variant="icon">
                <FileIcon aria-hidden="true" weight="regular" />
              </AttachmentMedia>
              <AttachmentContent>
                <AttachmentTitle>{file.name}</AttachmentTitle>
                <AttachmentDescription>{formatFileSize(file.size)}</AttachmentDescription>
              </AttachmentContent>
              <AttachmentActions>
                <AttachmentAction
                  type="button"
                  onClick={() => handleRemoveFile(file.name)}
                  aria-label={`移除 ${file.name}`}
                  disabled={submittingFiles || pending}
                >
                  <XIcon data-icon="inline-end" aria-hidden="true" weight="bold" />
                </AttachmentAction>
              </AttachmentActions>
            </Attachment>
          ))}
        </AttachmentGroup>
      )}
      <div className="flex min-w-0 items-center gap-1.5 px-2 pb-2">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="添加附件"
                disabled={attachmentBusy}
              />
            }
          >
            <PlusIcon aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top">
            <DropdownMenuGroup>
              <DropdownMenuLabel>添加附件</DropdownMenuLabel>
              <DropdownMenuItem disabled>
                <ImageIcon aria-hidden="true" />
                上传图片（即将支持）
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={onSubmitFiles === undefined || attachmentBusy}
                onSelect={() => fileInputRef.current?.click()}
              >
                <FileIcon aria-hidden="true" />
                上传文件到本地缓存
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFilePick}
          aria-hidden="true"
          tabIndex={-1}
        />

        {showDataSources && !hasFiles && (
          <DatabaseSelector
            onToggle={() => onDataSourceChange?.()}
            disabled={disabled || pending}
          />
        )}

        <div className="ml-auto flex min-w-0 items-center gap-1.5">
          <div className="relative" ref={dropdownRef}>
            {models !== undefined ? (
              // New searchable model selector (settings integration)
              hasApiKey && sortedModels.length > 0 ? (
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
                              {filteredModels.map((m) => (
                                <button
                                  key={m.id}
                                  type="button"
                                  className={cn(
                                    "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-accent transition-colors",
                                    m.id === selectedModelId && "bg-accent font-medium",
                                  )}
                                  onClick={() => {
                                    onModelChange?.(m.id);
                                    setModelDropdownOpen(false);
                                    setModelSearch("");
                                  }}
                                >
                                  <span className="flex-1 truncate">{m.name}</span>
                                  {m.recommended && (
                                    <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">推荐</span>
                                  )}
                                  {m.capabilities.image && (
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
              )
            ) : (
              // Legacy model selector (backward compat)
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="max-w-40 gap-1 px-2 text-muted-foreground"
                      disabled={disabled}
                      aria-label="切换主模型"
                    >
                      <span className="truncate">{LEGACY_MODELS.find((item) => item.id === model)?.label ?? "默认模型"}</span>
                      <CaretDownIcon aria-hidden="true" />
                    </Button>
                  }
                />
                <DropdownMenuContent align="end" side="top">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>主模型</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuRadioGroup value={model} onValueChange={setModel}>
                      {LEGACY_MODELS.map((item) => (
                        <DropdownMenuRadioItem key={item.id} value={item.id}>
                          {item.label}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
          <Button
            type="button"
            size="icon-sm"
            className="rounded-full"
            onClick={() => void handleSubmit()}
            disabled={sendDisabledFinal}
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
