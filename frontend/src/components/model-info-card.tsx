import { CheckCircleIcon, Image, SpeakerHigh, VideoCamera, XCircleIcon } from "@phosphor-icons/react";

import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type { CapabilitySource, ModelInfo } from "@/hooks/useAPI";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */
interface ModelCapabilities {
  text: boolean;
  image: boolean;
  video: boolean;
  audio: boolean;
}

export interface RichModelInfo extends ModelInfo {
  capabilities: ModelCapabilities;
  recommended: boolean;
  api_available: boolean;
  capability_source: CapabilitySource;
}

/* ------------------------------------------------------------------ */
/*  CapabilityBadge                                                    */
/* ------------------------------------------------------------------ */
function CapabilityBadge({ label, supported, icon: Icon }: { label: string; supported: boolean; icon?: React.ElementType }) {
  return (
    <span className={cn(
      "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium",
      supported
        ? "text-emerald-600 dark:text-emerald-400"
        : "bg-muted text-muted-foreground line-through",
    )}>
      {Icon ? <Icon weight="fill" className="size-3" /> : (supported ? <CheckCircleIcon weight="fill" className="size-3" /> : <XCircleIcon weight="fill" className="size-3" />)}
      {label}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Number formatter                                                   */
/* ------------------------------------------------------------------ */
function fn(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(0)}K` : String(n);
}

/* ------------------------------------------------------------------ */
/*  ModelInfoCard                                                      */
/* ------------------------------------------------------------------ */
export function ModelInfoCard({ model }: { model: RichModelInfo }) {
  const capabilities = model.capabilities ?? { text: true, image: false, video: false, audio: false };

  return (
    <div className="mt-4 rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="text-base font-semibold">{model.name}</h4>
            {model.recommended && <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">推荐</span>}
            {model.api_available && <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">可用</span>}
            <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              {model.capability_source === "api" ? "接口验证" : model.capability_source === "catalog" ? "内置数据" : model.capability_source}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{model.description}</p>
        </div>
        <span className="shrink-0 rounded-md bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">{model.id}</span>
      </div>
      <Separator className="my-3" />
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div><span className="text-xs text-muted-foreground">上下文窗口</span><p className="mt-0.5 font-medium">{fn(model.context_window)} tokens</p></div>
        <div><span className="text-xs text-muted-foreground">建议输出上限</span><p className="mt-0.5 font-medium">{fn(model.suggested_max_tokens)} tokens</p></div>
      </div>
      <div className="mt-3">
        <span className="text-xs text-muted-foreground">多模态能力</span>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <CapabilityBadge label="文本" supported={capabilities.text} />
          <CapabilityBadge icon={Image} label="图像" supported={capabilities.image} />
          <CapabilityBadge icon={VideoCamera} label="视频" supported={capabilities.video} />
          <CapabilityBadge icon={SpeakerHigh} label="音频" supported={capabilities.audio} />
        </div>
      </div>
    </div>
  );
}
