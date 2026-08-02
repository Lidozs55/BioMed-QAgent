import { useCallback, useMemo, useState } from "react";
import { SlidersHorizontalIcon } from "@phosphor-icons/react";
import { toast } from "sonner";

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
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** Common context window presets in tokens, smallest first. */
const COMMON_WINDOWS = [
  8_192,
  16_384,
  32_768,
  65_536,
  131_072,
  262_144,
  524_288,
  1_000_000,
  2_000_000,
] as const;

const PRESET_LABELS: Record<number, string> = {
  8_192: "8K",
  16_384: "16K",
  32_768: "32K",
  65_536: "64K",
  131_072: "128K",
  262_144: "256K",
  524_288: "512K",
  1_000_000: "1M",
  2_000_000: "2M",
};

type Unit = "B" | "K" | "M";

const UNIT_MULTIPLIER: Record<Unit, number> = { B: 1, K: 1_024, M: 1_048_576 };

function formatTokens(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(n % 1_048_576 === 0 ? 0 : 1)}M`;
  if (n >= 1_024) return `${(n / 1_024).toFixed(n % 1_024 === 0 ? 0 : 1)}K`;
  return String(n);
}

function windowLabel(tokens: number): string {
  return PRESET_LABELS[tokens] ?? formatTokens(tokens);
}

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

export interface ContextWindowSelectProps {
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

export function ContextWindowSelect({
  value,
  maxCatalogWindow,
  source,
  onChange,
}: ContextWindowSelectProps) {
  const options = useMemo(() => {
    const result: { tokens: number; label: string }[] = [];
    const seen = new Set<number>();
    const push = (tokens: number) => {
      if (tokens > 0 && !seen.has(tokens)) {
        seen.add(tokens);
        result.push({ tokens, label: windowLabel(tokens) });
      }
    };
    for (const tokens of COMMON_WINDOWS) {
      if (maxCatalogWindow <= 0 || tokens <= maxCatalogWindow) push(tokens);
    }
    // Keep the model's documented max visible even when it is not a common preset.
    if (maxCatalogWindow > 0) push(maxCatalogWindow);
    // Keep an existing custom value selectable so the dropdown reflects the state.
    if (value > 0) push(value);
    return result.sort((a, b) => a.tokens - b.tokens);
  }, [maxCatalogWindow, value]);

  const selectedKey = options.some((option) => option.tokens === value)
    ? String(value)
    : "";

  const handleSelect = useCallback(
    (raw: string | null) => {
      if (raw === null) return;
      const tokens = Number(raw);
      if (!Number.isFinite(tokens) || tokens <= 0) return;
      if (maxCatalogWindow > 0 && tokens > maxCatalogWindow) {
        toast.warning("超出该模型最大上下文限制", {
          description: `该模型最大上下文为 ${formatTokens(maxCatalogWindow)} tokens，已自动调整为最大值`,
        });
        onChange(maxCatalogWindow);
        return;
      }
      onChange(tokens);
    },
    [maxCatalogWindow, onChange],
  );

  return (
    <Field>
      <div className="flex items-center justify-between gap-3">
        <FieldLabel>上下文窗口</FieldLabel>
        {source === "inferred" && (
          <span className="rounded border border-dashed border-muted-foreground/40 px-1 py-0.5 text-[10px] text-muted-foreground">
            推断
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Select value={selectedKey} onValueChange={handleSelect}>
          <SelectTrigger aria-label="上下文窗口" className="w-full sm:w-64">
            <SelectValue placeholder="选择上下文窗口" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {options.map((option) => (
                <SelectItem key={option.tokens} value={String(option.tokens)}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <CustomContextPopover
          value={value}
          maxCatalogWindow={maxCatalogWindow}
          onChange={onChange}
        />
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
