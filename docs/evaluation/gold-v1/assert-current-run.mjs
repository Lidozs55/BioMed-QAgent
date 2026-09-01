#!/usr/bin/env node
/**
 * Asserts that one saved Gold6 run (the JSON written by ``run-case.mjs
 * gold6 --output <file>``) closes the frozen evaluation on the CURRENT commit
 * with live evidence: unchanged frozen context, current product commit, all
 * three frozen PMCIDs acquired as current-task registered carriers, the six
 * required tables in one immutable Publication, accepted/corrected chart
 * estimates with durable review ids, one resolved publication_acceptance
 * review, and Artifact API bytes that re-hash to their receipts.
 *
 * Usage:
 *   node docs/evaluation/gold-v1/assert-current-run.mjs <run-result.json> \
 *     [--base-url URL]
 *
 * Exits 0 only when every assertion holds; every failure is printed as
 * ``[gold-v1] REJECT: ...`` and the process exits 1.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

import { fetchAllTaskEvents } from "../../../scripts/gold-formal-supervisor.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const usage =
  "Usage: node docs/evaluation/gold-v1/assert-current-run.mjs <run-result.json> [--base-url URL]";

const rejections = [];
function reject(message) {
  rejections.push(message);
}
function fail(message) {
  console.error(`[gold-v1] ${message}`);
  process.exit(1);
}
function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function args(argv) {
  const parsed = { resultFile: argv[0], baseUrl: null };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base-url") parsed.baseUrl = argv[++index];
    else if (arg === "-h" || arg === "--help") { console.log(usage); process.exit(0); }
    else fail(`unknown argument: ${arg}\n${usage}`);
  }
  if (!parsed.resultFile) fail(`result file is required\n${usage}`);
  return parsed;
}

async function getJson(base, path) {
  const response = await fetch(`${base}${path}`);
  if (!response.ok) throw new Error(`GET ${path} failed: HTTP ${response.status}`);
  return response.json();
}

async function getBytes(base, path) {
  const response = await fetch(`${base}${path}`);
  if (!response.ok) throw new Error(`GET ${path} failed: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Minimal RFC 4180 CSV reader for assertions (quoted cells, CRLF or LF). */
function parseCsv(text) {
  const rows = [];
  for (const line of text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n")) {
    const cells = [];
    let current = "";
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (quoted) {
        if (char === '"' && line[index + 1] === '"') { current += '"'; index += 1; }
        else if (char === '"') quoted = false;
        else current += char;
      } else if (char === '"') quoted = true;
      else if (char === ",") { cells.push(current); current = ""; }
      else current += char;
    }
    cells.push(current);
    rows.push(cells);
  }
  const header = rows[0] ?? [];
  return rows.slice(1).map((row) => Object.fromEntries(header.map((name, index) => [name, row[index] ?? ""])));
}

const options = args(process.argv.slice(2));
const result = JSON.parse(readFileSync(resolve(options.resultFile), "utf8"));
const baseUrl = options.baseUrl ?? result.base_url ?? "http://127.0.0.1:5173";

// -- 1. Commit and frozen-context hashes must match the CURRENT frozen files.
const currentCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (result.product_commit !== currentCommit) {
  reject(`commit mismatch: run recorded ${result.product_commit}, current HEAD is ${currentCommit}`);
}
const manifestPath = join(root, "manifest.json");
const caseSpecPath = join(root, "cases", "gold6.json");
const runtimeProfilePath = join(root, "runtime-defaults.json");
const promptPath = join(root, "prompts", "gold6.txt");
const manifestSha = sha256(manifestPath);
const caseSpecSha = sha256(caseSpecPath);
const promptSha = sha256(promptPath);
const runtimeProfileSha = sha256(runtimeProfilePath);
const context = result.execution_context;
if (context === undefined || context === null) {
  reject("run result carries no execution_context");
} else {
  if (context.manifest_sha256 !== manifestSha) reject("execution_context.manifest_sha256 does not match the frozen manifest");
  if (context.case_spec_sha256 !== caseSpecSha) reject("execution_context.case_spec_sha256 does not match the frozen case");
  if (context.prompt_sha256 !== promptSha) reject("execution_context.prompt_sha256 does not match the frozen prompt");
  if (context.runtime_profile_sha256 !== runtimeProfileSha) reject("execution_context.runtime_profile_sha256 does not match the frozen runtime profile");
  if (result.prompt_sha256 !== undefined && result.prompt_sha256 !== promptSha) reject("result.prompt_sha256 does not match the frozen prompt");
}

