#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(root, "manifest.json");
const runtimePath = join(root, "runtime-defaults.json");
const checksumPath = join(root, "checksums.sha256");
const expectedRuntime = {
  command_timeout_seconds: 600,
  command_output_kib: 256,
  workspace_read_kib: 256,
  workspace_write_kib: 1024,
  workspace_search_file_mib: 16,
  workspace_search_max_files: 2000,
  http_timeout_seconds: 300,
  download_timeout_seconds: 3600,
  browser_timeout_seconds: 300,
  dataset_operation_timeout_seconds: 3600,
  database_timeout_seconds: 600,
  max_download_mib: 8192,
  gdc_max_files: 50,
  request_interval_ms: 500,
};

function fail(message) {
  throw new Error(message);
}
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`invalid JSON ${relative(root, path)}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function pathInside(relativePath) {
  const candidate = resolve(root, relativePath);
  const rootPath = resolve(root);
  if (candidate !== rootPath && !candidate.startsWith(`${rootPath}/`) && !candidate.startsWith(`${rootPath}\\`)) {
    fail(`path escapes gold-v1: ${relativePath}`);
  }
  return candidate;
}
function requiredFile(relativePath) {
  const path = pathInside(relativePath);
  if (!statSafe(path)?.isFile()) fail(`missing referenced file: ${relativePath}`);
  return path;
}
function statSafe(path) {
  try { return statSync(path); } catch { return null; }
}
function walk(directory) {
  const entries = readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return walk(path);
    return [path];
  });
}
function assertSha(value, label) {
  if (!/^[0-9a-f]{64}$/.test(value)) fail(`${label} must be a lowercase SHA-256`);
}

function verify() {
  const manifest = readJson(manifestPath);
  const runtime = readJson(runtimePath);
  if (manifest.manifest_id !== "gold-v1" || manifest.manifest_version !== 1) fail("unexpected manifest identity");
  if (manifest.strict_result?.passed !== 0 || manifest.strict_result?.total !== 6) fail("strict result must remain 0/6 until G1");
  if (runtime.node_heap_override !== null) fail("Gold runtime cannot use a Node heap override");
  for (const [key, expected] of Object.entries(expectedRuntime)) {
    if (runtime.limits?.[key] !== expected) fail(`runtime default drift: ${key}`);
  }
  if (manifest.cases?.length !== 6) fail("manifest must contain exactly six cases");
  const seen = new Set();
  for (const entry of manifest.cases) {
    if (seen.has(entry.case_id)) fail(`duplicate case: ${entry.case_id}`);
    seen.add(entry.case_id);
    const specPath = requiredFile(entry.spec);
    const spec = readJson(specPath);
    if (spec.case_id !== entry.case_id) fail(`case ID mismatch in ${entry.spec}`);
    const promptPath = requiredFile(spec.prompt_file);
    const promptBytes = readFileSync(promptPath);
    const prompt = promptBytes.toString("utf8");
    if (Buffer.from(prompt, "utf8").compare(promptBytes) !== 0) fail(`prompt is not canonical UTF-8: ${spec.prompt_file}`);
    if (prompt.includes("\uFFFD") || /\?{4,}/.test(prompt)) fail(`corrupted prompt signature: ${spec.prompt_file}`);
    assertSha(spec.prompt_sha256, `${entry.case_id}.prompt_sha256`);
    if (sha256(promptPath) !== spec.prompt_sha256) fail(`prompt hash mismatch: ${spec.prompt_file}`);
    for (const reference of [spec.schema_ref, spec.source_inventory, spec.historical_evidence]) requiredFile(reference);
    const schema = readJson(pathInside(spec.schema_ref));
    if (schema.family !== spec.expected_family || !Array.isArray(schema.tables) || schema.tables.length === 0) fail(`invalid schema reference: ${spec.schema_ref}`);
    const source = readJson(pathInside(spec.source_inventory));
    if (source.case_id !== entry.case_id || !Array.isArray(source.allowed_providers)) fail(`invalid source inventory: ${spec.source_inventory}`);
    // Fields feeding the run's frozen execution_context (run-case.mjs) must be
    // well-formed for every case, not only the one being invoked.
    if (typeof spec.expected_family !== "string" || spec.expected_family === "") fail(`invalid expected_family: ${entry.case_id}`);
    if (!Array.isArray(spec.allowed_sources) || spec.allowed_sources.some((item) => typeof item !== "string" || item === "")) fail(`invalid allowed_sources: ${entry.case_id}`);
    if (
      !Array.isArray(spec.required_tables) || spec.required_tables.length === 0 ||
      spec.required_tables.some((item) => typeof item !== "string" || item === "") ||
      new Set(spec.required_tables).size !== spec.required_tables.length
    ) fail(`invalid required_tables: ${entry.case_id}`);
    if (typeof spec.success_definition !== "string" || spec.success_definition.trim() === "") fail(`invalid success_definition: ${entry.case_id}`);
    if (!Array.isArray(spec.forbidden_shortcuts) || spec.forbidden_shortcuts.some((item) => typeof item !== "string" || item === "")) fail(`invalid forbidden_shortcuts: ${entry.case_id}`);
    for (const anchor of source.historical_content_anchors ?? []) {
      if (anchor.status === "historical_only") {
        if (!Number.isInteger(anchor.bytes) || anchor.bytes <= 0) fail(`historical anchor missing bytes: ${anchor.asset_id}`);
        assertSha(anchor.sha256, `${anchor.asset_id}.sha256`);
      }
    }
    const historical = readJson(pathInside(spec.historical_evidence));
    if (historical.admissible_as_current_evidence !== false) fail(`historical evidence must be inadmissible: ${entry.case_id}`);
  }
  if (seen.size !== 6) fail("case IDs are incomplete");
  const writeChecksums = process.argv.includes("--write-checksums");
  if (writeChecksums) {
    const files = walk(root).filter((path) => normalize(path) !== normalize(checksumPath)).sort();
    const content = files.map((path) => `${sha256(path)}  ${relative(root, path).replaceAll("\\", "/")}`).join("\n");
    writeFileSync(checksumPath, `${content}\n`, "utf8");
  }
  if (statSafe(checksumPath)?.isFile()) {
    const lines = readFileSync(checksumPath, "utf8").trim().split(/\r?\n/).filter(Boolean);
    const expectedFiles = walk(root).filter((path) => normalize(path) !== normalize(checksumPath)).sort();
    const actual = new Map();
    for (const line of lines) {
      const match = /^(\w{64})  (.+)$/.exec(line);
      if (!match) fail(`invalid checksum line: ${line}`);
      actual.set(match[2], match[1]);
    }
    const expectedNames = expectedFiles.map((path) => relative(root, path).replaceAll("\\", "/"));
    if (actual.size !== expectedNames.length || expectedNames.some((name) => !actual.has(name))) fail("checksum inventory does not cover exactly gold-v1 files");
    for (const path of expectedFiles) {
      const name = relative(root, path).replaceAll("\\", "/");
      if (sha256(path) !== actual.get(name)) fail(`checksum mismatch: ${name}`);
    }
  } else {
    console.warn("checksums.sha256 not found; run the checksum generation step before commit");
  }
  console.log(`gold-v1 verified: ${seen.size} cases, strict result ${manifest.strict_result.passed}/${manifest.strict_result.total}`);
}

try { verify(); } catch (error) { console.error(`[gold-v1] ${error instanceof Error ? error.message : String(error)}`); process.exit(1); }
