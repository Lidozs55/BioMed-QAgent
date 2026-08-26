import type { BuildResult } from "@biomed/contracts";

export const RUN_PROGRESS_CONTEXT_MAX_CHARS = 520;
const MAX_LABEL_CHARS = 64;
const MAX_LINE_CHARS = Math.floor((RUN_PROGRESS_CONTEXT_MAX_CHARS - 3) / 4);

function label(value: string): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return (compact || "unknown").slice(0, MAX_LABEL_CHARS);
}

function buildLine(result: BuildResult | null): string {
  if (result === null) return "Data product: formal build=none; publication=none.";
  return `Data product: formal build=${result.status}; publication=${label(result.publication_id ?? "none")}.`;
}

function progressLine(
  result: BuildResult | null,
  succeeded: number,
  failed: number,
  active: number,
): string {
  if (result?.status === "succeeded") {
    return `Progress: formal output exists with ${result.valid_row_count} valid rows and ${result.successful_sources.length} successful source(s).`;
  }
  if (result?.status === "partial_success") {
    return `Progress: formal output is partial with ${result.valid_row_count} valid rows; rejected or missing coverage remains explicit.`;
  }
  if (result?.status === "no_data") {
    return "Progress: the build recorded no data; missing coverage remains explicit and must not be invented.";
  }
  if (result?.status === "spec_rejected") {
    return "Progress: the build specification was rejected; no formal dataset was produced.";
  }
  if (active > 0) return `Progress: ${active} tool call(s) are still active; do not assume their results.`;
  if (failed > 0) return `Progress: tool evidence is incomplete; ${failed} failure(s) remain unresolved.`;
  if (succeeded > 0) return `Progress: ${succeeded} tool call(s) completed; preserve source and missing-value evidence.`;
  return "Progress: no tool evidence has been collected in this run yet.";
}

function nextLine(result: BuildResult | null, latestFailure: string | null): string {
  if (result?.status === "succeeded") {
    return "Next: verify artifact and provenance coverage, then report exact limitations.";
  }
  if (result?.status === "partial_success") {
    return "Next: resolve rejected coverage when possible, otherwise report the partial scope honestly.";
  }
  if (result?.status === "no_data") {
    return "Next: seek an independent real source or report NO_DATA without fabricating rows.";
  }
  if (result?.status === "spec_rejected") {
    return "Next: correct the semantic specification before another build attempt.";
  }
  if (latestFailure !== null) {
    return `Next: inspect ${latestFailure}; retry only if retryable or use an independent source.`;
  }
  return "Next: plan the minimum useful evidence steps; consider a formal build only if publishable data is required.";
}

function phase(
  result: BuildResult | null,
  active: number,
  completed: number,
): "planning" | "waiting_tools" | "working" | "finalizing" {
  if (result !== null) return "finalizing";
  if (active > 0) return "waiting_tools";
  return completed === 0 ? "planning" : "working";
}

export class RunProgressContextTracker {
  private readonly active = new Map<string, string>();
  private succeeded = 0;
  private failed = 0;
  private latest: string | null = null;
  private latestFailure: string | null = null;

  constructor(private readonly getBuildResult: () => BuildResult | null) {}

  reset(): void {
    this.active.clear();
    this.succeeded = 0;
    this.failed = 0;
    this.latest = null;
    this.latestFailure = null;
  }

  toolStarted(toolCallId: string, toolName: string): void {
    const name = label(toolName);
    this.active.set(toolCallId, name);
    this.latest = `${name} active`;
  }

  toolCompleted(toolCallId: string, toolName: string, isError: boolean): void {
    const name = label(toolName);
    this.active.delete(toolCallId);
    if (isError) {
      this.failed += 1;
      this.latestFailure = name;
      this.latest = `${name} failed`;
    } else {
      this.succeeded += 1;
      this.latest = `${name} ok`;
    }
  }

  render(): string {
    const result = this.getBuildResult();
    const currentPhase = phase(result, this.active.size, this.succeeded + this.failed);
    const lines = [
      `[Run state] phase=${currentPhase}; tools=${this.succeeded} ok/${this.failed} failed/${this.active.size} active; latest=${this.latest ?? "none"}.`,
      buildLine(result),
      progressLine(result, this.succeeded, this.failed, this.active.size),
      nextLine(result, this.latestFailure),
    ];
    return lines.map((line) => line.slice(0, MAX_LINE_CHARS)).join("\n");
  }
}

export function runProgressContextMessage(
  tracker: RunProgressContextTracker,
  timestamp = Date.now(),
) {
  return {
    role: "custom" as const,
    customType: "biomed_run_progress",
    content: tracker.render(),
    display: false,
    timestamp,
  };
}
