import { useState } from "react";
import { CaretDownIcon, TrashIcon } from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { paramValueError } from "@/components/settings/model/paramValidation";
import type { ParameterSpec } from "@/hooks/useAPI";

interface ParameterEditorProps {
  specs: ParameterSpec[];
  params: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  /**
   * Spec keys to hide from the graphical editor (and from the extra-params
   * list), e.g. when the same setting is exposed as a dedicated control above
   * the editor. Stored values remain untouched.
   */
  hiddenKeys?: string[];
}

function currentValue(params: Record<string, unknown>, spec: ParameterSpec): unknown {
  return params[spec.key] ?? spec.default;
}

function NumberInput({
  value,
  spec,
  controlId,
  onCommit,
}: {
  value: unknown;
  spec: ParameterSpec;
  controlId: string;
  onCommit: (next: unknown) => void;
}) {
  const isInteger = spec.type === "integer";
  const numeric = typeof value === "number" ? value : Number(value);
  return (
    <Input
      id={controlId}
      type="number"
      min={spec.min ?? undefined}
      max={spec.max ?? undefined}
      step={isInteger ? 1 : 0.05}
      value={Number.isFinite(numeric) ? numeric : ""}
      onChange={(event) => {
        const raw = event.target.value;
        if (raw === "") {
          onCommit(undefined);
          return;
        }
        const parsed = isInteger ? Number.parseInt(raw, 10) : Number.parseFloat(raw);
        onCommit(Number.isFinite(parsed) ? parsed : raw);
      }}
    />
  );
}

function SpecField({
  spec,
  value,
  controlId,
  onChange,
}: {
  spec: ParameterSpec;
  value: unknown;
  controlId: string;
  onChange: (next: unknown) => void;
}) {
  if (spec.type === "boolean") {
    return (
      <Switch
        id={controlId}
        checked={value === true}
        aria-label={spec.label}
        onCheckedChange={(checked) => onChange(checked)}
      />
    );
  }
  if (spec.type === "select") {
    const options = spec.options ?? [];
    // Base UI needs the `items` map to render the option label (not the raw
    // value) in the closed trigger.
    const items = options.map((option) => ({ value: option.value, label: option.label }));
    return (
      <Select
        id={controlId}
        items={items}
        value={value === undefined ? "" : String(value)}
        onValueChange={(next) => onChange(next)}
      >
        <SelectTrigger className="h-8 w-full" aria-label={spec.label}>
          <SelectValue placeholder="选择" />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  if (spec.type === "integer" || spec.type === "number") {
    return (
      <NumberInput
        value={value}
        spec={spec}
        controlId={controlId}
        onCommit={onChange}
      />
    );
  }
  return (
    <Input
      id={controlId}
      value={value === undefined || value === null ? "" : String(value)}
      aria-label={spec.label}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export function ParameterEditor({
  specs,
  params,
  onChange,
  hiddenKeys = [],
}: ParameterEditorProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const hidden = new Set(hiddenKeys);
  const visibleSpecs = specs.filter((spec) => !hidden.has(spec.key));
  const specKeys = new Set(visibleSpecs.map((spec) => spec.key));
  const extraKeys = Object.keys(params).filter(
    (key) => !specKeys.has(key) && !hidden.has(key),
  );
  const advancedSpecs = visibleSpecs.filter((spec) => spec.advanced);
  const regularSpecs = visibleSpecs.filter((spec) => !spec.advanced);

  const patch = (key: string, next: unknown) => {
    const updated = { ...params };
    if (next === undefined) {
      delete updated[key];
    } else {
      updated[key] = next;
    }
    onChange(updated);
  };

  return (
    <div className="flex flex-col gap-2">
      {regularSpecs.map((spec) => {
        const error = paramValueError(spec, params[spec.key]);
        return (
          <Field key={spec.key} data-invalid={Boolean(error) || undefined}>
            <div className="flex items-center justify-between gap-3">
              <FieldLabel
                htmlFor={`param-${spec.key}`}
                className="text-sm text-foreground"
                title={spec.description}
              >
                {spec.label}
              </FieldLabel>
              <div className="w-40 shrink-0">
                <SpecField
                  spec={spec}
                  value={currentValue(params, spec)}
                  controlId={`param-${spec.key}`}
                  onChange={(next) => patch(spec.key, next)}
                />
              </div>
            </div>
            {error && <FieldError>{error}</FieldError>}
          </Field>
        );
      })}
      {advancedSpecs.length > 0 && (
        <Collapsible
          open={advancedOpen}
          onOpenChange={setAdvancedOpen}
          className="border-t pt-2"
        >
          <CollapsibleTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full justify-between px-2 text-xs font-medium text-muted-foreground"
              />
            }
          >
            <span>高级参数（{advancedSpecs.length}）</span>
            <span className="flex items-center gap-1">
              {advancedOpen ? "收起" : "展开"}
              <CaretDownIcon
                className={advancedOpen ? "rotate-180" : undefined}
                aria-hidden="true"
              />
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 flex flex-col gap-2">
            {advancedSpecs.map((spec) => {
              const error = paramValueError(spec, params[spec.key]);
              return (
                <Field key={spec.key} data-invalid={Boolean(error) || undefined}>
                  <div className="flex items-center justify-between gap-3">
                    <FieldLabel
                      htmlFor={`param-${spec.key}`}
                      className="text-sm text-foreground"
                      title={spec.description}
                    >
                      {spec.label}
                    </FieldLabel>
                    <div className="w-40 shrink-0">
                      <SpecField
                        spec={spec}
                        value={currentValue(params, spec)}
                        controlId={`param-${spec.key}`}
                        onChange={(next) => patch(spec.key, next)}
                      />
                    </div>
                  </div>
                  {error && <FieldError>{error}</FieldError>}
                </Field>
              );
            })}
          </CollapsibleContent>
        </Collapsible>
      )}
      {extraKeys.length > 0 && (
        <div className="border-t pt-2">
          <p className="mb-2 text-xs font-medium text-muted-foreground">额外参数（供应商特有）</p>
          <div className="flex flex-col gap-2">
            {extraKeys.map((key) => (
              <div key={key} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{key}</span>
                <Input
                  className="h-8 w-44"
                  value={params[key] === undefined ? "" : String(params[key])}
                  aria-label={`额外参数 ${key}`}
                  onChange={(event) => patch(key, event.target.value)}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground hover:text-destructive"
                  aria-label={`删除额外参数 ${key}`}
                  onClick={() => patch(key, undefined)}
                >
                  <TrashIcon aria-hidden="true" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