const caseSpec = JSON.parse(readFileSync(caseSpecPath, "utf8"));
const requiredTables = caseSpec.required_tables;
const PMCIDS = JSON.parse(readFileSync(join(root, "sources", "gold6.sources.json"), "utf8"))
  .selection_constraints.papers;

// -- 2. The accepted task/run must exist and be terminal-successful. The
// remaining sections need a reachable Host; skip them when there is no task
// (their failure modes are already covered by the rejections above).
const accepted = result.accepted;
let taskId = null;
let runId = null;
let liveTask = false;
if (accepted === null || accepted === undefined) {
  reject("run result has no accepted task (dry-run or failed submission)");
} else {
  taskId = accepted.task_id;
  runId = accepted.run_id;
  const snapshot = await getJson(baseUrl, `/api/v1/tasks/${taskId}`).catch((error) => {
    reject(`task snapshot unavailable: ${error.message}`);
    return null;
  });
  liveTask = snapshot !== null;
  if (snapshot !== null) {
    if (snapshot.task.status !== "completed") {
      reject(`task status is ${snapshot.task.status}, expected completed`);
    }
    const run = (snapshot.runs ?? []).find((candidate) => candidate.run_id === runId);
    if (run === undefined) reject(`run ${runId} not found on task ${taskId}`);
    else if (run.status !== "completed") reject(`run status is ${run.status}, expected completed`);

    // -- 3. The persisted run must carry the exact frozen execution context.
    const persisted = run.execution_context;
    if (persisted === null || persisted === undefined) reject("run carries no persisted execution_context");
    else {
      for (const [field, expected] of [
        ["manifest_sha256", manifestSha],
        ["case_spec_sha256", caseSpecSha],
        ["prompt_sha256", promptSha],
        ["runtime_profile_sha256", runtimeProfileSha],
      ]) {
        if (persisted[field] !== expected) reject(`persisted execution_context.${field} does not match the frozen file`);
      }
      if (JSON.stringify(persisted.required_tables) !== JSON.stringify(requiredTables)) {
        reject("persisted execution_context.required_tables does not match the frozen case");
      }
    }
  }
}

// -- 4. Event evidence: one publication, resolved acceptance review, and
// current-task carrier acquisitions for every frozen PMCID.
const events = liveTask
  ? await fetchAllTaskEvents(baseUrl, taskId)
  : [];
const publicationsCreated = events.filter((event) => event.payload.type === "publication_created");
if (liveTask && publicationsCreated.length !== 1) {
  reject(`expected exactly one publication_created event, found ${publicationsCreated.length}`);
}
if (liveTask) {
  const acceptanceRequests = events
    .filter((event) => event.payload.type === "user_input_required")
    .map((event) => event.payload.hil_request)
    .filter((request) => request !== null && request !== undefined && request.review_type === "publication_acceptance");
  if (acceptanceRequests.length !== 1) {
    reject(`expected exactly one publication_acceptance review request, found ${acceptanceRequests.length}`);
  }
  const resumedIds = new Set(events
    .filter((event) => event.payload.type === "user_input_resumed")
    .map((event) => event.payload.request_id));
  for (const request of acceptanceRequests) {
    if (!resumedIds.has(request.request_id)) reject(`publication_acceptance review ${request.request_id} was never resolved`);
  }
  const runEvents = events.filter((event) => event.run_id === runId);
  for (const pmcid of PMCIDS) {
    const coverage = runEvents.some((event) => JSON.stringify(event.payload).includes(pmcid));
    if (!coverage) reject(`frozen PMCID ${pmcid} appears nowhere in the run evidence`);
  }
}
const toolOutputText = events
  .filter((event) => event.payload.type === "tool_completed")
  .map((event) => String(event.payload.output ?? ""))
  .join("\n");

// -- 5. Publication manifest: immutable receipt plus the six required tables.
let manifestJson = null;
if (liveTask) {
  const list = await getJson(baseUrl, `/api/v1/tasks/${taskId}/artifacts`);
  const datasetManifest = (list.artifacts ?? []).find((artifact) => artifact.name === "dataset_manifest.json");
  if (datasetManifest === undefined) reject("Artifact API lists no dataset_manifest.json");
  else {
    const bytes = await getBytes(baseUrl, `/api/v1/tasks/${taskId}/artifacts/${datasetManifest.artifact_id}`);
    if (sha256(bytes) !== datasetManifest.sha256) reject("dataset_manifest.json bytes do not hash to its Artifact API receipt");
    manifestJson = JSON.parse(bytes.toString("utf8"));
    if (publicationsCreated[0] !== undefined && publicationsCreated[0].payload.manifest_sha256 !== manifestJson.sha256) {
      reject("publication_created.manifest_sha256 does not match the published dataset manifest");
    }
  }
}
if (manifestJson !== null) {
  const tableIds = (manifestJson.tables ?? []).map((table) => table.table_id).sort();
  for (const required of requiredTables.sort()) {
    if (!tableIds.includes(required)) reject(`published manifest is missing required table ${required}`);
  }
}

