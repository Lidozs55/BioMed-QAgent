#!/usr/bin/env node
/**
 * solidify-run.mjs — Skill 自生成 / 自迭代：流程固化 + 可拆卸工具包
 *
 * 把「一次已完成任务/会话的工具流」沉淀为可复用资产的单一自包含脚本
 * （纯 Node、stdlib-only，符合 scripts/ 既有约定）。
 *
 * 用法:
 *   node scripts/solidify-run.mjs <taskId|taskDir>        # 流程固化（默认）
 *   node scripts/solidify-run.mjs --toolkit [outDir]     # 可拆卸工具包文档
 *   node scripts/solidify-run.mjs --help
 *
 * 默认模式（流程固化）：
 *   - 读取 <taskDir>/events.jsonl，按 sequence 还原工具调用流；
 *   - 判定每个工具是否「确定性可重放」（本地分析/统计/绘图/数据集执行），
 *     网络/凭据类（search/download/capture/VLM 等）仅记录不作为可自动重放主干；
 *   - 在 <taskDir>/solidification/ 下产出：
 *       report.md                  自迭代分析报告
 *       replay-method-<n>.mjs      可复用脚本候选（占位参数化）
 *       SKILL-candidate-<name>.md  SKILL.md 固化候选（待人工评审后提升进 .pi/skills/）
 *
 * --toolkit 模式（可拆卸工具包）：
 *   - 扫描 .pi/skills 下每个技能目录中的 SKILL.md，生成独立 Markdown 文档 + README
 *     索引到 outDir（默认 docs/toolkit/），可被任何 agent 单独调用。
 *
 * 固化到生产路径（scripts/、.pi/skills/）必须经人工评审(HIL)；本脚本只在任务/文档
 * 目录自动产出候选，不擅自写入生产路径。见 docs/architecture/skill-self-iteration.md。
 */
