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
const sourcesPath = resolve(root, spec.source_inventory);
const sources = json(sourcesPath);
const requestId = options.requestId ?? `gold-v1-${options.caseId}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;

/**
 * Derives the frozen ``execution_context`` for the wire request from the
 * frozen files on disk (manifest/case/prompt/runtime-profile hashes plus the
 * case + sources content). ``success_definition``/``forbidden_shortcuts`` are
 * frozen in the case spec; a case that ever omits them must fail here instead
 * of being silently downgraded.
 */
const SELECTION_CHECKLIST_KEYS = new Set(["required_content", "derived_content", "required_relations"]);
function frozenField(value, label) {
  if (typeof value !== "string" || value.trim() === "") fail(`frozen case is missing ${label}: ${options.caseId}`);
  return value;
}
function frozenStringList(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
    fail(`frozen case has an invalid ${label}: ${options.caseId}`);
  }
  return value;
}
function sourceSelection(constraints, label) {
  const selection = {};
  for (const [key, value] of Object.entries(constraints ?? {})) {
    if (SELECTION_CHECKLIST_KEYS.has(key)) continue;
    if (typeof value === "string" && value !== "") selection[key] = [value];
    else if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item !== "")) {
      selection[key] = value;
    } else fail(`unsupported selection constraint "${key}" in ${label}`);
  }
  return selection;
}
const executionContext = {
  schema_version: "1.0",
  kind: "frozen_evaluation",
  manifest_id: manifest.manifest_id,
  case_id: options.caseId,
  manifest_sha256: sha256(manifestPath),
  case_spec_sha256: sha256(specPath),
  prompt_sha256: sha256(promptPath),
  runtime_profile_sha256: sha256(join(root, manifest.runtime_profile)),
  expected_family: frozenField(spec.expected_family, "expected_family"),
  required_tables: frozenStringList(spec.required_tables, "required_tables"),
  allowed_sources: frozenStringList(spec.allowed_sources, "allowed_sources"),
  source_selection: sourceSelection(sources.selection_constraints, spec.source_inventory),
  success_definition: frozenField(spec.success_definition, "success_definition"),
  forbidden_shortcuts: frozenStringList(spec.forbidden_shortcuts, "forbidden_shortcuts"),
};
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
    body: JSON.stringify({
      request_id: requestId,
      input: prompt,
      databases: [],
      mode: "agent",
      execution_context: executionContext,
    }),
  });
  const body = await response.text();
  if (!response.ok) fail(`HTTP ${response.status} ${response.statusText}: ${body.slice(0, 800)}`);
  accepted = JSON.parse(body);
}
const result = { ...identity, execution_context: executionContext, dry_run: options.dryRun, accepted };
const serialized = `${JSON.stringify(result, null, 2)}\n`;
if (options.output !== null) writeFileSync(options.output, serialized, { encoding: "utf8", flag: "wx" });
process.stdout.write(serialized);
