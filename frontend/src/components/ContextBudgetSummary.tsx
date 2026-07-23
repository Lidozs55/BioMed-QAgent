import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Props                                                             */
/* ------------------------------------------------------------------ */
export interface ContextBudgetSummaryProps {
  contextWindow: number;
  source: "catalog" | "user" | "unknown";
  maxOutputTokens: number;
  safetyReserveTokens: number;
  availableInputTokens: number;
}

/* ------------------------------------------------------------------ */
/*  Number formatters                                                  */
/* ------------------------------------------------------------------ */
function exact(n: number): string {
  return n.toLocaleString();
}

/* ------------------------------------------------------------------ */
/*  Source badge variant                                                */
/* ------------------------------------------------------------------ */
function sourceVariant(source: string): "default" | "secondary" | "outline" {
  if (source === "catalog") return "default";
  if (source === "user") return "secondary";
  return "outline";
}

/* ------------------------------------------------------------------ */
/*  Metric row                                                         */
/* ------------------------------------------------------------------ */
function MetricRow({ label, value, monospace }: { label: string; value: string; monospace?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn("text-sm font-medium", monospace && "font-mono tabular-nums")}>
        {value}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */
export function ContextBudgetSummary({
  contextWindow,
  source,
  maxOutputTokens,
  safetyReserveTokens,
  availableInputTokens,
}: ContextBudgetSummaryProps) {
  return (
    <Card className="mt-4">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Context Budget</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <MetricRow label="Context Window" value={`${exact(contextWindow)} tokens`} monospace />
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">Source</span>
          <Badge variant={sourceVariant(source)}>{source}</Badge>
        </div>
        <Separator />
        <MetricRow label="Max Output" value={`${exact(maxOutputTokens)} tokens`} monospace />
        <MetricRow label="Safety Reserve" value={`${exact(safetyReserveTokens)} tokens`} monospace />
        <MetricRow label="Available Input" value={`${exact(availableInputTokens)} tokens`} monospace />
      </CardContent>
    </Card>
  );
}
