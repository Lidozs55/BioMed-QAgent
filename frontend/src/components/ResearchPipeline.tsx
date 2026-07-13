import {
	ChartBarIcon,
	CheckCircleIcon,
	DatabaseIcon,
	GearIcon,
	MagnifyingGlassIcon,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
	Progress,
	ProgressIndicator,
	ProgressTrack,
} from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { type TraceItem, useAgentStore } from "@/stores/agentStore";

// ---------------------------------------------------------------------------
// Stage definitions: each stage maps a set of tool-call names to a pipeline
// step via a predicate.  Complete (index 4) is special — it can only be
// reached when isRunning === false and pipelineStage === "done".
// ---------------------------------------------------------------------------
interface StageDef {
	label: string;
	/** Returns true when a tool-call name belongs to this stage. */
	toolMatches: (name: string) => boolean;
	icon: React.ElementType;
}

const STAGES: StageDef[] = [
	{
		label: "文献检索",
		toolMatches: (name: string) =>
			["search_literature", "read_file", "list_files"].includes(name),
		icon: MagnifyingGlassIcon,
	},
	{
		label: "数据获取",
		toolMatches: (name: string) =>
			name === "parse_pdf" ||
			name.startsWith("download_") ||
			name.startsWith("fetch_"),
		icon: DatabaseIcon,
	},
	{
		label: "数据处理",
		toolMatches: (name: string) =>
			name === "parse_pdf" ||
			name.startsWith("clean_") ||
			name.startsWith("merge_") ||
			name.startsWith("transform_"),
		icon: GearIcon,
	},
	{
		label: "数据分析",
		toolMatches: (name: string) =>
			name === "analyze_records" || name === "write_file",
		icon: ChartBarIcon,
	},
	{
		label: "完成",
		toolMatches: () => false,
		icon: CheckCircleIcon,
	},
];

type StageStatus = "pending" | "active" | "completed" | "failed";

// ---------------------------------------------------------------------------
// Infer the highest stage index that has been reached by at least one
// tool-call trace.  Returns -1 when nothing has been matched yet.
// ---------------------------------------------------------------------------
function inferMaxStage(
	toolCallTraces: TraceItem[],
	isRunning: boolean,
	pipelineStage: string,
): number {
	let max = -1;

	for (const trace of toolCallTraces) {
		const name = trace.name;
		if (!name) continue;

		// Walk stages from highest to lowest so that parse_pdf (which appears in
		// two stages) resolves to the later one.
		for (let i = STAGES.length - 1; i >= 0; i--) {
			if (STAGES[i].toolMatches(name)) {
				if (i > max) max = i;
				break;
			}
		}
	}

	// Override: the "完成" stage is reached when the runner signals done.
	if (!isRunning && pipelineStage === "done") {
		max = Math.max(max, STAGES.length - 1);
	}

	return max;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function ResearchPipeline() {
	const traces = useAgentStore((s) => s.traces);
	const isRunning = useAgentStore((s) => s.isRunning);
	const pipelineStage = useAgentStore((s) => s.pipelineStage);

	// ---- failsafe: 30 s with no tool calls while running --------------------
	const [failsafeActive, setFailsafeActive] = useState(false);
	const failsafeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		const hasToolCalls = traces.some((t) => t.kind === "tool_call");

		if (isRunning && !hasToolCalls) {
			if (!failsafeTimer.current) {
				failsafeTimer.current = setTimeout(
					() => setFailsafeActive(true),
					30_000,
				);
			}
		} else {
			if (failsafeTimer.current) {
				clearTimeout(failsafeTimer.current);
				failsafeTimer.current = null;
			}
			const resetTimer = setTimeout(() => setFailsafeActive(false), 0);
			return () => clearTimeout(resetTimer);
		}

		return () => {
			if (failsafeTimer.current) {
				clearTimeout(failsafeTimer.current);
				failsafeTimer.current = null;
			}
		};
	}, [isRunning, traces]);

	// ---- derive stage statuses from trace stream ----------------------------
	const toolCallTraces = useMemo(
		() => traces.filter((t) => t.kind === "tool_call"),
		[traces],
	);

	const maxStageIndex = useMemo(
		() => inferMaxStage(toolCallTraces, isRunning, pipelineStage),
		[toolCallTraces, isRunning, pipelineStage],
	);

	const stageStatuses = useMemo((): StageStatus[] => {
		const statuses: StageStatus[] = Array.from<StageStatus>({
			length: STAGES.length,
		}).fill("pending");

		if (maxStageIndex >= 0 || pipelineStage !== "idle") {
			for (let i = 0; i < STAGES.length; i++) {
				if (i < maxStageIndex) {
					statuses[i] = "completed";
				} else if (i === maxStageIndex) {
					statuses[i] = "active";
				}
			}
		}

		// Error escalation: the current active stage (or the last one if the run
		// already ended) becomes "failed".
		if (pipelineStage === "error" && maxStageIndex >= 0) {
			statuses[maxStageIndex] = "failed";
		}

		return statuses;
	}, [maxStageIndex, pipelineStage]);

	// ---- visibility ---------------------------------------------------------
	if (pipelineStage === "idle" && !isRunning && traces.length === 0) {
		return null;
	}

	// ---- progress bar -------------------------------------------------------
	const completedCount = stageStatuses.filter((s) => s === "completed").length;
	const progressPct = (completedCount / STAGES.length) * 100;

	return (
		<Card className="w-full" size="sm">
			<CardContent>
				<div className="flex flex-col gap-3 py-1">
					<Progress value={progressPct}>
						<ProgressTrack>
							<ProgressIndicator />
						</ProgressTrack>
					</Progress>

					{failsafeActive && (
						<p className="text-center text-xs text-muted-foreground">
							等待Agent响应…
						</p>
					)}

					<div className="flex items-start gap-2 overflow-x-auto">
						{STAGES.map((stage, index) => {
							const status = stageStatuses[index];
							const Icon = stage.icon;

							return (
								<div
									key={stage.label}
									className={cn(
										"flex min-w-0 flex-1 flex-col items-center gap-1 text-center",
										status === "pending" && "opacity-50",
									)}
								>
									<Icon
										className={cn(
											"size-5 shrink-0",
											status === "active" && "text-primary",
											status === "completed" && "text-secondary-foreground",
											status === "failed" && "text-destructive",
											status === "pending" && "text-muted-foreground",
										)}
									/>
									<span className="text-[0.625rem] leading-tight font-medium whitespace-nowrap">
										{stage.label}
									</span>
									<Badge
										variant={
											status === "active"
												? "default"
												: status === "completed"
													? "secondary"
													: status === "failed"
														? "destructive"
														: "outline"
										}
										className={cn(status === "active" && "animate-pulse")}
									>
										{status === "active"
											? "进行中"
											: status === "completed"
												? "已完成"
												: status === "failed"
													? "失败"
													: "等待"}
									</Badge>
								</div>
							);
						})}
					</div>
				</div>
			</CardContent>
		</Card>
	);
}