import { readdir, readFile, stat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const TASKS_ROOT = path.resolve("data/output/tasks");
const SKILLS_ROOT = path.resolve(".pi/skills");

/** 确定性可重放的工具族：前缀匹配（分析/统计/绘图/本地 PDF 提取）。 */
const DETERMINISTIC_PATTERNS = [/^generate_/, /^run_/, /^basic_/, /^extract_pdf_/];
/** 确定性可重放的工具全名（本地数据集执行等）。 */
const DETERMINISTIC_EXACT = new Set([
  "validate_dataset_execution",
  "execute_dataset_execution",
  "get_research_data_guidance",
]);
/** 采集类：需网络/外部队列/凭据，仅记录不自动重放。 */
const ACQUIRE_PATTERNS = [
  /^search_/,
  /^describe_/,
  /^download_/,
  /^get_/,
  /^navigate_/,
  /^capture_/,
  /^list_/,
  /^analyze_/,
  /^extract_chart_/,
];

const USAGE = `
用法:
  node scripts/solidify-run.mjs <taskId|taskDir>        # 流程固化（默认）
  node scripts/solidify-run.mjs --toolkit [outDir]     # 可拆卸工具包文档
  node scripts/solidify-run.mjs --help

Options:
  --toolkit [outDir]  生成 .pi/skills 每技能独立 Markdown 文档 + README 索引
                      outDir 默认 docs/toolkit/
  -h, --help          显示本帮助
`.trim();

function fail(message) {
  console.error(`[solidify-run] ${message}`);
  process.exit(1);
}

export function classifyStep(name) {
  if (typeof name !== "string") return "skip";
  if (DETERMINISTIC_EXACT.has(name)) return "deterministic";
  for (const re of DETERMINISTIC_PATTERNS) if (re.test(name)) return "deterministic";
  for (const re of ACQUIRE_PATTERNS) if (re.test(name)) return "acquire";
  return "skip";
}

/** 解析一个参数对象，抽出可重放的参数名（键），用于可复用脚本的占位化。 */
export function parameterizeArgs(argumentsValue) {
  if (argumentsValue === null || typeof argumentsValue !== "object") return [];
  return Object.entries(argumentsValue)
    .filter(([key, value]) => typeof value === "string" || typeof value === "number")
    .map(([key]) => key);
}

/**
 * 单遍还原 events.jsonl 的工具流。
 * 返回 { flows, lastRunStatus }，其中 flows 为 runId -> steps（按 sequence 有序）。
 * steps 每项: { seq, runId, name, args, startedAt, completedAt, isError }。
 */
export function traceFlow(eventsLines) {
  const started = new Map();
  const byRun = new Map();
  let lastRunStatus = null;
  for (const line of eventsLines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const { type, run_id: runId, sequence, timestamp, payload } = event ?? {};
    if (type === "run_completed") lastRunStatus = "completed";
    else if (type === "run_failed") lastRunStatus = "failed";
    else if (type === "run_cancelled") lastRunStatus = "cancelled";
    else if (type === "run_interrupted") lastRunStatus = "interrupted";
    if (payload === null || typeof payload !== "object") continue;
    const callId = payload.tool_call_id;
    if (type === "tool_started" && typeof callId === "string") {
      const step = {
        seq: sequence,
        runId,
        name: payload.tool_name ?? "?",
        args: payload.arguments ?? null,
        startedAt: timestamp,
        completedAt: null,
        isError: null,
      };
      started.set(callId, step);
      const run = byRun.get(runId) ?? [];
      run.push(step);
      byRun.set(runId, run);
    } else if (type === "tool_completed" && typeof callId === "string") {
      const step = started.get(callId);
      if (step !== undefined) {
        step.completedAt = timestamp;
        step.isError = payload.is_error === true;
      }
    }
  }
  const flows = [...byRun.entries()].map(([runId, steps]) => ({
    runId,
    steps,
    deterministic: steps.filter((step) => classifyStep(step.name) === "deterministic"),
    acquire: steps.filter((step) => classifyStep(step.name) === "acquire"),
  }));
  return { flows, lastRunStatus };
}

/** 渲染一个可复用脚本候选（占位参数化，供人工评审后固化为具体脚本）。 */
export function renderScriptCandidate(run, meta) {
  const steps = run.deterministic;
  const assignments = steps
    .map(
      (step) =>
        `  ["${step.name}", [${parameterizeArgs(step.args)
          .map((key) => JSON.stringify(`<${key}>`))
          .join(", ")}]]`,
    )
    .join(",\n");
  const name = `replay-method-${run.runId ? String(run.runId).slice(-8) : "x"}`;
  return `#!/usr/bin/env node
/**
 * ${name}.mjs — 由 solidify-run 从任务 ${meta.taskId} 的工具流生成的可复用脚本候选。
 *
 * 该脚本是「确定性可重放子流程」的骨架：把 agent 一次执行中的分析/统计/绘图/本地
 * PDF 提取步骤沉淀为可重复调用，降低同类任务的调用成本。
 * 请按具体输入补齐每个步骤的参数占位（<param>），经人工评审后再固化为准生产脚本。
 *
 * 用法: node ${name}.mjs <workspaceDir> [...]
 */
const replays = [
${assignments.length ? assignments : "  // （本 run 无确定性可重放步骤）"}
];

function main(workspaceDir) {
  if (!workspaceDir) {
    console.error("用法: node ${name}.mjs <workspaceDir>");
    process.exit(1);
  }
  console.log("待固化子流程：" + replays.length + " 个确定性步骤");
  for (const [tool, params] of replays) {
    const placeholders = params.join(", ");
    console.log("  - " + tool + (placeholders ? " (" + placeholders + ")" : ""));
  }
}

main(process.argv[2]);
`;
}

/** 渲染一个 SKILL.md 固化候选（带 frontmatter，待人工评审后提升进 .pi/skills/）。 */
export function renderSkillCandidate(run, meta) {
  const deterministic = run.deterministic.map((step) => step.name);
  const acquire = run.acquire.map((step) => step.name);
  const name = meta.taskId ? String(meta.taskId).replace(/[^a-z0-9-]/gi, "-").toLowerCase() : "solidified-flow";
  return `---
name: ${name}
description: Solidified run flow (from task ${meta.taskId}, run ${run.runId ?? "?"}). Covers deterministic replay for ${deterministic.join(", ") || "none"}. Review before promoting to production skills.
---

# Solidified flow (task ${meta.taskId})

This is a SKILL.md **candidate** produced by solidify-run for self-iteration. It is
written only to the task's solidification/ directory; promoting it here (curated
\`.pi/skills/\`) requires human review (HIL).

## Steps (deterministic, replayable)

- ${deterministic.map((tool) => `\`${tool}\``).join("\n- ") || "(none)"}

