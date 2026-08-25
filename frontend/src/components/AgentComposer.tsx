import { useCallback, useMemo, useRef, useState } from "react";
import {
  ArrowUpIcon,
  CaretDownIcon,
  FileIcon,
  ImageIcon,
  PlusIcon,
  SquareIcon,
  XIcon,
} from "@phosphor-icons/react";

import { ContextUsageInline } from "@/components/ContextUsageInline";
import { DatabaseSelector } from "@/components/DatabaseSelector";
import { ArtifactFab } from "@/components/ArtifactFab";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
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
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "@/components/ui/combobox";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { formatSize } from "@/lib/fileUtils";
import { cn } from "@/lib/utils";
import type { ModelInfo } from "@/hooks/useAPI";

export const MAX_IMPORT_FILES = 10;
export const MAX_IMPORT_FILE_BYTES = 500 * 1024 * 1024;
export const MAX_IMPORT_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

function sanitizeUploadFilename(name: string): string {
  const parts = name.split(/[\\/]/);
  const baseName = parts[parts.length - 1] ?? "";
  return baseName.replace(/[^A-Za-z0-9._-]/g, "_");
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
  /** 任务运行中且可取消时传入：输入为空时按钮变为停止方块并调用 onStop。 */
  canStop?: boolean;
  /** 停止按钮点击回调（canStop 且输入为空时生效）。 */
  onStop?: () => void;
  /** 停止请求进行中：按钮显示加载态并禁用。 */
  stopping?: boolean;
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
  /** Context window capacity in tokens (for inline usage indicator) */
  contextWindow?: number;
  /** Tokens currently used in the conversation (runtime value when available). */
  contextTokensUsed?: number;
  /** Source of the context usage value */
  contextTokensSource?: "runtime" | "ui_estimate";
  /** Whether a context compaction request is currently in progress. */
  compacting?: boolean;
  /** Called when the user requests context compaction */
  onCompact?: () => void;
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
  canStop = false,
  onStop,
  stopping = false,
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
  contextWindow,
  contextTokensUsed,
  contextTokensSource,
  compacting = false,
  onCompact,
}: AgentComposerProps) {
  // Attachment state (legacy, always applicable)
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [submittingFiles, setSubmittingFiles] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  // Model selector state (settings integration)
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");

  const sortedModels = useMemo(() => {
    const choices = models ?? [];
    if (choices.length === 0) return [];
    return [...choices].sort((a, b) => {
      if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [models]);

  const selectedModelDisplay = useMemo(
    () => sortedModels.find((m) => m.id === selectedModelId),
    [sortedModels, selectedModelId],
  );
  const selectedModelLabel = selectedModelDisplay?.name ??
    (
      selectedModelId !== "" &&
      hasApiKey &&
      sortedModels.length === 0
        ? selectedModelId
        : "选择模型"
    );

  // Case-insensitive search over both name and id, consumed by the Combobox
  // root's internal filtering (the input lives inside the popup).
  const modelFilter = useCallback(
    (m: ModelInfo, query: string) => {
      const q = query.trim().toLowerCase();
      if (q === "") return true;
      return (
        m.name.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q)
      );
    },
    [],
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
  // 运行中且输入为空时，发送键切换为“停止生成”空心方块。
  const stopActive =
    canStop && !hasFiles && !disabled && !pending && value.trim() === "";
  const stopInFlight = stopActive && stopping;
  const submitButtonDisabled =
    stopInFlight || (stopActive ? false : sendDisabledFinal);
  const submitButtonAriaLabel = stopInFlight
    ? "正在取消…"
    : stopActive
      ? "停止生成"
      : pending
        ? "提交中"
        : sendAriaLabel;

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
          "resize-none border-0 bg-transparent px-4 py-3 shadow-none focus-visible:ring-0",
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
                <AttachmentDescription>{formatSize(file.size)}</AttachmentDescription>
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
      <div className="flex min-w-0 items-center gap-1.5 px-2 py-2">
        <ArtifactFab />
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
              <DropdownMenuItem
                disabled={onSubmitFiles === undefined || attachmentBusy}
                onClick={() => imageInputRef.current?.click()}
              >
                <ImageIcon aria-hidden="true" />
                上传图片
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={onSubmitFiles === undefined || attachmentBusy}
                onClick={() => fileInputRef.current?.click()}
              >
                <FileIcon aria-hidden="true" />
                上传文件（从本地缓存）
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {contextWindow !== undefined && contextWindow > 0 && (
          <ContextUsageInline
            usedTokens={contextTokensUsed ?? 0}
            totalTokens={contextWindow}
            source={contextTokensSource}
            compacting={compacting}
            onCompact={onCompact}
          />
        )}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          accept=".pdf,.xlsx,.xls,.csv,.tsv,.json,.xml,.txt,.pdb,.zip,.md"
          onChange={handleFilePick}
          aria-hidden="true"
          tabIndex={-1}
        />
        <input
          ref={imageInputRef}
          type="file"
          multiple
          className="hidden"
          accept="image/*"
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
          <div className="relative">
            {hasApiKey ? (
              // Searchable model selector against the real models endpoint
              // (offline fallback list when the endpoint is unreachable).
              <Combobox
                items={sortedModels}
                filter={modelFilter}
                itemToStringLabel={(m) => m.name}
                value={selectedModelDisplay ?? null}
                onValueChange={(next) => {
                  if (next !== null) onModelChange?.(next.id);
                }}
                open={modelDropdownOpen}
                onOpenChange={(next) => {
                  setModelDropdownOpen(next);
                  if (next) setModelSearch("");
                }}
                inputValue={modelSearch}
                onInputValueChange={setModelSearch}
                disabled={disabled}
              >
                <ComboboxTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="max-w-40 gap-1 px-2 text-muted-foreground"
                      aria-label={
                        selectedModelDisplay
                          ? `当前模型 ${selectedModelDisplay.name}，点击切换`
                          : "点击选择模型"
                      }
                    />
                  }
                >
                  <span className="truncate max-w-28">
                    {selectedModelLabel}
                  </span>
                </ComboboxTrigger>
                <ComboboxContent
                  align="end"
                  side="top"
                  sideOffset={4}
                  className="w-64"
                >
                  <ComboboxInput
                    placeholder="搜索模型..."
                    showTrigger={false}
                  />
                  <ComboboxEmpty>
                    {modelSearch ? "没有匹配的模型" : "暂无可用模型"}
                  </ComboboxEmpty>
                  <ComboboxList>
                    {(m: ModelInfo) => (
                      <ComboboxItem
                        key={m.id}
                        value={m}
                        className="flex-col items-start gap-0.5 py-1.5"
                      >
                        <span className="flex w-full min-w-0 items-center gap-2">
                          <span className="min-w-0 flex-1 truncate">
                            {m.name}
                          </span>
                          {m.recommended && (
                            <Badge className="bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                              推荐
                            </Badge>
                          )}
                          {m.capabilities?.image && (
                            <Badge className="bg-success/10 text-success">
                              图
                            </Badge>
                          )}
                        </span>
                        <span className="block w-full truncate text-xs text-muted-foreground">
                          {m.description}
                        </span>
                      </ComboboxItem>
                    )}
                  </ComboboxList>
                  <div className="border-t px-3 py-2 text-center text-[11px] text-muted-foreground">
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
                </ComboboxContent>
              </Combobox>
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
            onClick={() => {
              if (stopActive && onStop !== undefined) {
                onStop();
              } else {
                void handleSubmit();
              }
            }}
            disabled={submitButtonDisabled}
            aria-label={submitButtonAriaLabel}
          >
            {stopInFlight || pending ? (
              <Spinner aria-hidden="true" />
            ) : stopActive ? (
              <SquareIcon weight="bold" aria-hidden="true" />
            ) : (
              <ArrowUpIcon weight="bold" aria-hidden="true" />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
