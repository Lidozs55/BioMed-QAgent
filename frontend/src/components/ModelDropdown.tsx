import { Image, SpeakerHigh, VideoCamera } from "@phosphor-icons/react";
import { useState } from "react";

import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { RichModelInfo } from "@/components/model-info-card";

/* ------------------------------------------------------------------ */
/*  Props                                                             */
/* ------------------------------------------------------------------ */
export interface ModelDropdownProps {
  models: RichModelInfo[];
  modelsLoading: boolean;
  selectedModelId: string;
  onSelectModel: (id: string) => void;
  onPreview: () => void;
}

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */
export function ModelDropdown({
  models,
  modelsLoading,
  selectedModelId,
  onSelectModel,
  onPreview,
}: ModelDropdownProps) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);

  const selectedModel = models.find((m) => m.id === selectedModelId) ?? null;
  const filtered = models.filter((m) =>
    m.name.toLowerCase().includes(search.toLowerCase()) ||
    m.id.toLowerCase().includes(search.toLowerCase()),
  );

  const handleSelect = (id: string) => {
    onSelectModel(id);
    setOpen(false);
    setSearch("");
  };

  return (
    <div className="flex gap-2">
      <div className="relative flex-1">
        {models.length === 0 ? (
          <Input
            id="settings-model"
            value={selectedModelId}
            onChange={(e) => onSelectModel(e.target.value)}
            placeholder="输入模型名称（如 qwen-plus）"
          />
        ) : (
          <>
            <button
              type="button"
              id="settings-model"
              className="flex h-10 w-full items-center justify-between rounded-lg border bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => setOpen((v) => !v)}
            >
              {modelsLoading ? (
                <span className="flex items-center gap-2 text-muted-foreground">
                  <Spinner className="size-3.5" />
                  加载模型列表中...
                </span>
              ) : (
                <span>{selectedModel ? selectedModel.name : "选择模型"}</span>
              )}
              <span className="text-xs text-muted-foreground">
                {models.length > 0 ? `${models.length} 个可用` : ""}
              </span>
            </button>
            {open && (
              <div className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-lg border bg-popover shadow-md">
                <div className="p-2">
                  <Input
                    placeholder="搜索模型..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="h-9 text-sm"
                    autoFocus
                  />
                </div>
                <ScrollArea className="h-72">
                  {filtered.length === 0 ? (
                    <div className="p-4 text-center text-sm text-muted-foreground">没有匹配的模型</div>
                  ) : filtered.map((model) => (
                    <button
                      key={model.id}
                      type="button"
                      className={cn(
                        "flex w-full items-center justify-between px-3 py-2.5 text-left text-sm hover:bg-accent",
                        model.id === selectedModelId && "bg-accent font-medium",
                      )}
                      onClick={() => handleSelect(model.id)}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate">{model.name}</span>
                          {model.recommended && (
                            <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">推荐</span>
                          )}
                        </div>
                        <p className="truncate text-xs text-muted-foreground">{model.description}</p>
                      </div>
                      <div className="ml-3 flex shrink-0 gap-1.5">
                        {model.capabilities?.image && <CapabilityIcon title="支持图像"><Image weight="fill" className="size-3" /></CapabilityIcon>}
                        {model.capabilities?.video && <CapabilityIcon title="支持视频"><VideoCamera weight="fill" className="size-3" /></CapabilityIcon>}
                        {model.capabilities?.audio && <CapabilityIcon title="支持音频"><SpeakerHigh weight="fill" className="size-3" /></CapabilityIcon>}
                      </div>
                    </button>
                  ))}
                </ScrollArea>
              </div>
            )}
          </>
        )}
      </div>
      <Button type="button" variant="outline" onClick={onPreview} disabled={modelsLoading}>
        {modelsLoading && <Spinner data-icon="inline-start" />}
        加载模型
      </Button>
    </div>
  );
}

function CapabilityIcon({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <span role="img" className="text-emerald-600 dark:text-emerald-400" title={title} aria-label={title}>
      {children}
    </span>
  );
}