## Acquisition dependencies (network / credentials — not auto-replayed)

- ${acquire.map((tool) => `\`${tool}\``).join("\n- ") || "(none)"}

## Constraints

- Only deterministic local steps above are safe to replay; acquisition steps
  require network/credentials and must be re-vetted each time.
- Do not present unverified or NO_DATA results as success.
`;
}

/** 从 printableKeys / description 组合出一个稳定的工具族标签，作为剧本说明。 */
function slug(name) {
  return String(name).replace(/[^a-z0-9-]/gi, "-").toLowerCase().replace(/-+/g, "-").replace(/^-|-$/g, "");
}

export async function renderToolkitDoc(filepath, skillsRoot) {
  const text = await readFile(filepath, "utf8");
  const parsed = parseFrontmatter(text);
  const rel = path.relative(skillsRoot, filepath);
  const skillName = rel.split(path.sep)[0];
  return `# ${skillName}

> ${parsed.description || "No description."}
>
> source: \`.pi/skills/${rel.replaceAll("\\", "/")}\`

${parsed.body}
`;
}

export function renderToolkitIndex(entries) {
  const rows = entries
    .map(
      (e) =>
        `| [${e.name}](./${encodeURIComponent(e.slug)}.md) | ${String(e.description)
          .replace(/\|/g, "\\|")
          .replace(/\s+/g, " ")
          .slice(0, 120)} |`,
    )
    .join("\n");
  return `# BioMed-QAgent 可拆卸工具包

> 由 \`scripts/solidify-run.mjs --toolkit\` 生成。每个技能一份独立 Markdown，
> 可被任何 agent 单独调用，无需完整启动整个项目。

| 技能 | 说明 |
| --- | --- |
${rows || "| _(空)_ |" }

生成命令:
\`\`\`bash
node scripts/solidify-run.mjs --toolkit docs/toolkit
\`\`\`
`;
}

