#!/usr/bin/env node
/**
 * task-log-summary.mjs — 简洁任务日志查看器
 *
 * 对 data/output/tasks/<task>/ 下的三份 JSONL 日志做摘要输出：
 *   - events.jsonl         任务事件流（工具调用时间线 + 下载进度）
 *   - logs/workspace-audit.jsonl   workspace 审计（重点看非 success）
 *   - state/pi-session/*.jsonl     LLM 会话（重点看工具错误结果）
 *
 * 用法:
 *   node scripts/task-log-summary.mjs <taskId|taskDir> [options]
 *
 * Options:
 *   --events        输出工具调用时间线（默认）
 *   --audit         输出 workspace 审计非成功项（默认）
 *   --session       输出 pi-session 工具错误（默认）
 *   --downloads     输出下载进度摘要（默认）
 *   --errors        只输出错误/失败项
 *   --limit N       每节最多 N 条（默认 200）
 *   --no-events     关闭工具时间线
 *   --no-audit      关闭审计
 *   --no-session    关闭会话
 *   --no-downloads  关闭下载摘要
 */
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const TASKS_ROOT = path.resolve("data/output/tasks");

function usage() {
  console.log(
    "用法: node scripts/task-log-summary.mjs <taskId|taskDir> [--errors] [--limit N] [--no-events|--no-audit|--no-session|--no-downloads]",
  );
  process.exit(1);
}

function parseArgs(argv) {
  const positional = [];
  const flags = { errors: false, events: true, audit: true, session: true, downloads: true, limit: 200 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--errors") flags.errors = true;
    else if (arg === "--no-events") flags.events = false;
    else if (arg === "--no-audit") flags.audit = false;
    else if (arg === "--no-session") flags.session = false;
    else if (arg === "--no-downloads") flags.downloads = false;
    else if (arg === "--limit") flags.limit = Number(argv[++i]) || 200;
    else positional.push(arg);
  }
  if (positional.length !== 1) usage();
  return { task: positional[0], ...flags };
}

async function readJsonlLines(filePath) {
  try {
    const text = await readFile(filePath, "utf8");
    return text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function fmtTime(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toISOString().slice(11, 19);
}

function percent(current, total) {
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) return null;
  return `${((current / total) * 100).toFixed(1)}%`;
}

function argSummary(argumentsValue) {
  if (argumentsValue === null || typeof argumentsValue !== "object") return "";
  const parts = Object.entries(argumentsValue)
    .filter(([, value]) => typeof value === "string" || typeof value === "number")
    .map(([key, value]) => `${key}=${String(value).slice(0, 60)}`);
  return parts.length > 0 ? `(${parts.join(", ")})` : "";
}

/** 从 tool_completed 的 output 字符串里提取摘要（content 文本或 is_error）。 */
function outputSummary(output) {
  if (typeof output !== "string") return null;
  try {
    const parsed = JSON.parse(output);
    const content = Array.isArray(parsed?.content) ? parsed.content : null;
    const textParts = (content ?? [])
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text);
    if (textParts.length === 0) return null;
    const text = textParts[0].replaceAll("\n", " ").slice(0, 120);
    return text;
  } catch {
    return output.replaceAll("\n", " ").slice(0, 120);
  }
}

/**
 * 单遍解析 events.jsonl：
 *   - tools: tool_call_id -> { startedAt, name, args, completedAt, isError, output }
 *   - timeline: run_id -> tool 顺序列表
 *   - downloads: "run|accession" -> { current, total, filename }
 */
function parseEvents(eventsLines) {
  const tools = new Map();
  const timeline = new Map();
  const downloads = new Map();
  for (const line of eventsLines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const { type, run_id: runId, sequence, timestamp, payload } = event;
    if (payload == null || typeof payload !== "object") continue;
    const toolCallId = payload.tool_call_id;

    if (type === "tool_started" && typeof toolCallId === "string") {
      const tool = {
        seq: sequence,
        runId,
        startedAt: timestamp,
        name: payload.tool_name ?? "?",
        args: payload.arguments ?? null,
        completedAt: null,
        isError: null,
        output: null,
      };
      tools.set(toolCallId, tool);
      const run = timeline.get(runId) ?? [];
      run.push(tool);
      timeline.set(runId, run);
    } else if (type === "tool_completed" && typeof toolCallId === "string") {
      const tool = tools.get(toolCallId);
      if (tool !== undefined) {
        tool.completedAt = timestamp;
        tool.isError = payload.is_error === true;
        tool.output = payload.output ?? null;
      }
    } else if (type === "operation_progress" && payload.kind === "downloaded_bytes") {
      const accession = typeof payload.detail?.accession === "string"
        ? payload.detail.accession
        : "?";
      const key = `${runId ?? ""}|${accession}`;
      const existing = downloads.get(key) ?? { current: 0, total: null, filename: null };
      existing.current = payload.current ?? existing.current;
      existing.total = payload.total ?? existing.total;
      if (typeof payload.detail?.filename === "string") existing.filename = payload.detail.filename;
      downloads.set(key, existing);
    }
  }
  return { timeline, downloads };
}

