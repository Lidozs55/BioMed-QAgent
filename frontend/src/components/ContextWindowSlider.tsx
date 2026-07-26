import { useCallback, useMemo, useState } from "react";
import { SlidersHorizontalIcon } from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** Preset context window values in tokens. */
const PRESETS = [
  { label: "128K", value: 131_072 },
  { label: "256K", value: 262_144 },
  { label: "512K", value: 524_288 },
  { label: "1M", value: 1_000_000 },
  { label: "2M", value: 2_000_000 },
] as const;

type Unit = "B" | "K" | "M";

const UNIT_MULTIPLIER: Record<Unit, number> = { B: 1, K: 1_024, M: 1_048_576 };

function formatTokens(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(n % 1_048_576 === 0 ? 0 : 1)}M`;
  if (n >= 1_024) return `${(n / 1_024).toFixed(n % 1_024 === 0 ? 0 : 1)}K`;
  return String(n);
}

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

export interface ContextWindowSliderProps {
  /** Current effective context window in tokens. */
  value: number;
  /** Maximum allowed context window (from catalog). 0 = no known limit. */
  maxCatalogWindow: number;
  /** Source of the current value. */
  source: "catalog" | "user" | "inferred" | "unknown";
  /** Called when the user commits a new context window value. */
  onChange: (tokens: number) => void;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function ContextWindowSlider({
  value,
  maxCatalogWindow,
  source,
  onChange,
}: ContextWindowSliderProps) {
  // Find closest preset index for the slider position
  const presetIndex = useMemo(() => {
    const idx = PRESETS.findIndex((p) => p.value === value);
    return idx >= 0 ? idx : -1;
  }, [value]);

  // Slider uses index-based positioning; -1 means custom (show at nearest)
  const sliderValue = useMemo(() => {
    if (presetIndex >= 0) return [presetIndex];
    // Find nearest preset below current value
    let nearest = 0;
    for (let i = 0; i < PRESETS.length; i++) {
      if (PRESETS[i].value <= value) nearest = i;
    }
    return [nearest];
  }, [presetIndex, value]);

  const handleSliderChange = useCallback(
    (newVal: number[]) => {
      const idx = newVal[0];
      if (idx >= 0 && idx < PRESETS.length) {
        const selected = PRESETS[idx].value;
        // Clamp to catalog max if known
        if (maxCatalogWindow > 0 && selected > maxCatalogWindow) {
          onChange(maxCatalogWindow);
        } else {
          onChange(selected);
        }
      }
    },
    [maxCatalogWindow, onChange],
  );

  return (
    <Field>
      <div className="flex items-center justify-between">
        <FieldLabel>上下文窗口</FieldLabel>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            {value > 0 ? formatTokens(value) : "?"}
          </span>
          {source === "inferred" && (
            <span className="rounded border border-dashed border-muted-foreground/40 px-1 py-0.5 text-[10px] text-muted-foreground">
              推断
            </span>
          )}
          <CustomContextPopover
            value={value}
            maxCatalogWindow={maxCatalogWindow}
            onChange={onChange}
          />
        </div>
      </div>
      <div className="flex flex-col gap-1.5 pt-1">
        <Slider
          value={sliderValue}
          min={0}
          max={PRESETS.length - 1}
          step={1}
          onValueChange={handleSliderChange}
        />
        <div className="flex justify-between">
          {PRESETS.map((p, i) => (
            <button
              key={p.value}
              type="button"
              onClick={() => {
                if (maxCatalogWindow > 0 && p.value > maxCatalogWindow) {
                  onChange(maxCatalogWindow);
                } else {
                  onChange(p.value);
                }
              }}
              className={cn(
                "text-[10px] transition-colors hover:text-foreground",
                sliderValue[0] === i
                  ? "font-medium text-primary"
                  : "text-muted-foreground",
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      {maxCatalogWindow > 0 && value > maxCatalogWindow && (
        <FieldDescription className="text-destructive">
          超出模型最大上下文窗口 ({formatTokens(maxCatalogWindow)})
        </FieldDescription>
      )}
    </Field>
  );
}

/* ------------------------------------------------------------------ */
/*  Custom context popover ("更多设置")                                 */
/* ------------------------------------------------------------------ */

function CustomContextPopover({
  value,
  maxCatalogWindow,
  onChange,
}: {
  value: number;
  maxCatalogWindow: number;
  onChange: (tokens: number) => void;
}) {
  const [open, setOpen] = useState(false);

  // Decompose current value into number + unit for the input
  const decomposed = useMemo(() => {
    if (value <= 0) return { num: "", unit: "K" as Unit };
    if (value >= 1_048_576 && value % 1_048_576 === 0) {
      return { num: String(value / 1_048_576), unit: "M" as Unit };
    }
    if (value >= 1_024 && value % 1_024 === 0) {
      return { num: String(value / 1_024), unit: "K" as Unit };
    }
    return { num: String(value), unit: "B" as Unit };
  }, [value]);

  const [numStr, setNumStr] = useState(decomposed.num);
  const [unit, setUnit] = useState<Unit>(decomposed.unit);
  const [error, setError] = useState<string | null>(null);

  const handleApply = useCallback(() => {
    const n = Number(numStr);
    if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
      setError("请输入正整数");
      return;
    }
    const tokens = n * UNIT_MULTIPLIER[unit];
    if (maxCatalogWindow > 0 && tokens > maxCatalogWindow) {
      // Clamp to max and notify
      onChange(maxCatalogWindow);
      setError(`已调整为模型最大值 ${formatTokens(maxCatalogWindow)}`);
      setNumStr(
        maxCatalogWindow >= 1_048_576
          ? String(Math.round(maxCatalogWindow / 1_048_576))
          : String(Math.round(maxCatalogWindow / 1_024)),
      );
      setUnit(maxCatalogWindow >= 1_048_576 ? "M" : "K");
      return;
    }
    setError(null);
    onChange(tokens);
    setOpen(false);
  }, [numStr, unit, maxCatalogWindow, onChange]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-xs text-muted-foreground">
            <SlidersHorizontalIcon data-icon="inline-start" />
            更多设置
          </Button>
        }
      />
      <PopoverContent align="end" className="w-64">
        <PopoverHeader>
          <PopoverTitle>自定义上下文窗口</PopoverTitle>
        </PopoverHeader>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={1}
            value={numStr}
            onChange={(e) => {
              setNumStr(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleApply();
            }}
            className="h-8 flex-1"
            placeholder="数值"
          />
          <Select value={unit} onValueChange={(v) => setUnit(v as Unit)}>
            <SelectTrigger size="sm" className="w-16">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="B">B</SelectItem>
                <SelectItem value="K">K</SelectItem>
                <SelectItem value="M">M</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        {error && (
          <p className={cn("text-xs", error.startsWith("已调整") ? "text-amber-600" : "text-destructive")}>
            {error}
          </p>
        )}
        {maxCatalogWindow > 0 && (
          <p className="text-xs text-muted-foreground">
            模型上限: {formatTokens(maxCatalogWindow)} tokens
          </p>
        )}
        <Button size="sm" className="mt-1 w-full" onClick={handleApply}>
          应用
        </Button>
      </PopoverContent>
    </Popover>
  );
}