/** 解析 SKILL.md frontmatter（--- 包裹的 YAML 风格 name/description）。 */
export function parseFrontmatter(text) {
  const trimmed = String(text);
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u.exec(trimmed);
  if (!match) return { description: "", body: trimmed };
  const fields = {};
  for (const line of match[1].split(/\r?\n/u)) {
    const m = /^([a-zA-Z0-9_-]+):\s*(.*)$/u.exec(line);
    if (m) fields[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return { description: fields.description ?? "", body: match[2].replace(/^\s*\n/u, "") };
}

export async function scanSkills(skillsRoot) {
  const out = [];
  let names;
  try {
    names = await readdir(skillsRoot);
  } catch {
    return [];
  }
  for (const dir of names) {
    const filepath = path.join(skillsRoot, dir, "SKILL.md");
    try {
      if (!(await stat(filepath)).isFile()) continue;
      const text = await readFile(filepath, "utf8");
      const parsed = parseFrontmatter(text);
      out.push({ name: dir, slug: slug(dir), description: parsed.description, sourcePath: filepath });
    } catch {
      /* skip unreadable skill dir */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
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

function argLegend(args) {
  const keys = parameterizeArgs(args);
  return keys.length > 0 ? ` (params: ${keys.join(", ")})` : "";
}

async function findTaskDir(arg) {
  let taskDir = arg;
  if (!path.isAbsolute(taskDir)) {
    const candidates = [path.resolve(taskDir), path.resolve(TASKS_ROOT, taskDir)];
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
    if (found === null) fail(`找不到任务目录: ${arg}（尝试 ${candidates.join(" 或 ")}）`);
    taskDir = found;
  }
  return taskDir;
}

async function solidifyTask(task) {
  const taskDir = await findTaskDir(task);
  const taskId = path.basename(taskDir);
  console.log(`=== 流程固化: ${taskId} ===`);
  const eventsLines = await readJsonlLines(path.join(taskDir, "events.jsonl"));
  if (eventsLines === null) fail(`缺少 ${path.join(taskDir, "events.jsonl")}`);
  const { flows, lastRunStatus } = traceFlow(eventsLines);
  const outDir = path.join(taskDir, "solidification");
  await mkdir(outDir, { recursive: true });

  const sections = [`# 自迭代分析报告 — ${taskId}`, "", `Run 终止状态: ${lastRunStatus ?? "unknown"}`, ""];
  for (const run of flows) {
    const runId = run.runId ?? "?";
    sections.push(`## run ${runId}`, "");
    sections.push(`- 确定性可重放步骤: ${run.deterministic.length}`);
    for (const step of run.deterministic) {
      sections.push(`  - \`${step.name}\`${argLegend(step.args)}${step.isError ? "  **(error)**" : ""}`);
    }
    sections.push(`- 采集（网络/凭据）步骤: ${run.acquire.length}`);
    for (const step of run.acquire) {
      sections.push(`  - \`${step.name}\`${argLegend(step.args)}${step.isError ? "  **(error)**" : ""}`);
    }
    sections.push("");

    if (run.deterministic.length > 0) {
      const script = renderScriptCandidate(run, { taskId });
      const scriptName = `replay-method-${String(runId).slice(-8)}.mjs`;
      await writeFile(path.join(outDir, scriptName), script);
      const skill = renderSkillCandidate(run, { taskId });
      const skillName = `SKILL-candidate-${slug(taskId)}.md`;
      await writeFile(path.join(outDir, skillName), skill);
      sections.push(`产物: \`${scriptName}\`、\`${skillName}\``, "");
    }
  }
  await writeFile(path.join(outDir, "report.md"), sections.join("\n"));
  console.log(`已写入: ${outDir}（report.md${flows.some((r) => r.deterministic.length > 0) ? " + 脚本/SKILL 候选" : ""}）`);
  return outDir;
}

async function toolkit(input) {
  const outDir = input === null ? path.resolve("docs/toolkit") : path.resolve(input);
  const skills = await scanSkills(SKILLS_ROOT);
  if (skills.length === 0) fail(`未在 ${SKILLS_ROOT} 找到任何技能`);
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "README.md"), renderToolkitIndex(skills));
  for (const skill of skills) {
    const doc = await renderToolkitDoc(skill.sourcePath, SKILLS_ROOT);
    await writeFile(path.join(outDir, `${skill.slug}.md`), doc);
  }
  console.log(`已生成可拆卸工具包: ${outDir}（${skills.length} 个技能 + README.md）`);
  return outDir;
}

function parseArgs(argv) {
  const positional = [];
  let toolkitDir = null;
  let toolkitFlag = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--toolkit") {
      toolkitFlag = true;
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) toolkitDir = argv[++i];
    } else positional.push(arg);
  }
  return { help: false, toolkit: toolkitFlag, toolkitDir, task: positional[0] ?? null };
}

async function main() {
  const { help, toolkit: toolkitFlag, toolkitDir, task } = parseArgs(process.argv.slice(2));
  if (help) {
    console.log(USAGE);
    return;
  }
  if (toolkitFlag) {
    await toolkit(toolkitDir);
    return;
  }
  if (task === null) {
    console.log(USAGE);
    fail("缺少任务参数");
  }
  await solidifyTask(task);
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
