import { useEffect, useRef, useState } from "react";
import { PauseIcon, PlayIcon } from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type {
  DownloadControl,
  DownloadProgressProjection,
  DownloadResumeRequest,
} from "@/runtime/types";

export interface DownloadProgressProps {
  runId: string;
  status: string;
  progress: DownloadProgressProjection;
  control?: DownloadControl;
  /** Tool invocation identity used to resume the download directly. */
  resume?: DownloadResumeRequest;
  /** When true, extra details (speed, ETA, filename) are shown. */
  expanded?: boolean;
}

function formatDownloadBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatDownloadSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "";
  return `${formatDownloadBytes(bytesPerSecond)}/s`;
}

function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  if (seconds < 60) return `约 ${Math.max(1, Math.round(seconds))} 秒`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `约 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `约 ${hours} 小时` : `约 ${hours} 小时 ${rest} 分钟`;
}

/** How long without progress events before a running download is treated as stopped. */
const DOWNLOAD_STALL_MS = 60 * 1000;
/** Interval for re-evaluating stall state without new progress events. */
const STALL_TICK_MS = 15 * 1000;
/** Speed is averaged over the last N progress samples (1s cadence server-side). */
const SPEED_SAMPLE_WINDOW = 5;

/**
 * Compact live download progress: percent bar, formatted size, measured
 * speed, ETA and a pause/resume toggle. Rendering surface-agnostic so both
 * the operation row and the tool-call bubble can share it.
 */
export function DownloadProgress({
  runId,
  status,
  progress,
  control,
  resume,
  expanded = false,
}: DownloadProgressProps) {
  const total = progress.total;
  const current = progress.current;
  const [now, setNow] = useState(() => Date.now());
  const [speed, setSpeed] = useState(0);
  const samplesRef = useRef<Array<{ t: number; bytes: number }>>([]);

  const isDownload = progress.kind === "downloaded_bytes";
  useEffect(() => {
    if (!isDownload) return;
    const id = window.setInterval(() => setNow(Date.now()), STALL_TICK_MS);
    return () => window.clearInterval(id);
  }, [isDownload]);

  const updatedAtMs = Date.parse(progress.updatedAt);
  useEffect(() => {
    if (!Number.isFinite(updatedAtMs)) return;
    const prev = samplesRef.current[samplesRef.current.length - 1];
    if (prev !== undefined && prev.bytes === current) return;
    const next = [
      ...samplesRef.current.slice(-(SPEED_SAMPLE_WINDOW - 1)),
      { t: updatedAtMs, bytes: current },
    ];
    samplesRef.current = next;
    if (next.length >= 2) {
      const first = next[0];
      const last = next[next.length - 1];
      const dt = (last.t - first.t) / 1000;
      if (dt > 0 && last.bytes > first.bytes) {
        setSpeed((last.bytes - first.bytes) / dt);
        return;
      }
    }
    setSpeed(0);
  }, [current, updatedAtMs]);

  const stalled =
    status === "running" &&
    Number.isFinite(updatedAtMs) &&
    now - updatedAtMs > DOWNLOAD_STALL_MS;
  const percent =
    total !== null && total > 0 ? Math.min(100, (current / total) * 100) : null;
  const etaSeconds =
    total !== null && speed > 0 ? (total - current) / speed : null;
  const filename = (() => {
    const value = progress.detail?.["filename"];
    return typeof value === "string" && value.length > 0 ? value : null;
  })();

  const canPause = control !== undefined && status === "running" && !stalled;
  const canResume =
    control !== undefined &&
    resume !== undefined &&
    (status !== "running" || stalled);

  return (
    <div
      data-slot="download-progress"
      data-download-status={status}
      className="flex flex-col gap-1.5"
    >
      <div className="flex items-center gap-2">
        <Progress
          value={percent ?? null}
          aria-label="下载进度"
          className="min-w-0 flex-1"
        >
          <span
            data-testid="download-percent"
            className="text-xs tabular-nums text-muted-foreground"
          >
            {percent !== null ? `${percent.toFixed(1)}%` : "…"}
          </span>
        </Progress>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {formatDownloadBytes(current)}
          {total !== null ? ` / ${formatDownloadBytes(total)}` : ""}
        </span>
        {(canPause || canResume) && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 gap-1 px-2 text-xs"
            onClick={() => {
              if (canPause) {
                void control?.onPause(control.taskId, runId);
              } else if (resume !== undefined) {
                void control?.onResume(control.taskId, runId, resume);
              }
            }}
          >
            {canPause ? (
              <>
                <PauseIcon className="size-3" aria-hidden="true" />
                暂停
              </>
            ) : (
              <>
                <PlayIcon className="size-3" aria-hidden="true" />
                恢复下载
              </>
            )}
          </Button>
        )}
      </div>
      {expanded && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          {speed > 0 && (
            <span data-testid="download-speed">
              {formatDownloadSpeed(speed)}
            </span>
          )}
          {etaSeconds !== null && etaSeconds > 0 && (
            <span data-testid="download-eta">
              剩余 {formatEta(etaSeconds)}
            </span>
          )}
          {filename !== null && (
            <span className="max-w-full truncate" title={filename}>
              {filename}
            </span>
          )}
          {stalled && (
            <span className="text-warning">下载已停止，可恢复续传</span>
          )}
        </div>
      )}
    </div>
  );
}
