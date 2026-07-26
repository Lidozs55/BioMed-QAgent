import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Props                                                             */
/* ------------------------------------------------------------------ */
export interface ContextBudgetSummaryProps {
  contextWindow: number;
  source: "catalog" | "user" | "inferred" | "unknown";
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
function sourceVariant(source: string): "default" | "secondary" | "outline" | "destructive" {
  if (source === "catalog") return "default";
  if (source === "user") return "secondary";
  if (source === "inferred") return "outline";
  return "destructive";
}

function sourceLabel(source: string): string {
  if (source === "catalog") return "catalog";
  if (source === "user") return "user";
  if (source === "inferred") return "推断";
  return "unknown";
}

/* ------------------------------------------------------------------ */
/*  Metric row                                                         */
/* ------------------------------------------------------------------ */
function MetricRow({ label, value, monospace, badge }: { label: string; value: string; monospace?: boolean; badge?: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn("flex items-center gap-1.5 text-sm font-medium", monospace && "font-mono tabular-nums")}>
        {value}
        {badge}
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
  const windowDisplay = contextWindow > 0 ? `${exact(contextWindow)} tokens` : "?";
  const inferredBadge = source === "inferred"
    ? <Badge variant="outline" className="text-[10px] px-1 py-0 leading-tight">推断</Badge>
    : undefined;

  return (
    <Card className="mt-4">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Context Budget</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <MetricRow label="Context Window" value={windowDisplay} monospace badge={inferredBadge} />
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">Source</span>
          <Badge variant={sourceVariant(source)}>{sourceLabel(source)}</Badge>
        </div>
        <Separator />
        <MetricRow label="Max Output" value={`${exact(maxOutputTokens)} tokens`} monospace />
        <MetricRow label="Safety Reserve" value={`${exact(safetyReserveTokens)} tokens`} monospace />
        <MetricRow label="Available Input" value={availableInputTokens > 0 ? `${exact(availableInputTokens)} tokens` : "?"} monospace />
      </CardContent>
    </Card>
  );
}
