import { useCallback, useMemo, useState } from "react";
import { SlidersHorizontalIcon } from "@phosphor-icons/react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
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
import {
  TOKEN_UNIT_MULTIPLIER,
  decomposeTokenCount,
  formatTokenCount,
  type TokenUnit,
} from "@/lib/tokenFormat";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** Common context window presets in tokens (base-10 rounds), smallest first. */
const COMMON_WINDOWS = [
  8_000,
  16_000,
  32_000,
  64_000,
  128_000,
  256_000,
  512_000,
  1_000_000,
  2_000_000,
] as const;

/** Unit options for the custom context popover; labels equal values here. */
const UNIT_ITEMS = [
  { value: "B", label: "B" },
  { value: "K", label: "K" },
  { value: "M", label: "M" },
] as const;

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
        result.push({ tokens, label: formatTokenCount(tokens) });
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

  // Base UI renders the raw value in the trigger unless `items` is provided;
  // pass the label map so the trigger shows "128K" instead of "128000".
  const items = options.map((option) => ({
    value: String(option.tokens),
    label: option.label,
  }));

  const handleSelect = useCallback(
    (raw: string | null) => {
      if (raw === null) return;
      const tokens = Number(raw);
      if (!Number.isFinite(tokens) || tokens <= 0) return;
      if (maxCatalogWindow > 0 && tokens > maxCatalogWindow) {
        toast.warning("超出该模型最大上下文限制", {
          description: `该模型最大上下文为 ${formatTokenCount(maxCatalogWindow)} tokens，已自动调整为最大值`,
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
          <Badge
            variant="outline"
            className="border-dashed text-muted-foreground"
          >
            推断
          </Badge>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Select items={items} value={selectedKey} onValueChange={handleSelect}>
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
          超出模型最大上下文窗口 ({formatTokenCount(maxCatalogWindow)})
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
    if (value <= 0) return { num: "", unit: "K" as TokenUnit };
    return decomposeTokenCount(value);
  }, [value]);

  const [numStr, setNumStr] = useState(decomposed.num);
  const [unit, setUnit] = useState<TokenUnit>(decomposed.unit);
  const [error, setError] = useState<string | null>(null);

  const handleApply = useCallback(() => {
    const n = Number(numStr);
    if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
      setError("请输入正整数");
      return;
    }
    const tokens = n * TOKEN_UNIT_MULTIPLIER[unit];
    if (maxCatalogWindow > 0 && tokens > maxCatalogWindow) {
      // Clamp to max and notify
      onChange(maxCatalogWindow);
      setError(`已调整为模型最大值 ${formatTokenCount(maxCatalogWindow)}`);
      setNumStr(
        maxCatalogWindow >= 1_000_000
          ? String(Math.round(maxCatalogWindow / 1_000_000))
          : String(Math.round(maxCatalogWindow / 1_000)),
      );
      setUnit(maxCatalogWindow >= 1_000_000 ? "M" : "K");
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
          <Select items={UNIT_ITEMS} value={unit} onValueChange={(v) => setUnit(v as TokenUnit)}>
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
          <p className={cn("text-xs", error.startsWith("已调整") ? "text-warning" : "text-destructive")}>
            {error}
          </p>
        )}
        {maxCatalogWindow > 0 && (
          <p className="text-xs text-muted-foreground">
            模型上限: {formatTokenCount(maxCatalogWindow)} tokens
          </p>
        )}
        <Button size="sm" className="mt-1 w-full" onClick={handleApply}>
          应用
        </Button>
      </PopoverContent>
    </Popover>
  );
}
