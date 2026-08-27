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
 *   - 扫描 server/src/agent/tools 下的 TypeScript 工具定义，生成独立 Markdown 文档
 *     + README 索引到 outDir（默认 docs/toolkit/），可被其他 agent 单独调用。
 *
 * 固化到生产路径（scripts/、.pi/skills/）必须经人工评审(HIL)；本脚本只在任务/文档
 * 目录自动产出候选，不擅自写入生产路径。见 docs/architecture/skill-self-iteration.md。
 */
import { readdir, readFile, stat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const TASKS_ROOT = path.resolve("data/output/tasks");
const TOOLS_ROOT = path.resolve("server/src/agent/tools");

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
  --toolkit [outDir]  为 server/src/agent/tools 的 TS 工具生成独立调用文档 + README 索引
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

/** 从工具或模块名称生成稳定文件名。 */
function slug(name) {
  return String(name).replace(/[^a-z0-9-]/gi, "-").toLowerCase().replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function leadingModulePurpose(source) {
  const match = /^\s*\/\*\*([\s\S]*?)\*\//u.exec(source);
  if (!match) return "TypeScript Agent tool module.";
  return match[1]
    .split(/\r?\n/u)
    .map((line) => line.replace(/^\s*\* ?/u, "").trim())
    .filter(Boolean)
    .join(" ");
}

function importedModules(source) {
  const imports = [];
  const pattern = /\bfrom\s+["']([^"']+)["']/gu;
  for (const match of source.matchAll(pattern)) imports.push(match[1]);
  return [...new Set(imports)].sort((a, b) => a.localeCompare(b));
}

function staticStringConstants(source) {
  const constants = new Map();
  const pattern = /\b(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*(["'])([^"'\r\n]+)\2\s*;/gu;
  for (const match of source.matchAll(pattern)) constants.set(match[1], match[3]);
  return constants;
}

function codeMask(source) {
  const mask = new Array(source.length).fill(true);
  let state = "code";
  let regexClass = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (state === "line") {
      mask[i] = false;
      if (char === "\n") state = "code";
    } else if (state === "block") {
      mask[i] = false;
      if (char === "*" && next === "/") {
        mask[i + 1] = false;
        i += 1;
        state = "code";
      }
    } else if (state === "regex") {
      mask[i] = false;
      if (char === "\\") {
        if (i + 1 < source.length) mask[++i] = false;
      } else if (char === "[") {
        regexClass = true;
      } else if (char === "]") {
        regexClass = false;
      } else if (char === "/" && !regexClass) {
        state = "code";
      }
    } else if (state === "single" || state === "double" || state === "template") {
      mask[i] = false;
      if (char === "\\") {
        if (i + 1 < source.length) mask[++i] = false;
      } else if (
        (state === "single" && char === "'") ||
        (state === "double" && char === '"') ||
        (state === "template" && char === "`")
      ) {
        state = "code";
      }
    } else if (char === "/" && next === "/") {
      mask[i] = false;
      mask[i + 1] = false;
      i += 1;
      state = "line";
    } else if (char === "/" && next === "*") {
      mask[i] = false;
      mask[i + 1] = false;
      i += 1;
      state = "block";
    } else if (char === "/" && regexCanStart(source, i)) {
      mask[i] = false;
      regexClass = false;
      state = "regex";
    } else if (char === "'") {
      mask[i] = false;
      state = "single";
    } else if (char === '"') {
      mask[i] = false;
      state = "double";
    } else if (char === "`") {
      mask[i] = false;
      state = "template";
    }
  }
  return mask;
}

function regexCanStart(source, position) {
  let previous = position - 1;
  while (previous >= 0 && /\s/u.test(source[previous])) previous -= 1;
  if (previous < 0) return true;
  return /[([{,:;=!?&|]/u.test(source[previous]);
}

function matchingDelimiter(source, mask, start, open, close) {
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    if (!mask[i]) continue;
    if (source[i] === open) depth += 1;
    else if (source[i] === close && --depth === 0) return i;
  }
  return -1;
}

function objectRanges(source, mask) {
  const stack = [];
  const ranges = [];
  for (let i = 0; i < source.length; i += 1) {
    if (!mask[i]) continue;
    if (source[i] === "{") stack.push(i);
    else if (source[i] === "}" && stack.length > 0) ranges.push({ start: stack.pop(), end: i });
  }
  return ranges;
}

function enclosingObject(ranges, position) {
  return ranges
    .filter((range) => range.start < position && position < range.end)
    .sort((a, b) => b.start - a.start)[0];
}

function propertyExpression(source, mask, range, key) {
  const pattern = new RegExp(`\\b${key}\\s*:`, "gu");
  pattern.lastIndex = range.start + 1;
  for (let match = pattern.exec(source); match && match.index < range.end; match = pattern.exec(source)) {
    if (!mask[match.index]) continue;
    let curly = 1;
    let square = 0;
    let round = 0;
    for (let i = range.start + 1; i < match.index; i += 1) {
      if (!mask[i]) continue;
      if (source[i] === "{") curly += 1;
      else if (source[i] === "}") curly -= 1;
      else if (source[i] === "[") square += 1;
      else if (source[i] === "]") square -= 1;
      else if (source[i] === "(") round += 1;
      else if (source[i] === ")") round -= 1;
    }
    if (curly !== 1 || square !== 0 || round !== 0) continue;
    const colon = source.indexOf(":", match.index);
    const valueStart = colon + 1;
    curly = 1;
    square = 0;
    round = 0;
    for (let i = valueStart; i < range.end; i += 1) {
      if (!mask[i]) continue;
      const char = source[i];
      if (char === "{") curly += 1;
      else if (char === "}") curly -= 1;
      else if (char === "[") square += 1;
      else if (char === "]") square -= 1;
      else if (char === "(") round += 1;
      else if (char === ")") round -= 1;
      if (char === "," && curly === 1 && square === 0 && round === 0) {
        return source.slice(valueStart, i).trim();
      }
    }
  }
  return null;
}

function evaluateStaticString(expression, constants) {
  if (expression === null) return null;
  const identifier = /^[A-Z][A-Z0-9_]*$/u.exec(expression);
  if (identifier) return constants.get(identifier[0]) ?? null;
  const parts = expression.split(/\s*\+\s*/u);
  const values = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (/^"(?:[^"\\]|\\.)*"$/u.test(trimmed)) {
      values.push(JSON.parse(trimmed));
    } else if (/^'(?:[^'\\]|\\.)*'$/u.test(trimmed)) {
      values.push(trimmed.slice(1, -1).replace(/\\'/gu, "'").replace(/\\\\/gu, "\\"));
    } else if (constants.has(trimmed)) {
      values.push(constants.get(trimmed));
    } else {
      return null;
    }
  }
  return values.join("");
}

function exportedFactories(source, mask) {
  const factories = [];
  const pattern = /\bexport\s+(?:async\s+)?function\s+(create[A-Za-z0-9]+Tools?)\s*\(/gu;
  for (const match of source.matchAll(pattern)) {
    const open = source.indexOf("(", match.index);
    const close = matchingDelimiter(source, mask, open, "(", ")");
    if (close === -1) continue;
    factories.push({
      name: match[1],
      signature: source.slice(match.index, close + 1).replace(/\s+/gu, " ").trim(),
    });
  }
  return factories;
}

function extractTools(source, mask, constants) {
  const ranges = objectRanges(source, mask);
  const byName = new Map();
  const pattern = /\bname\s*:\s*([A-Z][A-Z0-9_]*|"[a-z][a-z0-9_]*"|'[a-z][a-z0-9_]*')\s*,/gu;
  for (const match of source.matchAll(pattern)) {
    const range = enclosingObject(ranges, match.index);
    if (range === undefined) continue;
    const descriptionExpression = propertyExpression(source, mask, range, "description");
    if (descriptionExpression === null) continue;
    const rawName = match[1];
    const name = rawName.startsWith('"') || rawName.startsWith("'")
      ? rawName.slice(1, -1)
      : constants.get(rawName);
    if (name === undefined) continue;
    const description = evaluateStaticString(descriptionExpression, constants) ?? descriptionExpression;
    const parameters = propertyExpression(source, mask, range, "parameters");
    byName.set(name, {
      name,
      description,
      parametersSource: parameters ?? "由共享工厂提供；请参见本模块源码与工厂签名。",
    });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function scanToolModules(toolsRoot) {
  let filenames;
  try {
    filenames = await readdir(toolsRoot);
  } catch {
    return [];
  }
  const modules = [];
  for (const filename of filenames.filter((name) => name.endsWith(".ts")).sort()) {
    const sourcePath = path.join(toolsRoot, filename);
    const source = await readFile(sourcePath, "utf8");
    if (!source.includes("BioMedAgentTool")) continue;
    const mask = codeMask(source);
    const constants = staticStringConstants(source);
    const tools = extractTools(source, mask, constants);
    const factories = exportedFactories(source, mask);
    if (tools.length === 0 || factories.length === 0) continue;
    const moduleName = filename.replace(/\.ts$/u, "");
    modules.push({
      moduleName,
      slug: slug(moduleName),
      purpose: leadingModulePurpose(source),
      sourcePath,
      imports: importedModules(source),
      factories,
      tools,
    });
  }
  return modules;
}

export function renderToolkitDoc(entry) {
  const factory = entry.factories.find((item) => item.name.endsWith("Tools")) ?? entry.factories[0];
  const toolSections = entry.tools.map((tool) => `### \`${tool.name}\`

${tool.description}

#### 参数

\`\`\`ts
${tool.parametersSource}
\`\`\`

#### 返回值

\`execute\` 返回 \`Promise<BioMedToolResult>\`：\`content\` 是提供给 Agent 的字符串，\`details\` 保留结构化结果，失败时设置 \`isError: true\`。
`).join("\n");
  const imports = entry.imports.map((dependency) => `- \`${dependency}\``).join("\n");
  const factories = entry.factories.map((item) => `- \`${item.signature}\``).join("\n");
  const invocations = entry.tools.map((tool) => `### \`${tool.name}\`

\`\`\`ts
import { ${factory.name} } from "./server/src/agent/tools/${entry.moduleName}.js";

const dependencies = /* 按工厂签名注入 task-scoped 依赖 */;
const argumentsValue = /* 按该工具 parameters schema 提供参数 */;
const created = await ${factory.name}(dependencies);
const tools = Array.isArray(created) ? created : [created];
const tool = tools.find((candidate) => candidate.name === ${JSON.stringify(tool.name)});
if (tool === undefined) throw new Error("tool is unavailable for the supplied capabilities");
const result = await tool.execute(argumentsValue, undefined, { toolCallId: "standalone-call" });
if (result.isError) throw new Error(result.content);
console.log(result.details ?? result.content);
\`\`\`
`).join("\n");
  return `# ${entry.moduleName}

> source: \`server/src/agent/tools/${path.basename(entry.sourcePath)}\`

## 用途

${entry.purpose}

## 工具

${toolSections}
## 依赖

工厂签名：

${factories}

源码导入：

${imports || "- （无外部导入）"}

依赖必须由调用方显式注入；不要在独立脚本中绕过 Task workspace、网络策略、HIL 或 Dataset Core 边界。

## 独立调用方式

在仓库根目录的 TypeScript/tsx 脚本中调用，不需要启动完整 Host：

${invocations}
`;
}

export function renderToolkitIndex(entries) {
  const rows = entries
    .map((entry) => `| [${entry.moduleName}](./${encodeURIComponent(entry.slug)}.md) | ${entry.tools.map((tool) => `\`${tool.name}\``).join(", ")} |`)
    .join("\n");
  return `# BioMed-QAgent 可拆卸工具包

> 由 \`scripts/solidify-run.mjs --toolkit\` 从 \`server/src/agent/tools/\` 的
> TypeScript 工具事实生成。每个模块一份独立调用文档，不复制 \`SKILL.md\`。

| 工具模块 | 工具名 |
| --- | --- |
${rows || "| _(空)_ |" }

生成命令:
\`\`\`bash
node scripts/solidify-run.mjs --toolkit docs/toolkit
\`\`\`
`;
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
  const modules = await scanToolModules(TOOLS_ROOT);
  if (modules.length === 0) fail(`未在 ${TOOLS_ROOT} 找到任何静态 TS 工具定义`);
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "README.md"), renderToolkitIndex(modules));
  for (const entry of modules) {
    await writeFile(path.join(outDir, `${entry.slug}.md`), renderToolkitDoc(entry));
  }
  const toolCount = modules.reduce((total, entry) => total + entry.tools.length, 0);
  console.log(`已生成可拆卸工具包: ${outDir}（${modules.length} 个模块 / ${toolCount} 个工具 + README.md）`);
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
