#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const USAGE = `
Usage:
  node scripts/run-driver.mjs health [options]
  node scripts/run-driver.mjs create --input <path> [options]
  node scripts/run-driver.mjs submit <taskId> --input <path> [options]
  node scripts/run-driver.mjs snapshot <taskId> [options]
  node scripts/run-driver.mjs events <taskId> [options]

Small stdlib-only HTTP driver for agents. Input files are byte-validated UTF-8.

Options:
  --input <path>      Input text file (required by create/submit)
  --request-id <id>   Explicit request id (default: run-<epoch36>-<random>)
  --base-url <url>    Server base URL (default: http://127.0.0.1:5173)
  --after <sequence>  Events after durable sequence (default: 0)
  --limit <count>     Events page size, 1..1000 (default: 100)
  --retries <count>   Health attempts including 503 startup responses (default: 30)
  --delay-ms <ms>     Health retry delay (default: 500)
  -h, --help          Show this help
`.trim();

function fail(message) {
  console.error(`[run-driver] ${message}`);
  process.exit(1);
}

function isUtf8(bytes) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    decoder.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function readUtf8Input(path) {
  const bytes = readFileSync(path);
  if (!isUtf8(bytes)) {
    fail(
      `${path} is not valid UTF-8 bytes; re-encode the file as UTF-8 ` +
        "(the gold2 '?'-corruption class originates from decoding lossy text)",
    );
  }
  const text = bytes.toString("utf8");
  if (text.includes("\uFFFD")) {
    fail(`${path} contains the U+FFFD replacement character; the file is corrupted`);
  }
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
  if (loneSurrogate) {
    fail(`${path} contains lone UTF-16 surrogates; the file is corrupted`);
  }
  if (/\p{Script=Han}/u.test(text) && /\?{4,}/.test(text)) {
    console.warn(`[run-driver] warning: ${path} mixes Han text with '????' runs — ` +
      "this pattern matched the known gold2 encoding-corruption signature; " +
      "recheck the source before relying on this submission");
  }
  return text;
}

function endpoint(baseUrl, pathname) {
  return new URL(pathname, `${baseUrl.replace(/\/$/u, "")}/`).toString();
}

async function postInput(baseUrl, pathname, inputPath, requestId, createTask) {
  const input = readUtf8Input(inputPath);
  const payload = createTask
    ? { request_id: requestId, input, mode: "agent" }
    : { request_id: requestId, input };
  const response = await fetch(endpoint(baseUrl, pathname), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const responseBody = await response.text();
  if (!response.ok) {
    fail(`HTTP ${response.status} ${response.statusText}: ${responseBody.slice(0, 800)}`);
  }
  console.log(`[run-driver] HTTP ${response.status}`);
  console.log(responseBody);
}

async function health(baseUrl, retries, delayMs) {
  let last = "no response";
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(endpoint(baseUrl, "/api/v1/health"));
      const body = await response.text();
      last = `HTTP ${response.status}: ${body.slice(0, 400)}`;
      if (response.ok) {
        console.log(`[run-driver] ready after ${attempt} attempt(s)`);
        console.log(body);
        return;
      }
      if (response.status !== 503) break;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  fail(`health check failed after ${retries} attempt(s): ${last}`);
}

async function snapshot(baseUrl, taskId) {
  const response = await fetch(endpoint(baseUrl, `/api/v1/tasks/${encodeURIComponent(taskId)}`));
  if (!response.ok) {
    fail(`HTTP ${response.status} ${response.statusText}`);
  }
  const body = await response.json();
  const runs = (body.runs ?? []).map((run) => ({
    run_id: run.run_id,
    status: run.status,
    started_at: run.started_at,
    finished_at: run.finished_at,
    error: run.error ?? undefined,
  }));
  console.log(`[run-driver] active_run_id: ${body.task?.active_run_id ?? null}`);
  console.log(JSON.stringify(runs, null, 2));
}

async function events(baseUrl, taskId, after, limit) {
  const url = endpoint(baseUrl, `/api/v1/tasks/${encodeURIComponent(taskId)}/events`);
  const response = await fetch(`${url}?after_sequence=${after}&limit=${limit}`);
  const body = await response.text();
  if (!response.ok) fail(`HTTP ${response.status} ${response.statusText}: ${body.slice(0, 800)}`);
  console.log(body);
}

function nonNegativeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail(`${name} must be a non-negative safe integer`);
  return parsed;
}

function positiveInteger(value, name) {
  const parsed = nonNegativeInteger(value, name);
  if (parsed < 1) fail(`${name} must be at least 1`);
  return parsed;
}

function parseArgs(argv) {
  const args = {
    mode: "submit", baseUrl: "http://127.0.0.1:5173", input: null, requestId: null,
    after: 0, limit: 100, retries: 30, delayMs: 500,
  };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg === "--input") {
      args.input = argv[index + 1];
      index += 1;
    } else if (arg === "--request-id") {
      args.requestId = argv[index + 1];
      index += 1;
    } else if (arg === "--base-url") {
      args.baseUrl = argv[index + 1];
      index += 1;
    } else if (arg === "--after") {
      args.after = nonNegativeInteger(argv[index + 1], "--after");
      index += 1;
    } else if (arg === "--limit") {
      args.limit = positiveInteger(argv[index + 1], "--limit");
      if (args.limit > 1_000) fail("--limit must be at most 1000");
      index += 1;
    } else if (arg === "--retries") {
      args.retries = positiveInteger(argv[index + 1], "--retries");
      index += 1;
    } else if (arg === "--delay-ms") {
      args.delayMs = nonNegativeInteger(argv[index + 1], "--delay-ms");
      index += 1;
    } else {
      positional.push(arg);
    }
  }
  const commands = new Set(["health", "create", "submit", "snapshot", "events"]);
  if (commands.has(positional[0])) {
    args.mode = positional[0];
    args.taskId = positional[1];
  } else {
    args.taskId = positional[0];
  }
  if (!["health", "create"].includes(args.mode) && args.taskId === undefined) {
    fail(`missing <taskId>\n\n${USAGE}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "health") {
    await health(args.baseUrl, args.retries, args.delayMs);
    return;
  }
  if (args.mode === "snapshot") {
    await snapshot(args.baseUrl, args.taskId);
    return;
  }
  if (args.mode === "events") {
    await events(args.baseUrl, args.taskId, args.after, args.limit);
    return;
  }
  if (args.input === null) {
    fail(`--input <path> is required for ${args.mode}\n\n${USAGE}`);
  }
  const requestId = args.requestId ?? `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const pathname = args.mode === "create"
    ? "/api/v1/tasks"
    : `/api/v1/tasks/${encodeURIComponent(args.taskId)}/runs`;
  await postInput(args.baseUrl, pathname, args.input, requestId, args.mode === "create");
}

main().catch((error) => {
  console.error(`[run-driver] driver error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});