function summarizeEvents(parsed, limit, errorsOnly) {
  const out = [];
  for (const [runId, runTools] of parsed.timeline) {
    out.push(`\n[run ${runId}]`);
    let shown = 0;
    for (const tool of runTools) {
      if (errorsOnly && !tool.isError) continue;
      if (shown >= limit) {
        out.push(`  … (仅显示前 ${limit} 条)`);
        break;
      }
      shown += 1;
      const duration = tool.completedAt != null
        ? `${((Date.parse(tool.completedAt) - Date.parse(tool.startedAt)) / 1000).toFixed(1)}s`
        : "…";
      const status = tool.isError === true ? "✗" : "✓";
      const summary = errorsOnly ? outputSummary(tool.output) : null;
      out.push(
        `  ${fmtTime(tool.startedAt)} ${status} ${tool.name}${argSummary(tool.args)} → ${duration}` +
          (summary !== null ? ` [${summary}]` : ""),
      );
    }
  }
  if (out.length === 0) out.push("（无匹配项）");
  return out.join("\n");
}

function summarizeDownloads(downloads, errorsOnly) {
  if (errorsOnly) return "（--errors 下跳过下载摘要）";
  const out = [];
  for (const [key, d] of downloads) {
    const [runId, accession] = key.split("|");
    const pct = percent(d.current, d.total);
    out.push(
      `  ${runId} ${accession} → ${fmtBytes(d.current)} / ${fmtBytes(d.total)}` +
        (pct !== null ? ` (${pct})` : " (total 未知)") +
        (d.filename !== null ? `  ${d.filename}` : ""),
    );
  }
  return out.length > 0 ? out.join("\n") : "（无下载进度事件）";
}

function summarizeAudit(auditLines, limit, errorsOnly) {
  const out = [];
  for (const line of auditLines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const bad = entry.result !== "success";
    if (errorsOnly && !bad) continue;
    const runTag = entry.runId ? `[${entry.runId.slice(-8)}]` : "";
    const pathTag = entry.path !== undefined ? ` ${entry.path}` : "";
    const cmdTag = Array.isArray(entry.command) ? ` ${entry.command.join(" ").slice(0, 100)}` : "";
    out.push(`  ${bad ? "✗" : "✓"} ${entry.operation}${pathTag}${cmdTag} → ${entry.result} ${runTag}`);
    if (out.length >= limit) {
      out.push(`  … (仅显示前 ${limit} 条)`);
      break;
    }
  }
  return out.length > 0 ? out.join("\n") : "（无匹配项）";
}

function summarizeSession(sessionLines, limit, errorsOnly) {
  const out = [];
  for (const line of sessionLines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message?.role !== "toolResult") continue;
    const isError = message.isError === true;
    if (errorsOnly && !isError) continue;
    const text = Array.isArray(message.content)
      ? message.content
          .filter((block) => block?.type === "text" && typeof block.text === "string")
          .map((block) => block.text)
          .join(" ")
          .replaceAll("\n", " ")
          .slice(0, 140)
      : "";
    out.push(
      `  ${isError ? "✗" : "✓"} ${message.toolName ?? "?"} → ${text || "(空输出)"}`,
    );
    if (out.length >= limit) {
      out.push(`  … (仅显示前 ${limit} 条)`);
      break;
    }
  }
  return out.length > 0 ? out.join("\n") : "（无匹配项）";
}

async function main() {
  const { task, events, audit, session, downloads, errors, limit } = parseArgs(process.argv.slice(2));

  // 定位任务目录：直接传目录或传 taskId
  let taskDir = task;
  if (!path.isAbsolute(taskDir)) {
    const candidates = [path.resolve(taskDir), path.resolve(TASKS_ROOT, task)];
    let found = null;
    for (const candidate of candidates) {
      try {
        if ((await stat(candidate)).isDirectory()) {
          found = candidate;
          break;
        }
      } catch {
        /* try next */
      }
    }
    if (found === null) {
      console.error(`找不到任务目录: ${task}（尝试 ${candidates.join(" 或 ")}）`);
      process.exit(1);
    }
    taskDir = found;
  }
  console.log(`=== 任务: ${path.basename(taskDir)} ===`);
  console.log(`目录: ${taskDir}`);

  const eventsLines = await readJsonlLines(path.join(taskDir, "events.jsonl"));
  const auditLines = await readJsonlLines(path.join(taskDir, "logs", "workspace-audit.jsonl"));
  const sessionDir = path.join(taskDir, "state", "pi-session");
  let sessionLines = [];
  try {
    const files = await readdir(sessionDir);
    for (const file of files.filter((name) => name.endsWith(".jsonl"))) {
      const lines = await readJsonlLines(path.join(sessionDir, file));
      if (lines !== null) sessionLines = sessionLines.concat(lines);
    }
  } catch {
    /* no pi-session dir */
  }
  console.log(
    `events: ${eventsLines?.length ?? 0} 条 | workspace-audit: ${auditLines?.length ?? 0} 条 | pi-session: ${sessionLines.length} 条`,
  );

  if (events && eventsLines !== null) {
    const parsed = parseEvents(eventsLines);
    console.log("\n=== 工具调用时间线 ===");
    console.log(summarizeEvents(parsed, limit, errors));
    if (downloads) {
      console.log("\n=== 下载进度摘要 ===");
      console.log(summarizeDownloads(parsed.downloads, errors));
    }
  }
  if (audit && auditLines !== null) {
    console.log("\n=== workspace 审计 ===");
    console.log(summarizeAudit(auditLines, limit, errors));
  }
  if (session && sessionLines.length > 0) {
    console.log("\n=== pi-session 工具结果 ===");
    console.log(summarizeSession(sessionLines, limit, errors));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