// -- 6. Every declared artifact must download and re-hash to its receipt.
if (liveTask) {
  const list = await getJson(baseUrl, `/api/v1/tasks/${taskId}/artifacts`);
  const byName = new Map((list.artifacts ?? []).map((artifact) => [artifact.name, artifact]));
  for (const artifact of manifestJson?.artifacts ?? []) {
    const name = artifact.relative_path.split("/").at(-1);
    const listed = byName.get(name);
    if (listed === undefined) {
      reject(`artifact ${artifact.relative_path} is not served by the Artifact API`);
      continue;
    }
    const bytes = await getBytes(baseUrl, `/api/v1/tasks/${taskId}/artifacts/${listed.artifact_id}`);
    if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) {
      reject(`artifact ${artifact.relative_path} bytes do not hash to its manifest receipt`);
    }
  }
}

// -- 7. Published content: PMCID coverage, review-closed estimates, review ids.
function publishedTable(name) {
  const entry = (manifestJson?.artifacts ?? []).find((artifact) => artifact.relative_path === `tables/${name}.csv`);
  if (entry === undefined) {
    reject(`published tables are missing ${name}.csv`);
    return null;
  }
  return entry;
}
const paperRecordsEntry = publishedTable("paper_records");
const chartPointsEntry = publishedTable("chart_points");
if (liveTask && paperRecordsEntry !== null && chartPointsEntry !== null) {
  const list = await getJson(baseUrl, `/api/v1/tasks/${taskId}/artifacts`);
  const byName = new Map((list.artifacts ?? []).map((artifact) => [artifact.name, artifact]));
  const download = async (entry) => {
    const listed = byName.get(entry.relative_path.split("/").at(-1));
    const bytes = await getBytes(baseUrl, `/api/v1/tasks/${taskId}/artifacts/${listed.artifact_id}`);
    return parseCsv(bytes.toString("utf8"));
  };
  const paperRows = await download(paperRecordsEntry);
  const publishedPmcids = new Set(paperRows.map((row) => row.pmcid).filter((value) => value !== ""));
  for (const pmcid of PMCIDS) {
    if (!publishedPmcids.has(pmcid)) reject(`published paper_records is missing frozen PMCID ${pmcid}`);
  }
  const pointRows = await download(chartPointsEntry);
  if (pointRows.length === 0) reject("published chart_points table is empty");
  for (const [index, row] of pointRows.entries()) {
    if (row.review_status !== "accepted" && row.review_status !== "corrected") {
      reject(`chart_points row ${index + 1} has review_status '${row.review_status}'; pending/rejected estimates must never publish`);
    }
    if ((row.review_id ?? "") === "") reject(`chart_points row ${index + 1} has no durable review id`);
    if (row.review_status === "corrected" && ((row.original_x_value ?? "") === "" || (row.original_y_value ?? "") === "")) {
      reject(`chart_points row ${index + 1} is corrected but does not preserve its original values`);
    }
  }
}

// -- 8. Source receipts must come from THIS task's own acquisitions (never
// stale asset ids copied from an earlier run).
if (liveTask && manifestJson !== null) {
  const sourceAssetIds = Object.values(manifestJson.source_summary ?? {})
    .map((source) => source.asset_id)
    .filter((value) => typeof value === "string");
  for (const assetId of sourceAssetIds) {
    if (!toolOutputText.includes(assetId) && !events.some((event) => JSON.stringify(event.payload).includes(assetId))) {
      reject(`source receipt ${assetId} is not evidenced by this run (stale source receipt)`);
    }
  }
}

if (rejections.length > 0) {
  for (const message of rejections) console.error(`[gold-v1] REJECT: ${message}`);
  console.error(`[gold-v1] run ${taskId} rejected with ${rejections.length} problem(s)`);
  process.exit(1);
}
console.log(`[gold-v1] run ${taskId} (commit ${currentCommit}) passes current-commit Gold6 closure assertions`);
