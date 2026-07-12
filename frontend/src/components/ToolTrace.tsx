import { TerminalIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from "@/components/ui/sheet";
import { useAgentStore } from "../stores/agentStore";

function getStatus(kind: string) {
	switch (kind) {
		case "tool_call":
			return "running";
		case "tool_output":
			return "success";
		case "error":
			return "error";
		default:
			return "running";
	}
}

function getKindLabel(kind: string) {
	switch (kind) {
		case "tool_call":
			return "Call";
		case "tool_output":
			return "Output";
		case "error":
			return "Error";
		default:
			return kind;
	}
}

/** Tool trace debug panel — slides in from the right via Sheet, renders each tool call as a Card. */
export function ToolTrace() {
	const traces = useAgentStore((s) => s.traces);
	const isConnected = useAgentStore((s) => s.isConnected);
	const reset = useAgentStore((s) => s.reset);
	const [open, setOpen] = useState(false);

	return (
		<Sheet open={open} onOpenChange={setOpen}>
			<SheetTrigger
				render={
					<Button
						variant="outline"
						size="icon"
						className="fixed bottom-4 right-4 z-40 shadow-lg"
					/>
				}
			>
				<TerminalIcon />
			</SheetTrigger>
			<SheetContent side="right">
				<SheetHeader>
					<SheetTitle>Tool Trace</SheetTitle>
					<SheetDescription>
						{isConnected ? "Connected" : "Disconnected"}
					</SheetDescription>
				</SheetHeader>
				<ScrollArea className="-mx-6 flex-1 px-6">
					{traces.length === 0 ? (
						<div className="py-8 text-center text-xs text-muted-foreground">
							No tool calls yet
						</div>
					) : (
						<div className="flex flex-col gap-3 py-2">
							{traces.map((t) => {
								const status = getStatus(t.kind);
								return (
									<Card key={t.id} size="sm">
										<CardHeader>
											<div className="flex w-full items-center justify-between">
												<CardTitle className="text-xs">
													{getKindLabel(t.kind)}
													{t.name ? `: ${t.name}` : ""}
												</CardTitle>
												<Badge
													variant={
														status === "success"
															? "secondary"
															: status === "error"
																? "destructive"
																: "outline"
													}
													className={
														status === "running" ? "animate-pulse" : ""
													}
												>
													{status}
												</Badge>
											</div>
										</CardHeader>
										{(t.arguments || t.output || t.message) && (
											<CardContent>
												<pre className="whitespace-pre-wrap break-all font-mono text-[0.625rem] leading-relaxed text-muted-foreground">
													{t.arguments ?? t.output ?? t.message}
												</pre>
											</CardContent>
										)}
									</Card>
								);
							})}
						</div>
					)}
				</ScrollArea>
				<SheetFooter>
					<Button
						variant="outline"
						size="sm"
						className="w-full"
						onClick={() => {
							reset();
							setOpen(false);
						}}
						disabled={traces.length === 0}
					>
						<Trash2Icon data-icon="inline-start" />
						Clear Trace
					</Button>
				</SheetFooter>
			</SheetContent>
		</Sheet>
	);
}
