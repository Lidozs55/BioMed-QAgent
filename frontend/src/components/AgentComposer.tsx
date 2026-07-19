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
  /**
   * 文件上传回调。若提供，则启用"上传文件"菜单项；用户附加文件后，
   * 发送按钮触发此回调而非 `onSubmit`，进入 IMPORT 任务流程。
   */
  onSubmitFiles?: (files: File[], note: string) => void;
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
  compact = false,
  className,
}: AgentComposerProps) {
  const [model, setModel] = useState("default");
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modelLabel = MODELS.find((item) => item.id === model)?.label ?? "默认模型";

  const hasFiles = pendingFiles.length > 0;
  const canSubmitFiles = hasFiles && onSubmitFiles !== undefined && !disabled && !pending;

  const handleFilePick = (event: React.ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files;
    if (picked === null) return;
    const incoming = Array.from(picked);
    if (incoming.length === 0) return;
    setPendingFiles((current) => {
      const seen = new Set(current.map((file) => file.name));
      const merged = [...current];
      for (const file of incoming) {
        if (!seen.has(file.name)) {
          merged.push(file);
          seen.add(file.name);
        }
      }
      return merged;
    });
    // 清空 input.value 让同一文件可再次选择
    event.target.value = "";
  };

  const handleRemoveFile = (name: string) => {
    setPendingFiles((current) => current.filter((file) => file.name !== name));
  };

  const handleSubmit = () => {
    if (hasFiles && onSubmitFiles !== undefined) {
      onSubmitFiles(pendingFiles, value);
      setPendingFiles([]);
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
      handleSubmit();
      return;
    }
    onKeyDown(event);
  };

  const sendDisabledFinal =
    sendDisabled ||
    pending ||
    (hasFiles ? !canSubmitFiles : false);

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
        <div className="flex flex-wrap gap-1.5 px-3 pb-1.5">
          {pendingFiles.map((file) => (
            <span
              key={file.name}
              className="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-2 py-0.5 text-xs"
            >
              <FileIcon aria-hidden="true" weight="regular" />
              <span className="max-w-48 truncate">{file.name}</span>
              <button
                type="button"
                onClick={() => handleRemoveFile(file.name)}
                aria-label={`移除 ${file.name}`}
                className="text-muted-foreground hover:text-foreground"
              >
                <XIcon aria-hidden="true" weight="bold" />
              </button>
            </span>
          ))}
        </div>
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
            <DropdownMenuItem
              disabled={onSubmitFiles === undefined || disabled}
              onSelect={() => fileInputRef.current?.click()}
            >
              <FileIcon aria-hidden="true" />
              上传文件到本地缓存
            </DropdownMenuItem>
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
            onClick={handleSubmit}
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
