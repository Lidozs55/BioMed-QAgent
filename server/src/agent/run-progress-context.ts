export const RUN_PROGRESS_CONTEXT_MAX_CHARS = 520;
const MAX_LABEL_CHARS = 64;
const MAX_LINE_CHARS = Math.floor((RUN_PROGRESS_CONTEXT_MAX_CHARS - 3) / 4);

function label(value: string): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return (compact || "unknown").slice(0, MAX_LABEL_CHARS);
}

function publicationLine(publicationId: string | null): string {
  return publicationId === null
    ? "Data product: no immutable Publication has been emitted in this run."
    : `Data product: immutable Publication=${label(publicationId)}.`;
}

function progressLine(
  publicationId: string | null,
  succeeded: number,
  failed: number,
  active: number,
): string {
  if (publicationId !== null) return "Progress: a formal publication exists; verify its assessment, provenance, and requested coverage.";
  if (active > 0) return `Progress: ${active} tool call(s) are still active; do not assume their results.`;
  if (failed > 0) return `Progress: tool evidence is incomplete; ${failed} failure(s) remain unresolved.`;
  if (succeeded > 0) return `Progress: ${succeeded} tool call(s) completed; preserve source and missing-value evidence.`;
  return "Progress: no tool evidence has been collected in this run yet.";
}

function nextLine(publicationId: string | null, latestFailure: string | null): string {
  if (publicationId !== null) return "Next: inspect ProductAssessment and artifact receipts, then report exact limitations.";
  if (latestFailure !== null) {
    return `Next: inspect ${latestFailure}; retry only if retryable or use an independent source.`;
  }
  return "Next: collect the minimum useful evidence; publish only when a formal data product is required and verified.";
}

function phase(
  publicationId: string | null,
  active: number,
  completed: number,
): "planning" | "waiting_tools" | "working" | "finalizing" {
  if (publicationId !== null) return "finalizing";
  if (active > 0) return "waiting_tools";
  return completed === 0 ? "planning" : "working";
}

export class RunProgressContextTracker {
  private readonly active = new Map<string, string>();
  private succeeded = 0;
  private failed = 0;
  private latest: string | null = null;
  private latestFailure: string | null = null;

  constructor(private readonly getCurrentPublicationId: () => string | null) {}

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
    const publicationId = this.getCurrentPublicationId();
    const currentPhase = phase(publicationId, this.active.size, this.succeeded + this.failed);
    const lines = [
      `[Run state] phase=${currentPhase}; tools=${this.succeeded} ok/${this.failed} failed/${this.active.size} active; latest=${this.latest ?? "none"}.`,
      publicationLine(publicationId),
      progressLine(publicationId, this.succeeded, this.failed, this.active.size),
      nextLine(publicationId, this.latestFailure),
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
