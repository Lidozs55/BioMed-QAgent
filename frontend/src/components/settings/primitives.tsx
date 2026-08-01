import { type ReactNode } from "react";

import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  SettingRow  -- left title/description + right control slot        */
/* ------------------------------------------------------------------ */
export interface SettingRowProps {
  id?: string;
  title: string;
  description?: string;
  control?: ReactNode;
  controlId?: string;
  controlClassName?: string;
  disabled?: boolean;
  danger?: boolean;
  highlight?: boolean;
  className?: string;
}

export function SettingRow({
  id,
  title,
  description,
  control,
  controlId,
  controlClassName,
  disabled,
  danger,
  highlight,
  className,
}: SettingRowProps) {
  return (
    <div
      data-anchor={id}
      data-setting-id={id}
      className={cn(
        "flex min-h-14 flex-col items-stretch justify-between gap-3 px-5 py-3 sm:flex-row sm:items-start sm:gap-4",
        disabled && "pointer-events-none opacity-50",
        highlight && "settings-highlight rounded-lg",
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        {controlId ? (
          <label htmlFor={controlId} className={cn("text-sm leading-snug font-medium", danger && "text-destructive")}>
            {title}
          </label>
        ) : (
          <p className={cn("text-sm leading-snug font-medium", danger && "text-destructive")}>{title}</p>
        )}
        {description && (
          <p className="mt-1 max-w-[42rem] text-xs leading-relaxed text-muted-foreground">{description}</p>
        )}
      </div>
      <div className={cn("flex shrink-0 items-center", "max-sm:w-full", controlClassName)}>{control}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  SettingSection / SettingCard  -- grouping primitives              */
/* ------------------------------------------------------------------ */
export interface SettingSectionProps {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}

export function SettingSection({ title, description, children, className }: SettingSectionProps) {
  return (
    <section aria-label={title} className={cn("space-y-3", className)}>
      <div className="space-y-1">
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
        {description && <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

export function SettingCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "divide-y divide-border overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10",
        className,
      )}
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  NumberField  -- numeric input + slider in one compact control     */
/* ------------------------------------------------------------------ */
export interface NumberFieldProps {
  id: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  ariaLabel?: string;
  onChange: (value: number) => void;
  marks?: { value: number; label: string }[];
  className?: string;
}

export function NumberField({
  id,
  value,
  min,
  max,
  step = 1,
  ariaLabel,
  onChange,
  marks,
  className,
}: NumberFieldProps) {
  const clamp = (next: number) => {
    if (!Number.isFinite(next)) return value;
    return Math.min(max, Math.max(min, next));
  };

  return (
    <div className={cn("flex w-64 max-w-full flex-col gap-2", className)}>
      <Input
        id={id}
        type="number"
        aria-label={ariaLabel}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(clamp(Number(event.target.value)))}
        className="h-8 w-28 font-mono text-xs tabular-nums"
      />
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        aria-label={`${ariaLabel ?? id} 滑块`}
        onValueChange={(next) => onChange(Array.isArray(next) ? next[0] ?? value : next)}
        className="w-full"
      />
      {marks && (
        <div className="flex justify-between px-0.5 text-[10px] text-muted-foreground">
          {marks.map((mark) => (
            <span key={mark.value}>{mark.label}</span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  SegmentedControl  -- small mutually exclusive enum control        */
/* ------------------------------------------------------------------ */
export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled,
  className,
}: {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (value: T) => void;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn("flex rounded-lg border border-border bg-muted/50 p-0.5", disabled && "opacity-50", className)}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={cn(
            "h-7 rounded-md px-3 text-xs font-medium whitespace-nowrap transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
            value === option.value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  ColorSwatch  -- color chip + hex input                            */
/* ------------------------------------------------------------------ */
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

export function ColorSwatch({
  value,
  onChange,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  ariaLabel?: string;
}) {
  const valid = HEX_COLOR.test(value);
  return (
    <div className="flex items-center gap-2">
      <span
        aria-hidden="true"
        className="size-5 shrink-0 rounded-full ring-1 ring-foreground/15"
        style={{ backgroundColor: valid ? value : "transparent" }}
      />
      <Input
        aria-label={ariaLabel}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        aria-invalid={!valid || undefined}
        className="h-8 w-28 font-mono text-xs uppercase"
      />
    </div>
  );
}
