/**
 * 任务输出栏的图表预览：当前任务的 extract_chart_data_vlm 工具结果
 * 经只读任务文件接口加载，并从 chart metadata / points CSV 渲染。
 * 该视图只展示工具产出的候选图表，不改变正式 Publication 信任状态。
 */
import {
  CaretDownIcon,
  CaretUpIcon,
  ChartBarIcon,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { useAPI } from "@/hooks/useAPI";
import {
  buildSidebarCharts,
  EXTRACT_CHART_TOOL_NAME,
  parseChartToolOutput,
  type ChartToolOutput,
  type SidebarChart,
  type SidebarChartSeries,
} from "@/lib/chartData";
import { useAgentStore } from "@/stores/agentStore";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

const SERIES_PALETTE = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

const CHART_MARGIN = { top: 4, right: 8, bottom: 0, left: 0 };
const TICK_STYLE = { fontSize: 10 };

function buildCategoryRows(chart: SidebarChart): Array<Record<string, string | number>> {
  const rowByKey = new Map<string, Record<string, string | number>>();
  const order: string[] = [];
  chart.series.forEach((entry: SidebarChartSeries, seriesIndex: number) => {
    const key = "s" + String(seriesIndex);
    for (const point of entry.points) {
      let row = rowByKey.get(point.x);
      if (row === undefined) {
        row = { x: point.x };
        rowByKey.set(point.x, row);
        order.push(point.x);
      }
      row[key] = point.y;
    }
  });
  const rows = order.map((x) => rowByKey.get(x) as Record<string, string | number>);
  if (chart.allXNumeric) {
    rows.sort((a, b) => Number(a.x) - Number(b.x));
  }
  return rows;
}

function logAxisProps(log: boolean): { scale?: "log"; domain?: ["auto", "auto"]; type?: "number" } {
  return log ? { scale: "log", domain: ["auto", "auto"], type: "number" } : {};
}

function TaskOutputChartCard({ chart }: { chart: SidebarChart }) {
  const multi = chart.series.length > 1;
  const caption = [chart.xLabel, chart.yLabel].filter((label) => label !== "").join(" / ");
  return (
    <div className="rounded-md border border-border bg-muted/30 p-2">
      <p className="truncate text-xs font-medium text-foreground" title={chart.title}>
        {chart.title}
      </p>
      <ResponsiveContainer width="100%" height={150}>
        {chart.kind === "scatter" ? (
          <ScatterChart margin={CHART_MARGIN}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="x" type="number" tick={TICK_STYLE} {...logAxisProps(chart.xLog)} />
            <YAxis dataKey="y" type="number" width={40} tick={TICK_STYLE} {...logAxisProps(chart.yLog)} />
            <Tooltip contentStyle={{ fontSize: 11 }} />
            {multi && <Legend wrapperStyle={{ fontSize: 10 }} />}
            {chart.series.map((entry, index) => (
              <Scatter
                key={entry.label}
                name={entry.label}
                data={entry.points.map((point) => ({ x: point.xNumeric, y: point.y }))}
                fill={SERIES_PALETTE[index % SERIES_PALETTE.length]}
              />
            ))}
          </ScatterChart>
        ) : chart.kind === "line" ? (
          <LineChart data={buildCategoryRows(chart)} margin={CHART_MARGIN}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="x" tick={TICK_STYLE} {...logAxisProps(chart.xLog)} />
            <YAxis width={40} tick={TICK_STYLE} {...logAxisProps(chart.yLog)} />
            <Tooltip contentStyle={{ fontSize: 11 }} />
            {multi && <Legend wrapperStyle={{ fontSize: 10 }} />}
            {chart.series.map((entry, index) => (
              <Line
                key={entry.label}
                type="monotone"
                dataKey={"s" + String(index)}
                name={entry.label}
                stroke={SERIES_PALETTE[index % SERIES_PALETTE.length]}
                strokeWidth={1.5}
                dot={false}
              />
            ))}
          </LineChart>
        ) : (
          <BarChart data={buildCategoryRows(chart)} margin={CHART_MARGIN}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="x" tick={TICK_STYLE} />
            <YAxis width={40} tick={TICK_STYLE} {...logAxisProps(chart.yLog)} />
            <Tooltip contentStyle={{ fontSize: 11 }} />
            {multi && <Legend wrapperStyle={{ fontSize: 10 }} />}
            {chart.series.map((entry, index) => (
              <Bar
                key={entry.label}
                dataKey={"s" + String(index)}
                name={entry.label}
                fill={SERIES_PALETTE[index % SERIES_PALETTE.length]}
                radius={[2, 2, 0, 0]}
              />
            ))}
          </BarChart>
        )}
      </ResponsiveContainer>
      {caption !== "" && (
        <p className="mt-1 truncate text-[10px] text-muted-foreground" title={caption}>
          {caption}
        </p>
      )}
    </div>
  );
}

export function TaskOutputCharts() {
  const activeTaskId = useAgentStore((state) => state.activeTaskId);
  const items = useAgentStore((state) =>
    state.activeTaskId === null ? null : state.tasksById[state.activeTaskId]?.items ?? null,
  );
  const api = useAPI();
  const [open, setOpen] = useState(true);
  // 以「task + 输出签名」为 key 的加载快照；渲染时按 key 是否仍匹配派生
  // charts / loadError，避免在 effect 体内同步 setState（级联渲染）。
  const [loaded, setLoaded] = useState<{
    key: string | null;
    charts: SidebarChart[] | null;
    error: boolean;
  }>({ key: null, charts: null, error: false });

  const outputs = useMemo(() => {
    if (items === null || activeTaskId === null) return [] as ChartToolOutput[];
    const parsed: ChartToolOutput[] = [];
    for (const item of items) {
      if (
        item.kind !== "tool_call" ||
        item.toolName !== EXTRACT_CHART_TOOL_NAME ||
        item.status !== "completed"
      ) {
        continue;
      }
      const output = parseChartToolOutput(item.output);
      if (output !== null) parsed.push(output);
    }
    return parsed;
  }, [items, activeTaskId]);

  const signature = useMemo(() => JSON.stringify(outputs), [outputs]);
  // CSV 按 chart_id 跨调用累积合并，最后一条工具输出里的路径即为全量数据。
  const lastOutput = outputs.length > 0 ? outputs[outputs.length - 1] : null;
  const currentKey =
    activeTaskId !== null && lastOutput !== null
      ? activeTaskId + "\u0000" + signature
      : null;
  const lastFetchRef = useRef<string | null>(null);

  useEffect(() => {
    if (currentKey === null || activeTaskId === null || lastOutput === null) {
      lastFetchRef.current = null;
      return;
    }
    // 相同 task + 相同输出签名不重复请求（其余会话事件不触发 refetch）。
    if (lastFetchRef.current === currentKey) return;
    lastFetchRef.current = currentKey;
    let cancelled = false;
    void (async () => {
      try {
        const [metaText, pointsText] = await Promise.all([
          api.fetchTaskFileText(activeTaskId, lastOutput.chartDataPath),
          api.fetchTaskFileText(activeTaskId, lastOutput.pointsPath),
        ]);
        if (cancelled) return;
        setLoaded({ key: currentKey, charts: buildSidebarCharts(metaText, pointsText), error: false });
      } catch {
        if (!cancelled) {
          setLoaded({ key: currentKey, charts: null, error: true });
        }
      }
    })();
    return () => {
      cancelled = true;
      // 清理时同步清掉去重标记，StrictMode 二次挂载 / key 回退时仍可重取。
      if (lastFetchRef.current === currentKey) lastFetchRef.current = null;
    };
  }, [currentKey, activeTaskId, lastOutput, api]);

  const isCurrent = loaded.key !== null && loaded.key === currentKey;
  const charts = isCurrent ? loaded.charts : null;
  const loadError = isCurrent && loaded.error;

  if (outputs.length === 0) return null;
  if (charts === null || charts.length === 0) {
    if (!loadError) return null;
    return (
      <p className="flex items-center gap-1.5 truncate px-1 text-xs text-muted-foreground">
        <ChartBarIcon aria-hidden="true" className="size-3.5 shrink-0" />
        图表数据加载失败
      </p>
    );
  }
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-foreground/70 transition-colors hover:bg-muted hover:text-foreground">
        <ChartBarIcon aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="truncate">工具图表预览</span>
        <span className="ml-auto flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
          {charts.length}
          {open ? (
            <CaretUpIcon aria-hidden="true" className="size-3" />
          ) : (
            <CaretDownIcon aria-hidden="true" className="size-3" />
          )}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 px-2 pt-2">
        {charts.map((chart) => (
          <TaskOutputChartCard key={chart.chartId} chart={chart} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}
