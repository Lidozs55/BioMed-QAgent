import { TrashIcon } from "@phosphor-icons/react";

import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { ParameterSpec } from "@/hooks/useAPI";

interface ParameterEditorProps {
  specs: ParameterSpec[];
  params: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
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
    return (
      <Select
        id={controlId}
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

export function ParameterEditor({ specs, params, onChange }: ParameterEditorProps) {
  const specKeys = new Set(specs.map((spec) => spec.key));
  const extraKeys = Object.keys(params).filter((key) => !specKeys.has(key));
  const advancedSpecs = specs.filter((spec) => spec.advanced);
  const regularSpecs = specs.filter((spec) => !spec.advanced);

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
    <div className="space-y-3">
      {regularSpecs.map((spec) => (
        <div key={spec.key} className="flex items-center justify-between gap-3">
          <label
            htmlFor={`param-${spec.key}`}
            className="text-sm text-foreground"
            title={spec.description}
          >
            {spec.label}
          </label>
          <div className="w-44 shrink-0">
            <SpecField
              spec={spec}
              value={currentValue(params, spec)}
              controlId={`param-${spec.key}`}
              onChange={(next) => patch(spec.key, next)}
            />
          </div>
        </div>
      ))}
      {advancedSpecs.length > 0 && (
        <div className="border-t pt-3">
          <p className="mb-2 text-xs font-medium text-muted-foreground">高级参数</p>
          <div className="space-y-3">
            {advancedSpecs.map((spec) => (
              <div key={spec.key} className="flex items-center justify-between gap-3">
                <label
                  htmlFor={`param-${spec.key}`}
                  className="text-sm text-foreground"
                  title={spec.description}
                >
                  {spec.label}
                </label>
                <div className="w-44 shrink-0">
                  <SpecField
                    spec={spec}
                    value={currentValue(params, spec)}
                    controlId={`param-${spec.key}`}
                    onChange={(next) => patch(spec.key, next)}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {extraKeys.length > 0 && (
        <div className="border-t pt-3">
          <p className="mb-2 text-xs font-medium text-muted-foreground">额外参数（供应商特有）</p>
          <div className="space-y-2">
            {extraKeys.map((key) => (
              <div key={key} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{key}</span>
                <Input
                  className="h-8 w-44"
                  value={params[key] === undefined ? "" : String(params[key])}
                  aria-label={`额外参数 ${key}`}
                  onChange={(event) => patch(key, event.target.value)}
                />
                <button
                  type="button"
                  className="text-muted-foreground hover:text-destructive"
                  aria-label={`删除额外参数 ${key}`}
                  onClick={() => patch(key, undefined)}
                >
                  <TrashIcon className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
