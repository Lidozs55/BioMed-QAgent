#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const USAGE = `
Usage:
  node scripts/run-driver.mjs submit <taskId> --input <path> [options]
  node scripts/run-driver.mjs snapshot <taskId> [options]

Submit a run to an existing task from a UTF-8 input file, or show the current
run list of a task.

Options:
  --input <path>      Input text file (byte-validated as UTF-8 before submit)
  --request-id <id>   Explicit request id (default: run-<epoch36>-<random>)
  --base-url <url>    Server base URL (default: http://127.0.0.1:5173)
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

async function submit(baseUrl, taskId, inputPath, requestId) {
  const input = readUtf8Input(inputPath);
  const response = await fetch(`${baseUrl}/api/v1/tasks/${taskId}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ request_id: requestId, input }),
  });
  const body = await response.text();
  if (!response.ok) {
    fail(`HTTP ${response.status} ${response.statusText}: ${body.slice(0, 800)}`);
  }
  console.log(`[run-driver] HTTP ${response.status}`);
  console.log(body);
}

async function snapshot(baseUrl, taskId) {
  const response = await fetch(`${baseUrl}/api/v1/tasks/${taskId}`);
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

function parseArgs(argv) {
  const args = { mode: "submit", baseUrl: "http://127.0.0.1:5173", input: null, requestId: null };
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
    } else {
      positional.push(arg);
    }
  }
  if (positional[0] === "submit" || positional[0] === "snapshot") {
    args.mode = positional[0];
    args.taskId = positional[1];
  } else {
    args.taskId = positional[0];
  }
  if (args.taskId === undefined) {
    fail(`missing <taskId>\n\n${USAGE}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "snapshot") {
    await snapshot(args.baseUrl, args.taskId);
    return;
  }
  if (args.input === null) {
    fail(`--input <path> is required for submit\n\n${USAGE}`);
  }
  const requestId = args.requestId ?? `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  await submit(args.baseUrl, args.taskId, args.input, requestId);
}

main().catch((error) => {
  console.error(`[run-driver] driver error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});