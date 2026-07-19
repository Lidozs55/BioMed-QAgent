import { useRef, useState } from "react";
import {
  ArrowUpIcon,
  CaretDownIcon,
  FileIcon,
  ImageIcon,
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
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const MODELS = [
  { id: "default", label: "默认模型" },
  { id: "reasoning", label: "推理模型" },
  { id: "fast", label: "快速模型" },
] as const;

export const MAX_IMPORT_FILES = 10;
export const MAX_IMPORT_FILE_BYTES = 500 * 1024 * 1024;
export const MAX_IMPORT_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

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
}: AgentComposerProps) {
  const [model, setModel] = useState("default");
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [submittingFiles, setSubmittingFiles] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modelLabel = MODELS.find((item) => item.id === model)?.label ?? "默认模型";

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
              <DropdownMenuGroup>
                <DropdownMenuLabel>主模型</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuRadioGroup value={model} onValueChange={setModel}>
                  {MODELS.map((item) => (
                    <DropdownMenuRadioItem key={item.id} value={item.id}>
                      {item.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
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
