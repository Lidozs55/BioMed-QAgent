import { Input } from "@/components/ui/input";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldSet, FieldLegend } from "@/components/ui/field";
import {
  isCompactionRatioValid,
  isSafetyReserveRatioValid,
  parseOverrideWindow,
} from "@/lib/contextBudget";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */
export interface ContextBudgetValues {
  safetyReserveRatio: number;
  compactionTriggerRatio: number;
  compactionTargetRatio: number;
  /** String draft for override — "0" or "" means use catalog/saved. */
  contextWindowOverrideStr: string;
}

export interface ContextBudgetControlsProps extends ContextBudgetValues {
  showAdvanced: boolean;
  /** Effective budget source — used to determine if blank override is "required" (API-only) or "use catalog" (known). */
  source: "catalog" | "user" | "inferred" | "unknown";
  onChange: (values: ContextBudgetValues) => void;
}

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */
export function ContextBudgetControls({
  safetyReserveRatio,
  compactionTriggerRatio,
  compactionTargetRatio,
  contextWindowOverrideStr,
  showAdvanced,
  source,
  onChange,
}: ContextBudgetControlsProps) {
  const safetyInvalid = !isSafetyReserveRatioValid(safetyReserveRatio);
  const compactionInvalid = !isCompactionRatioValid(
    compactionTargetRatio,
    compactionTriggerRatio,
  );
  const overrideParsed = parseOverrideWindow(contextWindowOverrideStr);
  const overrideParsedInvalid = Number.isNaN(overrideParsed);
  // For API-only/unknown model, blank/zero override is required — treat as invalid.
  const isOverrideRequired = source === "unknown";
  const isBlank = contextWindowOverrideStr.trim() === "" || contextWindowOverrideStr.trim() === "0";
  const overrideInvalid = overrideParsedInvalid || (isOverrideRequired && isBlank);

  const handleChange = (patch: Partial<ContextBudgetValues>) => {
    onChange({
      safetyReserveRatio,
      compactionTriggerRatio,
      compactionTargetRatio,
      contextWindowOverrideStr,
      ...patch,
    });
  };

  return (
    <>
      {/* Context window override — primary context control */}
      <FieldSet>
        <FieldLegend>Context Configuration</FieldLegend>
        <FieldGroup>
          {showAdvanced && (
            <Field data-invalid={overrideInvalid || undefined}>
              <FieldLabel htmlFor="budget-context-override">Context Window Override</FieldLabel>
              <Input
                id="budget-context-override"
                type="number"
                min={0}
                step={1}
                value={contextWindowOverrideStr}
                aria-invalid={overrideInvalid || undefined}
                placeholder="0 = use catalog value"
                onChange={(e) => handleChange({ contextWindowOverrideStr: e.target.value })}
              />
              {overrideInvalid && (
                <FieldError>
                  {isOverrideRequired && isBlank
                    ? "Required for API-only/unknown model — enter a positive safe integer"
                    : "Must be a positive safe integer"}
                </FieldError>
              )}
              <FieldDescription>Override catalog context window for compatible deployments (0 = use catalog)</FieldDescription>
            </Field>
          )}
        </FieldGroup>
      </FieldSet>

      {/* Advanced ratios group */}
      <FieldSet>
        <FieldLegend>Advanced Budget Ratios</FieldLegend>
        <FieldGroup>
          {/* Safety reserve ratio */}
          <Field data-invalid={safetyInvalid || undefined}>
            <FieldLabel htmlFor="budget-safety-ratio">Safety Reserve Ratio</FieldLabel>
            <Input
              id="budget-safety-ratio"
              type="number"
              min={0}
              max={0.25}
              step={0.01}
              value={String(safetyReserveRatio)}
              aria-invalid={safetyInvalid || undefined}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                if (!Number.isNaN(v)) handleChange({ safetyReserveRatio: v });
              }}
            />
            {safetyInvalid && (
              <FieldError>Must be between 0 and 0.25</FieldError>
            )}
            <FieldDescription>Fraction of context window reserved as safety buffer (0–0.25)</FieldDescription>
          </Field>

          {/* Compaction trigger ratio */}
          <Field data-invalid={compactionInvalid || undefined}>
            <FieldLabel htmlFor="budget-compact-trigger">Compaction Trigger</FieldLabel>
            <Input
              id="budget-compact-trigger"
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={String(compactionTriggerRatio)}
              aria-invalid={compactionInvalid || undefined}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                if (!Number.isNaN(v)) handleChange({ compactionTriggerRatio: v });
              }}
            />
            {compactionInvalid && (
              <FieldError>Must satisfy 0 &lt; target &lt; trigger &lt; 1</FieldError>
            )}
            <FieldDescription>Compact when input exceeds this fraction of capacity</FieldDescription>
          </Field>

          {/* Compaction target ratio */}
          <Field data-invalid={compactionInvalid || undefined}>
            <FieldLabel htmlFor="budget-compact-target">Compaction Target</FieldLabel>
            <Input
              id="budget-compact-target"
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={String(compactionTargetRatio)}
              aria-invalid={compactionInvalid || undefined}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                if (!Number.isNaN(v)) handleChange({ compactionTargetRatio: v });
              }}
            />
            {compactionInvalid && (
              <FieldError>Must satisfy 0 &lt; target &lt; trigger &lt; 1</FieldError>
            )}
            <FieldDescription>Target fraction of capacity after compaction</FieldDescription>
          </Field>
        </FieldGroup>
      </FieldSet>
    </>
  );
}
