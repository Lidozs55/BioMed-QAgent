#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";

const root = dirname(fileURLToPath(import.meta.url));
const usage = "Usage: node docs/evaluation/gold-v1/run-case.mjs <gold1..gold6> [--base-url URL] [--request-id ID] [--output FILE] [--dry-run]";

function fail(message) {
  console.error(`[gold-v1] ${message}`);
  process.exit(1);
}
function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function args(argv) {
  const parsed = { caseId: argv[0], baseUrl: "http://127.0.0.1:5173", requestId: null, output: null, dryRun: false };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base-url") parsed.baseUrl = argv[++index];
    else if (arg === "--request-id") parsed.requestId = argv[++index];
    else if (arg === "--output") parsed.output = argv[++index];
    else if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "-h" || arg === "--help") { console.log(usage); process.exit(0); }
    else fail(`unknown argument: ${arg}\n${usage}`);
  }
  if (!/^gold[1-6]$/.test(parsed.caseId ?? "")) fail(`case must be gold1..gold6\n${usage}`);
  return parsed;
}
function json(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const options = args(process.argv.slice(2));
const verified = spawnSync(process.execPath, [join(root, "verify.mjs")], { encoding: "utf8" });
if (verified.status !== 0) fail(`manifest verification failed:\n${verified.stderr || verified.stdout}`);
const manifestPath = join(root, "manifest.json");
const manifest = json(manifestPath);
const entry = manifest.cases.find((item) => item.case_id === options.caseId);
if (entry === undefined) fail(`case is not in manifest: ${options.caseId}`);
const specPath = resolve(root, entry.spec);
const spec = json(specPath);
const promptPath = resolve(root, spec.prompt_file);
const prompt = readFileSync(promptPath, "utf8");
const requestId = options.requestId ?? `gold-v1-${options.caseId}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const identity = {
  manifest_id: manifest.manifest_id,
  manifest_version: manifest.manifest_version,
  manifest_sha256: sha256(manifestPath),
  case_id: options.caseId,
  case_spec_sha256: sha256(specPath),
  prompt_sha256: sha256(promptPath),
  runtime_profile_sha256: sha256(join(root, manifest.runtime_profile)),
  product_commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  request_id: requestId,
  base_url: options.baseUrl,
};
let accepted = null;
if (!options.dryRun) {
  const response = await fetch(`${options.baseUrl}/api/v1/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ request_id: requestId, input: prompt, databases: [], mode: "agent" }),
  });
  const body = await response.text();
  if (!response.ok) fail(`HTTP ${response.status} ${response.statusText}: ${body.slice(0, 800)}`);
  accepted = JSON.parse(body);
}
const result = { ...identity, dry_run: options.dryRun, accepted };
const serialized = `${JSON.stringify(result, null, 2)}\n`;
if (options.output !== null) writeFileSync(options.output, serialized, { encoding: "utf8", flag: "wx" });
process.stdout.write(serialized);
