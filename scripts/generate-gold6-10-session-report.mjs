#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_VERSION = "1.0.0";
const SCRIPT_PATH = fileURLToPath(import.meta.url);

const RUN_SPECS = [
  {
    key: "gold6-flash",
    displayName: "Gold6 Flash",
    goldCase: 6,
    promptKey: "gold6",
    runDir: "runs/gold6-flash",
    eventRel: "evidence/archive/task-events.authoritative.jsonl",
    mirrorEventRel: "evidence/events.jsonl",
    routeStateRel: "evidence/archive/task-state.semantic-route.json",
    semanticRouteFallback: "dynamic_family",
    publicationRoute: "dynamic_family",
    promptProvenance: "exact-data R3/R4/R7c3 lineage; frozen execution context, not the public gold-v1 fixture",
    terminalSummary: "Completed with a current publication after a superseded earlier publication.",
    paperUseNotes: [
      "Describe the current formal product as six CSV tables plus schema, provenance, and ProductAssessment (nine artifacts total); the phrase 'four-table chart product' is not supported by the manifest.",
      "The five HIL requests were three exact-only credential grants and two publication-acceptance decisions. No low-confidence point-correction or generic data-review HIL occurred in this run.",
      "Artifact SHA-256 verification proves byte integrity and receipt binding, not scientific correctness or complete coverage of all potentially relevant EGFR literature.",
    ],
  },
  {
    key: "gold7-flash",
    displayName: "Gold7 Flash",
    goldCase: 7,
    promptKey: "gold7",
    runDir: "runs/gold7-flash",
    eventRel: "evidence/events.jsonl",
    semanticRouteFallback: "dynamic_family",
    publicationRoute: "dynamic_family",
    promptProvenance: "reconstructed historical TOPIC prompt",
    terminalSummary: "Completed with two independent run-bound publications; the risk-loci publication is current.",
    paperUseNotes: [
      "Treat the risk-loci and variant-gene-map outputs as two independent Publications (five artifacts each), not as one three-table Publication and not as a v1-to-v2 superseding chain; both publication events have supersedes_publication_id=null.",
      "This corrected run contains two profile-scaffold calls, zero business HIL requests, and no evidence for the older '11 rejection-revision rounds' narrative. Keep that narrative historical unless its separate run is cited explicitly.",
      "The prompt is reconstructed historical TOPIC text, so the observed outcome is not an exact replay of an original Gold7 prompt.",
    ],
  },
  {
    key: "gold8-flash",
    displayName: "Gold8 Flash",
    goldCase: 8,
    promptKey: "gold8",
    runDir: "runs/gold8-flash",
    eventRel: "evidence/events.jsonl",
    semanticRouteFallback: "dynamic_family",
    publicationRoute: "dynamic_family",
    promptProvenance: "reconstructed historical TOPIC prompt",
    terminalSummary: "Completed with one byte-verified publication. Event-derived duration is authoritative because a monitor arithmetic field is inconsistent.",
    paperUseNotes: [
      "The formal Publication covers the openFDA FAERS assertion and study tables (five artifacts including schema/provenance/assessment). Other requested integration dimensions remained workspace staging; the run report records this as one of three evidence dimensions formally published.",
      "Use 2754.172 seconds from run_started to run_completed. The 2174.166-second monitor arithmetic value is inconsistent and must not appear in primary tables.",
      "The prompt is reconstructed historical TOPIC text; do not describe this as an exact original-prompt replay or as complete DILI multi-source coverage.",
    ],
  },
  {
    key: "gold9-flash",
    displayName: "Gold9 Flash",
    goldCase: 9,
    promptKey: "gold9",
    runDir: "runs/gold9-flash",
    eventRel: "evidence/archive/authoritative/task-events.jsonl",
    mirrorEventRel: "evidence/events.jsonl",
    routeStateRel: "evidence/archive/runtime-state/semantic-route.json",
    semanticRouteFallback: "dynamic_family",
    initialSemanticRoute: "static",
    publicationRoute: "dynamic_family",
    objectCompareRuntime: true,
    promptProvenance: "exact original run_queued.input recovered from historical durable events",
    terminalSummary: "Completed after a static-route attempt was reclassified to a dynamic-family publication path; publication v2 is current.",
    paperUseNotes: [
      "The durable evidence proves a static-to-dynamic_family route change after successful dynamic preparation. It does not prove a model-level causal explanation for that choice.",
      "The v1 and v2 publication events are independent records with supersedes_publication_id=null; v2 became current, but this run does not evidence a formal supersedes chain.",
      "Supervisor adoption after permission stops is not, by itself, evidence of Dataset Core checkpoint replay. Do not summarize this corrected run as an interrupted computation resumed from a deterministic checkpoint unless separate checkpoint records are cited.",
    ],
  },
  {
    key: "gold10-flash",
    displayName: "Gold10 Flash",
    goldCase: 10,
    promptKey: "gold10",
    runDir: "runs/gold10-flash",
    eventRel: "evidence/events.jsonl",
    semanticRouteFallback: "static",
    publicationRoute: "not_reached",
    promptProvenance: "reconstructed historical TOPIC prompt",
    terminalSummary: "Valid blocked_no_publication terminal: the static four-table all-or-nothing path did not admit a non-empty differential-abundance table. Staging files are not formal artifacts.",
    paperUseNotes: [
      "Retain this run in the six-run outcome denominator as a negative/fail-closed case, but exclude it from Publication-level artifact-quality comparisons because no formal artifact exists.",
      "Do not say acquisition broadly succeeded: some source-traceable candidates were staged, but the required cohort-bound differential-abundance supplement could not be formally acquired and parsed, and two executions were rejected for empty required tables.",
      "Fail-closed behavior is a verified safety property of this outcome; task completion still failed. Avoid relabeling the blocked scientific request as an overall success.",
    ],
  },
  {
    key: "gold6-max-v2",
    displayName: "Gold6 Max v2",
    goldCase: 6,
    promptKey: "gold6",
    runDir: "proxy-rerun/runs/gold6-max-v2",
    eventRel: "evidence/events-api-refetch.jsonl",
    mirrorEventRel: "evidence/events.jsonl",
    routeStateRel: "evidence/semantic-route.json",
    semanticRouteFallback: "static",
    publicationRoute: "dynamic_family",
    runtimeRoot: "proxy-rerun",
    objectCompareRuntime: true,
    promptProvenance: "same exact Gold6 prompt and frozen execution-context lineage as Gold6 Flash; v2 corrects the model metadata to 1,000,000 context / 32,768 maximum output",
    terminalSummary: "Completed after the context-metadata correction; all sampled contexts use 1,000,000 tokens and no compaction occurred.",
    paperUseNotes: [
      "Use v2 as the corrected Max result; v1 had incorrect 100,000-token context metadata and belongs only in the diagnostic appendix.",
      "The formal product is six CSV tables plus schema, provenance, and ProductAssessment (nine artifacts); B3 checked 94 items with zero failures.",
      "This is not a pure model-only comparison with Gold6 Flash: v2 used the isolated proxy host as well as corrected context/output metadata.",
    ],
  },
];

const CREDENTIAL_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9._-]{16,}/gi,
  /(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"'\s]{8,}/gi,
];

function usage() {
  return [
    "Usage:",
    "  node scripts/generate-gold6-10-session-report.mjs \\",
    "    --campaign-root /absolute/path/to/2026-09-03-main-e5aadfe0-qwen38-six-run-corrected \\",
    "    --output-dir docs/evaluation/gold6-10-2026-09-03",
    "",
    "Optional:",
    "  --qoder-analysis-root /absolute/path/to/data/qoder-gold6-2x2-analysis",
    "  --diagnostic-root /absolute/path/to/2026-09-03-main-e5aadfe0-qwen38-six-run",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    args[key] = value;
    index += 1;
  }
  return args;
}

function requirePath(value, description) {
  if (!value) {
    throw new Error(`Missing ${description}`);
  }
  return path.resolve(value);
}

function assertFile(file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`Required file is missing: ${file}`);
  }
}

function readText(file) {
  assertFile(file);
  return fs.readFileSync(file, "utf8");
}

function readJson(file) {
  try {
    return JSON.parse(readText(file));
  } catch (error) {
    throw new Error(`Cannot parse JSON ${file}: ${error.message}`);
  }
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function sha256File(file) {
  assertFile(file);
  return sha256Buffer(fs.readFileSync(file));
}

function normalizePath(value) {
  return value.split(path.sep).join("/");
}

function relativeTo(root, target) {
  return normalizePath(path.relative(root, target));
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function canonicalJsonlDigest(file) {
  const hash = crypto.createHash("sha256");
  let count = 0;
  for (const line of readText(file).split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    hash.update(stableStringify(JSON.parse(line)));
    hash.update("\n");
    count += 1;
  }
  return { count, sha256: hash.digest("hex") };
}

function parseJsonl(file) {
  const events = [];
  const lines = readText(file).split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) {
      continue;
    }
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`Cannot parse JSONL ${file}:${index + 1}: ${error.message}`);
    }
  }
  if (events.length === 0) {
    throw new Error(`No events found in ${file}`);
  }
  return events;
}

function asNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function timeMs(value) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid event timestamp: ${value}`);
  }
  return parsed;
}

function durationSeconds(start, end) {
  return (timeMs(end) - timeMs(start)) / 1000;
}

function finiteOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getPath(object, keys) {
  let current = object;
  for (const key of keys) {
    if (!current || typeof current !== "object" || !(key in current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function firstDefined(values) {
  for (const value of values) {
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return null;
}

function safeManifestPath(base, rawPath) {
  if (path.isAbsolute(rawPath)) {
    throw new Error(`Absolute path in evidence manifest is not allowed: ${rawPath}`);
  }
  const resolved = path.resolve(base, rawPath);
  const relative = path.relative(base, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Evidence manifest path escapes its base directory: ${rawPath}`);
  }
  return resolved;
}

function parseEvidenceManifest(manifestPath, campaignRoot) {
  const entries = [];
  for (const line of readText(manifestPath).split(/\r?\n/)) {
    const match = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (match) {
      entries.push({ expectedSha256: match[1].toLowerCase(), path: match[2] });
    }
  }
  if (entries.length === 0) {
    throw new Error(`No SHA-256 entries in evidence manifest: ${manifestPath}`);
  }

  const manifestDirectory = path.dirname(manifestPath);
  const candidates = [
    { label: "manifest_directory", base: manifestDirectory },
    { label: "run_directory", base: path.dirname(manifestDirectory) },
    { label: "campaign_root", base: campaignRoot },
  ];

  const attempts = candidates.map((candidate) => {
    let verified = 0;
    let mismatched = 0;
    let missing = 0;
    for (const entry of entries) {
      const file = safeManifestPath(candidate.base, entry.path);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        missing += 1;
      } else if (sha256File(file) === entry.expectedSha256) {
        verified += 1;
      } else {
        mismatched += 1;
      }
    }
    return { ...candidate, verified, mismatched, missing };
  });

  attempts.sort((left, right) => {
    if (left.verified !== right.verified) return right.verified - left.verified;
    if (left.mismatched !== right.mismatched) return left.mismatched - right.mismatched;
    return left.missing - right.missing;
  });
  const selected = attempts[0];
  const result = {
    manifest_path: relativeTo(campaignRoot, manifestPath),
    manifest_sha256: sha256File(manifestPath),
    entries: entries.length,
    base: selected.label,
    base_relative_to_campaign: relativeTo(campaignRoot, selected.base),
    verified: selected.verified,
    mismatched: selected.mismatched,
    missing: selected.missing,
    pass: selected.verified === entries.length && selected.mismatched === 0 && selected.missing === 0,
  };
  if (!result.pass) {
    throw new Error(`Evidence manifest verification failed for ${manifestPath}: ${JSON.stringify(result)}`);
  }
  return result;
}

function normalizeOperationFamily(operationId) {
  if (!operationId) return "unknown";
  return operationId.replace(/:\d+$/, "");
}

function classifyHil(payload) {
  const promptKind = payload.prompt_kind || "";
  const reviewType = payload.hil_request?.review_type || payload.detail?.review_type || "";
  const kind = payload.hil_request?.kind || "";
  if (promptKind === "api_key_or_credential" || kind === "api_key_or_credential") {
    return "credential";
  }
  if (reviewType === "publication_acceptance") {
    return "publication_acceptance";
  }
  if (kind === "data_review") {
    return "data_review";
  }
  return promptKind || kind || "other";
}

function eventSummary(events) {
  const typeCounts = new Map();
  const toolStarts = new Map();
  const tools = new Map();
  const operations = new Map();
  const hils = new Map();
  const permissions = new Map();
  const publications = [];
  const lifecycle = {};
  let peakContextTokens = 0;
  let peakContextPercent = 0;
  const contextWindows = new Set();
  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    total_tokens: 0,
    reasoning_tokens: 0,
  };

  function tool(name) {
    const key = name || "unknown";
    if (!tools.has(key)) {
      tools.set(key, {
        tool_name: key,
        started: 0,
        called: 0,
        completed: 0,
        errors: 0,
        duration_seconds_sum: 0,
        duration_seconds_max: 0,
      });
    }
    return tools.get(key);
  }

  function operation(operationId) {
    if (!operations.has(operationId)) {
      operations.set(operationId, {
        operation_id: operationId,
        operation_family: normalizeOperationFamily(operationId),
        category: null,
        started_at: null,
        completed_at: null,
        status: null,
      });
    }
    return operations.get(operationId);
  }

  function hil(requestId) {
    if (!hils.has(requestId)) {
      hils.set(requestId, {
        request_id: requestId,
        category: "other",
        required_at: null,
        resumed_at: null,
        decision: null,
      });
    }
    return hils.get(requestId);
  }

  function permission(requestId) {
    if (!permissions.has(requestId)) {
      permissions.set(requestId, {
        request_id: requestId,
        capability: "unknown",
        scope: "unknown",
        requested_at: null,
        resolved_at: null,
        decision: null,
      });
    }
    return permissions.get(requestId);
  }

  for (const event of events) {
    typeCounts.set(event.type, (typeCounts.get(event.type) || 0) + 1);
    const payload = event.payload || {};

    if (event.type === "run_queued" || event.type === "run_started" || event.type === "run_completed" || event.type === "run_failed") {
      lifecycle[event.type] = { sequence: event.sequence, at: event.timestamp };
    }

    if (event.type === "context_usage") {
      const contextUsage = payload.usage || {};
      usage.input_tokens += asNumber(contextUsage.input_tokens);
      usage.output_tokens += asNumber(contextUsage.output_tokens);
      usage.cache_read_tokens += asNumber(contextUsage.cache_read_tokens);
      usage.cache_write_tokens += asNumber(contextUsage.cache_write_tokens);
      usage.total_tokens += asNumber(contextUsage.total_tokens);
      usage.reasoning_tokens += asNumber(contextUsage.reasoning_tokens);
      peakContextTokens = Math.max(peakContextTokens, asNumber(payload.tokens));
      peakContextPercent = Math.max(peakContextPercent, asNumber(payload.percent));
      if (typeof payload.context_window === "number") {
        contextWindows.add(payload.context_window);
      }
    }

    if (event.type === "tool_started") {
      const record = tool(payload.tool_name);
      record.started += 1;
      toolStarts.set(payload.tool_call_id, { tool_name: payload.tool_name || "unknown", at: event.timestamp });
    }
    if (event.type === "tool_called") {
      tool(payload.tool_name).called += 1;
    }
    if (event.type === "tool_completed") {
      const start = toolStarts.get(payload.tool_call_id);
      const record = tool(payload.tool_name || start?.tool_name);
      record.completed += 1;
      if (payload.is_error === true) {
        record.errors += 1;
      }
      if (start) {
        const duration = durationSeconds(start.at, event.timestamp);
        record.duration_seconds_sum += duration;
        record.duration_seconds_max = Math.max(record.duration_seconds_max, duration);
      }
    }

    if (event.type === "operation_started") {
      const record = operation(payload.operation_id || "unknown");
      record.category = payload.category || record.category;
      record.started_at = event.timestamp;
    }
    if (event.type === "operation_completed" || event.type === "operation_failed") {
      const record = operation(payload.operation_id || "unknown");
      record.completed_at = event.timestamp;
      record.status = event.type === "operation_completed" ? (payload.status || "succeeded") : "failed";
    }

    if (event.type === "user_input_required") {
      const record = hil(payload.request_id || "unknown");
      record.category = classifyHil(payload);
      record.required_at = event.timestamp;
    }
    if (event.type === "user_input_resumed") {
      const record = hil(payload.request_id || "unknown");
      record.resumed_at = event.timestamp;
      const decision = payload.decision;
      record.decision = typeof decision === "string" ? decision : decision?.action || "unknown";
    }

    if (event.type === "permission_requested") {
      const record = permission(payload.request_id || "unknown");
      record.capability = payload.capability || "unknown";
      record.scope = payload.scope || "unknown";
      record.requested_at = event.timestamp;
    }
    if (event.type === "permission_resolved") {
      const record = permission(payload.request_id || "unknown");
      record.resolved_at = event.timestamp;
      record.decision = payload.decision || "unknown";
    }

    if (event.type === "publication_created") {
      publications.push({
        publication_id: payload.publication_id || null,
        manifest_sha256: payload.manifest_sha256 || null,
        supersedes_publication_id: payload.supersedes_publication_id || null,
        published_at: payload.published_at || event.timestamp,
        event_sequence: event.sequence,
      });
    }
  }

  const toolRows = [...tools.values()]
    .map((record) => ({
      ...record,
      duration_seconds_sum: Number(record.duration_seconds_sum.toFixed(3)),
      duration_seconds_max: Number(record.duration_seconds_max.toFixed(3)),
    }))
    .sort((left, right) => left.tool_name.localeCompare(right.tool_name));

  const operationRows = [...operations.values()];
  const operationAggregates = new Map();
  for (const record of operationRows) {
    const key = `${record.category || "unknown"}|${record.operation_family}`;
    if (!operationAggregates.has(key)) {
      operationAggregates.set(key, {
        operation_family: record.operation_family,
        category: record.category || "unknown",
        started: 0,
        completed: 0,
        failed: 0,
        open: 0,
        duration_seconds_sum: 0,
        duration_observed: 0,
      });
    }
    const aggregate = operationAggregates.get(key);
    if (record.started_at) aggregate.started += 1;
    if (record.status === "failed") aggregate.failed += 1;
    if (record.completed_at && record.status !== "failed") aggregate.completed += 1;
    if (!record.completed_at) aggregate.open += 1;
    if (record.started_at && record.completed_at) {
      aggregate.duration_seconds_sum += durationSeconds(record.started_at, record.completed_at);
      aggregate.duration_observed += 1;
    }
  }
  const namedOperations = [...operationAggregates.values()]
    .map((record) => ({
      ...record,
      duration_seconds_sum: Number(record.duration_seconds_sum.toFixed(3)),
    }))
    .sort((left, right) => left.operation_family.localeCompare(right.operation_family));

  const hilRows = [...hils.values()];
  const hilAggregates = new Map();
  for (const record of hilRows) {
    if (!hilAggregates.has(record.category)) {
      hilAggregates.set(record.category, { category: record.category, requested: 0, resolved: 0, wait_seconds: 0 });
    }
    const aggregate = hilAggregates.get(record.category);
    if (record.required_at) aggregate.requested += 1;
    if (record.resumed_at) aggregate.resolved += 1;
    if (record.required_at && record.resumed_at) {
      aggregate.wait_seconds += durationSeconds(record.required_at, record.resumed_at);
    }
  }
  const hilSummary = [...hilAggregates.values()]
    .map((record) => ({ ...record, wait_seconds: Number(record.wait_seconds.toFixed(3)) }))
    .sort((left, right) => left.category.localeCompare(right.category));

  const permissionRows = [...permissions.values()];
  const permissionAggregates = new Map();
  for (const record of permissionRows) {
    const key = `${record.capability}|${record.scope}|${record.decision || "pending"}`;
    if (!permissionAggregates.has(key)) {
      permissionAggregates.set(key, {
        capability: record.capability,
        scope: record.scope,
        decision: record.decision || "pending",
        count: 0,
        wait_seconds: 0,
      });
    }
    const aggregate = permissionAggregates.get(key);
    aggregate.count += 1;
    if (record.requested_at && record.resolved_at) {
      aggregate.wait_seconds += durationSeconds(record.requested_at, record.resolved_at);
    }
  }
  const permissionSummary = [...permissionAggregates.values()]
    .map((record) => ({ ...record, wait_seconds: Number(record.wait_seconds.toFixed(3)) }))
    .sort((left, right) => `${left.capability}|${left.scope}|${left.decision}`.localeCompare(`${right.capability}|${right.scope}|${right.decision}`));

  const sortedTypes = Object.fromEntries([...typeCounts.entries()].sort(([left], [right]) => left.localeCompare(right)));
  const contextCount = typeCounts.get("context_usage") || 0;
  const compactionCount = [...typeCounts.entries()]
    .filter(([type]) => type.includes("compacted") || type.includes("compaction"))
    .reduce((total, [, count]) => total + count, 0);

  return {
    event_count: events.length,
    first_sequence: events[0].sequence,
    last_sequence: events.at(-1).sequence,
    sequences_contiguous: events.every((event, index) => event.sequence === events[0].sequence + index),
    event_type_counts: sortedTypes,
    lifecycle,
    context_usage_events: contextCount,
    usage,
    context_window_tokens: [...contextWindows].sort((left, right) => left - right),
    peak_context_tokens: peakContextTokens,
    peak_context_percent: Number(peakContextPercent.toFixed(4)),
    compaction_events: compactionCount,
    tools: toolRows,
    tool_pairs: {
      started: typeCounts.get("tool_started") || 0,
      called: typeCounts.get("tool_called") || 0,
      completed: typeCounts.get("tool_completed") || 0,
    },
    named_operations: namedOperations,
    operation_event_counts: {
      started: typeCounts.get("operation_started") || 0,
      progress: typeCounts.get("operation_progress") || 0,
      completed: typeCounts.get("operation_completed") || 0,
      failed: typeCounts.get("operation_failed") || 0,
    },
    hils: hilSummary,
    user_input_required: typeCounts.get("user_input_required") || 0,
    user_input_resumed: typeCounts.get("user_input_resumed") || 0,
    permissions: permissionSummary,
    permission_requested: typeCounts.get("permission_requested") || 0,
    permission_resolved: typeCounts.get("permission_resolved") || 0,
    publications,
    artifact_produced_events: typeCounts.get("artifact_produced") || 0,
  };
}

function normalizeArtifacts(closure) {
  const source = Array.isArray(closure.artifacts) ? closure.artifacts : [];
  return source.map((artifact) => ({
    artifact_id: artifact.artifact_id || null,
    relative_path: artifact.relative_path || null,
    role: artifact.role || null,
    size_bytes: firstDefined([artifact.actual_size, artifact.expected_size, artifact.size_bytes]),
    sha256: firstDefined([artifact.actual_file_sha256, artifact.expected_file_sha256, artifact.sha256]),
    receipt_verified: artifact.file_digest_match === true,
  }));
}

function productStatus(detail, closure) {
  return firstDefined([
    getPath(detail, ["product_assessment", "product_status"]),
    getPath(detail, ["publication_acceptance_b3_product_assessment", "product_assessment_artifact", "product_status"]),
    getPath(detail, ["publications", "product_assessment", "product_status"]),
    getPath(closure, ["publication_detail", "manifest", "confidence_summary", "product_status"]),
  ]);
}

function declaredDuration(detail) {
  const candidates = [
    ["wall.run_wall_seconds", getPath(detail, ["wall", "run_wall_seconds"])],
    ["wall_times.run_wall_duration_s", getPath(detail, ["wall_times", "run_wall_duration_s"])],
    ["timeline.wall_clock_seconds", getPath(detail, ["timeline", "wall_clock_seconds"])],
    ["terminal.wall_seconds", getPath(detail, ["terminal", "wall_seconds"])],
    ["timings.run_wall_seconds", getPath(detail, ["timings", "run_wall_seconds"])],
  ];
  for (const [field, value] of candidates) {
    if (finiteOrNull(value) !== null) return { field, seconds: value };
  }
  return null;
}

function readRoute(routePath, fallback) {
  if (!routePath || !fs.existsSync(routePath)) {
    return fallback;
  }
  const route = readJson(routePath).route;
  return typeof route === "string" ? route : fallback;
}

function runMetadataFrom(root, spec) {
  return readJson(path.join(root, spec.runDir, "run.json"));
}

function modelProfile(meta) {
  const profile = meta.model_profile || {};
  return {
    reasoning_effort: profile.reasoning_effort || null,
    thinking_enabled: firstDefined([profile.thinking_mode, profile.enable_thinking, profile.thinking]),
    search_enabled: firstDefined([profile.enable_search, profile.search]),
  };
}

function usageMatches(expected, observed) {
  if (!expected) return false;
  const keys = ["model_calls", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "total_tokens", "reasoning_tokens"];
  return keys.every((key) => expected[key] === observed[key]);
}

function buildRuntimePath(repoRoot, campaignRoot, spec, taskId) {
  if (spec.runtimeRoot === "proxy-rerun") {
    return path.join(campaignRoot, "proxy-rerun", "data", "output", "tasks", taskId, "events.jsonl");
  }
  return path.join(repoRoot, "data", "output", "tasks", taskId, "events.jsonl");
}

function compareObjectStreams(leftPath, rightPath) {
  if (!fs.existsSync(leftPath) || !fs.existsSync(rightPath)) {
    return { available: false, identical: null, prefix_identical: null, left: null, right: null };
  }
  const leftEvents = parseJsonl(leftPath);
  const rightEvents = parseJsonl(rightPath);
  const prefixIdentical = leftEvents.every((event, index) => stableStringify(event) === stableStringify(rightEvents[index]));
  const left = canonicalJsonlDigest(leftPath);
  const right = canonicalJsonlDigest(rightPath);
  return {
    available: true,
    identical: prefixIdentical && left.count === right.count && left.sha256 === right.sha256,
    prefix_identical: prefixIdentical,
    left,
    right,
    right_suffix: rightEvents.slice(leftEvents.length).map((event) => ({ sequence: event.sequence, type: event.type, timestamp: event.timestamp })),
  };
}

function evidenceIntegrity({ campaignRoot, repoRoot, spec, metadata, selectedEventPath }) {
  const manifestPath = path.join(campaignRoot, spec.runDir, "evidence", "evidence-manifest.sha256");
  const manifest = parseEvidenceManifest(manifestPath, campaignRoot);
  const runtimePath = buildRuntimePath(repoRoot, campaignRoot, spec, metadata.task_id);
  const integrity = {
    evidence_manifest: manifest,
    authoritative_event_source: {
      path: relativeTo(campaignRoot, selectedEventPath),
      sha256: sha256File(selectedEventPath),
    },
  };

  if (fs.existsSync(runtimePath)) {
    if (spec.objectCompareRuntime) {
      const comparison = compareObjectStreams(selectedEventPath, runtimePath);
      integrity.runtime_event_comparison = {
        method: "canonical_json_object_stream",
        runtime_path: relativeTo(repoRoot, runtimePath),
        api_refetch_object_identical_to_runtime: comparison.identical,
        selected_object_stream_is_runtime_prefix: comparison.prefix_identical,
        selected_event_count: comparison.left?.count ?? null,
        runtime_event_count: comparison.right?.count ?? null,
        runtime_events_after_selected_archive: Math.max(0, (comparison.right?.count ?? 0) - (comparison.left?.count ?? 0)),
        runtime_suffix_after_selected_archive: comparison.right_suffix || [],
        selected_canonical_sha256: comparison.left?.sha256 ?? null,
        runtime_canonical_sha256: comparison.right?.sha256 ?? null,
        selected_file_sha256: sha256File(selectedEventPath),
        runtime_file_sha256: sha256File(runtimePath),
      };
      if (!comparison.prefix_identical) {
        throw new Error(`Authoritative event archive is not a runtime event prefix for ${spec.key}`);
      }
    } else {
      const equal = fs.readFileSync(selectedEventPath).equals(fs.readFileSync(runtimePath));
      integrity.runtime_event_comparison = {
        method: "byte_comparison",
        runtime_path: relativeTo(repoRoot, runtimePath),
        byte_identical_to_runtime: equal,
        runtime_file_sha256: sha256File(runtimePath),
      };
      if (!equal) {
        throw new Error(`Authoritative event archive is not byte-identical to runtime events for ${spec.key}`);
      }
    }
  } else {
    integrity.runtime_event_comparison = {
      method: spec.objectCompareRuntime ? "canonical_json_object_stream" : "byte_comparison",
      runtime_path: relativeTo(repoRoot, runtimePath),
      unavailable: true,
    };
  }

  if (spec.mirrorEventRel) {
    const mirrorPath = path.join(campaignRoot, spec.runDir, spec.mirrorEventRel);
    if (fs.existsSync(mirrorPath)) {
      const mirrorEvents = parseJsonl(mirrorPath);
      const selectedEvents = parseJsonl(selectedEventPath);
      const selectedSequences = new Set(selectedEvents.map((event) => event.sequence));
      const missingSequences = selectedEvents
        .map((event) => event.sequence)
        .filter((sequence) => !new Set(mirrorEvents.map((event) => event.sequence)).has(sequence));
      integrity.supervisor_or_evidence_mirror = {
        path: relativeTo(campaignRoot, mirrorPath),
        sha256: sha256File(mirrorPath),
        event_count: mirrorEvents.length,
        byte_identical_to_authoritative: fs.readFileSync(mirrorPath).equals(fs.readFileSync(selectedEventPath)),
        missing_authoritative_sequences: missingSequences,
      };
      if (spec.objectCompareRuntime && missingSequences.length > 0) {
        integrity.supervisor_or_evidence_mirror.note = "The evidence journal is a supervisor page/poll projection; the API refetch is the complete authoritative object stream.";
      }
      void selectedSequences;
    }
  }
  return integrity;
}

function extractContextCorrection(meta, detail) {
  const correction = meta.context_metadata_correction || getPath(detail, ["identities", "context_metadata_correction"]);
  if (!correction) return null;
  return {
    context_window: correction.context_window || null,
    max_tokens: correction.max_tokens || null,
    reason: correction.reason || null,
    corrected_before_run: true,
  };
}

function deriveRun({ campaignRoot, repoRoot, campaign, spec }) {
  const runDir = path.join(campaignRoot, spec.runDir);
  const metadata = runMetadataFrom(campaignRoot, spec);
  const detail = readJson(path.join(runDir, "evidence", "detailed-metrics.json"));
  const closure = readJson(path.join(runDir, "evidence", "closure.json"));
  const selectedEventPath = path.join(runDir, spec.eventRel);
  const events = parseJsonl(selectedEventPath);
  const event = eventSummary(events);

  if (!event.sequences_contiguous) {
    throw new Error(`Non-contiguous selected event stream for ${spec.key}`);
  }
  const queued = event.lifecycle.run_queued;
  const started = event.lifecycle.run_started;
  const terminal = event.lifecycle.run_completed || event.lifecycle.run_failed;
  if (!queued || !started || !terminal) {
    throw new Error(`Lifecycle is incomplete for ${spec.key}`);
  }

  const eventDurationSeconds = Number(durationSeconds(started.at, terminal.at).toFixed(3));
  const closureUsage = closure.run_usage || {};
  const observedUsage = { model_calls: event.context_usage_events, ...event.usage };
  const tokenMatch = usageMatches(closureUsage, observedUsage);
  if (!tokenMatch) {
    throw new Error(`Token totals do not match closure run_usage for ${spec.key}`);
  }

  const terminalRecord = closure.terminal || {};
  const currentPublication = terminalRecord.publication || closure.publication || null;
  const artifacts = normalizeArtifacts(closure);
  if (terminalRecord.classification === "succeeded_publication" && artifacts.some((artifact) => !artifact.receipt_verified)) {
    throw new Error(`Artifact receipts are incomplete for ${spec.key}`);
  }
  const routePath = spec.routeStateRel ? path.join(runDir, spec.routeStateRel) : null;
  const semanticRoute = readRoute(routePath, spec.semanticRouteFallback);
  const sourceManifest = evidenceIntegrity({ campaignRoot, repoRoot, spec, metadata, selectedEventPath });
  const declared = declaredDuration(detail);
  const durationMatchesDeclared = !declared || Math.abs(eventDurationSeconds - declared.seconds) < 0.5;
  const routeTransition = getPath(detail, ["timeline", "semantic_route"]);

  const result = {
    label: spec.key,
    display_name: spec.displayName,
    gold_case: spec.goldCase,
    principal_cohort: true,
    identity: {
      task_id: metadata.task_id,
      run_id: metadata.run_id,
      request_id: metadata.request_id,
      product_commit: metadata.product_commit,
      model: metadata.model,
      model_registry_id: metadata.model_registry_id || null,
      model_profile: modelProfile(metadata),
      prompt_path: metadata.prompt_path,
      prompt_sha256: metadata.prompt_sha256,
      prompt_bytes: campaign.prompts?.[spec.promptKey]?.bytes || null,
      prompt_provenance: spec.promptProvenance,
      execution_context_sha256: metadata.execution_context_sha256 || (spec.goldCase === 6 ? campaign.gold6_execution_context?.sha256 || null : null),
      context_metadata_correction: extractContextCorrection(metadata, detail),
    },
    lifecycle: {
      queued_at: queued.at,
      started_at: started.at,
      finished_at: terminal.at,
      terminal_event: terminal === event.lifecycle.run_failed ? "run_failed" : "run_completed",
      terminal_classification: terminalRecord.classification || "unknown",
      event_duration_seconds: eventDurationSeconds,
      queued_to_started_milliseconds: Math.round((timeMs(started.at) - timeMs(queued.at))),
      declared_duration: declared,
      duration_matches_declared: durationMatchesDeclared,
      terminal_summary: spec.terminalSummary,
    },
    route: {
      initial_semantic_route: spec.initialSemanticRoute || semanticRoute,
      final_semantic_route: semanticRoute,
      publication_route: spec.publicationRoute,
      route_state_path: routePath && fs.existsSync(routePath) ? relativeTo(campaignRoot, routePath) : null,
      route_transition_at: routeTransition?.route_state_file_written_at || null,
    },
    execution: {
      event_count: event.event_count,
      first_sequence: event.first_sequence,
      last_sequence: event.last_sequence,
      sequences_contiguous: event.sequences_contiguous,
      event_type_counts: event.event_type_counts,
      model_calls: observedUsage.model_calls,
      context_usage_events: event.context_usage_events,
      context_window_tokens: event.context_window_tokens,
      peak_context_tokens: event.peak_context_tokens,
      peak_context_percent: event.peak_context_percent,
      compaction_events: event.compaction_events,
      tokens: event.usage,
      token_totals_match_closure: tokenMatch,
      tools: event.tools,
      tool_pairs: event.tool_pairs,
      named_operation_event_counts: event.operation_event_counts,
      named_operations: event.named_operations,
      hils: event.hils,
      user_input_required: event.user_input_required,
      user_input_resumed: event.user_input_resumed,
      permissions: event.permissions,
      permission_requested: event.permission_requested,
      permission_resolved: event.permission_resolved,
    },
    publication: {
      publication_created_events: event.publications,
      current_publication: currentPublication
        ? {
            publication_id: currentPublication.publication_id,
            requirement_id: currentPublication.requirement_id,
            manifest_ref: currentPublication.manifest_ref,
            manifest_sha256: currentPublication.manifest_sha256,
            published_at: currentPublication.published_at,
            package_digest: closure.package_digest || null,
            manifest_file_digest: closure.manifest_file_digest || currentPublication.manifest_sha256,
          }
        : null,
      product_status: productStatus(detail, closure),
      formal_artifacts: artifacts,
      formal_artifact_count: artifacts.length,
      formal_artifact_receipts_verified: artifacts.length === 0 ? null : artifacts.every((artifact) => artifact.receipt_verified),
      artifact_produced_event_count: event.artifact_produced_events,
      b3: getPath(detail, ["publications", "b3"]) || null,
    },
    paper_use_notes: spec.paperUseNotes,
    source_evidence: {
      ...sourceManifest,
      input_paths: {
        run_metadata: relativeTo(campaignRoot, path.join(runDir, "run.json")),
        closure: relativeTo(campaignRoot, path.join(runDir, "evidence", "closure.json")),
        detailed_metrics: relativeTo(campaignRoot, path.join(runDir, "evidence", "detailed-metrics.json")),
        selected_event_source: relativeTo(campaignRoot, selectedEventPath),
        evidence_manifest: relativeTo(campaignRoot, path.join(runDir, "evidence", "evidence-manifest.sha256")),
        independent_audit: fs.existsSync(path.join(runDir, "independent-audit.json"))
          ? relativeTo(campaignRoot, path.join(runDir, "independent-audit.json"))
          : null,
      },
    },
  };

  if (!durationMatchesDeclared) {
    result.lifecycle.duration_discrepancy = {
      declared_field: declared.field,
      declared_seconds: declared.seconds,
      event_derived_seconds: eventDurationSeconds,
      delta_seconds: Number((eventDurationSeconds - declared.seconds).toFixed(3)),
      rule: "The event-derived run_started-to-terminal interval is used in every primary table.",
    };
  }

  return result;
}

function sourceManifestForDiagnostic(campaignRoot, runDir) {
  return parseEvidenceManifest(path.join(campaignRoot, runDir, "evidence", "evidence-manifest.sha256"), campaignRoot);
}

function loadDiagnostics(campaignRoot, repoRoot, diagnosticRootOverride) {
  const diagnosticRoot = diagnosticRootOverride
    ? path.resolve(diagnosticRootOverride)
    : path.resolve(campaignRoot, "..", "2026-09-03-main-e5aadfe0-qwen38-six-run");
  const invalidProfilePath = path.join(diagnosticRoot, "invalid-profile-independent-audit.json");
  const maxV1Path = path.join(campaignRoot, "runs", "gold6-max", "independent-audit.json");
  const proxyDetailPath = path.join(campaignRoot, "proxy-rerun", "runs", "gold9-flash-proxy", "evidence", "detailed-metrics.json");
  const dynamicDetailPath = path.join(campaignRoot, "proxy-rerun", "runs", "gold9-flash-dynamic", "evidence", "detailed-metrics.json");

  const invalid = readJson(invalidProfilePath);
  const maxV1 = readJson(maxV1Path);
  const proxy = readJson(proxyDetailPath);
  const dynamic = readJson(dynamicDetailPath);

  const proxyManifest = sourceManifestForDiagnostic(campaignRoot, "proxy-rerun/runs/gold9-flash-proxy");
  const dynamicManifest = sourceManifestForDiagnostic(campaignRoot, "proxy-rerun/runs/gold9-flash-dynamic");

  return {
    invalid_profile_batch: {
      source: relativeTo(repoRoot, invalidProfilePath),
      source_sha256: sha256File(invalidProfilePath),
      status: invalid.status,
      root_cause: "INVALID_MODEL_PROFILE: reasoning_effort=xhigh with thinking disabled",
      runs: invalid.aggregate.runs,
      failed: invalid.aggregate.failed,
      model_calls: invalid.aggregate.model_calls,
      total_tokens: invalid.aggregate.total_tokens,
      tool_calls: invalid.aggregate.tool_calls,
      hil_requests: invalid.aggregate.hil_requests,
      publications: invalid.aggregate.publications,
      artifacts: invalid.aggregate.artifacts,
      exclusion_reason: "The provider rejected the configuration before generation; it is infrastructure diagnosis, not a formal result.",
    },
    gold6_max_v1: {
      source: relativeTo(repoRoot, maxV1Path),
      source_sha256: sha256File(maxV1Path),
      task_id: maxV1.task_id,
      run_id: maxV1.run_id,
      terminal_classification: maxV1.terminal.closure_classification,
      terminal_code: "CONTEXT_COMPACTION_INEFFECTIVE",
      run_wall_seconds: maxV1.run_wall_duration_s,
      context_window_tokens: maxV1.usage.context_window,
      model_calls: maxV1.usage.model_calls,
      total_tokens: maxV1.usage.total_tokens,
      compaction_events: maxV1.context_pressure.compaction_count_durable,
      terminal_over_target_tokens: maxV1.context_pressure.compactions.at(-1).over_target_tokens,
      publications: maxV1.publication.publication_count_for_task_run,
      artifacts: maxV1.publication.artifact_count,
      evidence_manifest_pass: maxV1.evidence_pack.manifest_sha256sum_c_passed,
      exclusion_reason: "The registry metadata recorded a 100,000-token context window; v2 is the corrected 1,000,000-token main run.",
    },
    gold9_frozen_proxy: {
      source_manifest: proxyManifest,
      task_id: proxy.identities.task_id,
      run_id: proxy.identities.run_id,
      prompt_sha256: proxy.identities.prompt_sha256,
      product_commit: proxy.identities.product_commit,
      model: proxy.identities.model,
      terminal_classification: proxy.terminal.supervisor_classification,
      duration_seconds: proxy.timings.run_wall_seconds,
      model_calls: proxy.context_usage.run_summary_usage.model_calls,
      total_tokens: proxy.context_usage.run_summary_usage.total_tokens,
      semantic_route: "static",
      execute_attempts: proxy.execute_iterations.total_execute_attempts,
      deterministic_error_code: "INVALID_INPUT",
      normalized_terminal_rejection: "CONFLICTING_CLINGEN_CLASSIFICATIONS",
      acquisition_attempts: proxy.download_throughput.acquisition_attempts.length,
      acquisition_all_succeeded: proxy.download_throughput.acquisition_attempts.every((attempt) => attempt.status === "succeeded"),
      publications: proxy.publication.publications_in_snapshot,
      artifacts: 0,
      exclusion_reason: "A frozen-prompt proxy rerun used for route diagnosis, not included in the six-run primary cohort.",
    },
    gold9_dynamic_first: {
      source_manifest: dynamicManifest,
      task_id: dynamic.identities.task_id,
      run_id: dynamic.identities.run_id,
      prompt_sha256: dynamic.prompt_variant_provenance.prompt_sha256,
      frozen_prompt_sha256: dynamic.prompt_variant_provenance.frozen_gold9_prompt_sha256,
      product_commit: dynamic.identities.product_commit,
      model: dynamic.identities.model,
      terminal_classification: dynamic.terminal.classification,
      duration_seconds: dynamic.timeline.wall_run_seconds,
      model_calls: dynamic.tokens.model_calls,
      total_tokens: dynamic.tokens.total_tokens,
      semantic_route: "static",
      dynamic_first_directive_honored: dynamic.route_decision.dynamic_first_directive_honored,
      dynamic_profile_result: "PROFILE_SCAFFOLD_REJECTED",
      execute_attempts: dynamic.failure_analysis.invalid_input_total,
      deterministic_error_code: "INVALID_INPUT",
      normalized_terminal_rejection: "CONFLICTING_OMIM_IDENTIFIERS",
      acquisition_attempts: dynamic.acquisition.core_attempts,
      acquisition_all_succeeded: dynamic.acquisition.all_succeeded,
      publications: dynamic.terminal.publications.length,
      artifacts: dynamic.terminal.artifact_count,
      exclusion_reason: "This is an explicit prompt variant, not a frozen Gold9 rerun; it is route diagnosis only.",
    },
  };
}

function loadQoderAnalysis(campaignRoot, repoRoot, analysisRootOverride) {
  const dataRoot = path.resolve(campaignRoot, "..", "..");
  const analysisRoot = analysisRootOverride
    ? path.resolve(analysisRootOverride)
    : path.join(repoRoot, "docs", "evaluation", "gold6-qoder-2x2");
  const reportPath = path.join(analysisRoot, "report.json");
  const metadataPath = path.join(analysisRoot, "analysis-metadata.json");
  const verificationPath = path.join(analysisRoot, "verification.sha256");
  const report = readJson(reportPath);
  const metadata = readJson(metadataPath);
  const entries = [];
  for (const line of readText(verificationPath).split(/\r?\n/)) {
    const match = line.match(/^([0-9a-fA-F]{64})\s+(.+)$/);
    if (match) entries.push({ expected: match[1].toLowerCase(), relative_path: match[2] });
  }
  const verified = entries.filter((entry) => {
    const candidate = safeManifestPath(analysisRoot, entry.relative_path);
    return fs.existsSync(candidate) && sha256File(candidate) === entry.expected;
  }).length;
  if (verified !== entries.length) {
    throw new Error("Qoder analysis verification.sha256 does not verify all entries");
  }
  return {
    source_root: relativeTo(repoRoot, analysisRoot),
    source_outputs: {
      report_json_sha256: sha256File(reportPath),
      analysis_metadata_sha256: sha256File(metadataPath),
      verification_sha256: sha256File(verificationPath),
      verification_entries: entries.length,
      verification_pass: verified === entries.length,
    },
    source_archives: {
      flash_zip_sha256: report.inputs.flash_zip.sha256,
      max_zip_sha256: report.inputs.max_zip.sha256,
    },
    formal_publication: false,
    placement: report.placement,
    conclusions: {
      flash: "Q1 high structured coverage and high auditability.",
      max: "Borderline structured coverage and high auditability; its X score is exactly 0.50, so it is not forced into a quadrant.",
      provenance_granularity: "Flash: 10,215 distinct locations across 10,682 facts. Max: 11 distinct locations across 6,439 facts.",
      manifest: "Flash has one self-referential SHA-1 mismatch and truncated SHA-1 prefixes; Max verifies 5/5 full MD5 entries.",
      reproducibility_limit: "Neither offline zip contains the raw payloads or extraction scripts cited by its methods log. These outputs are not formal BioMed-QAgent Publications.",
    },
    credential_scan: metadata.verification?.credential_scan?.targets || null,
  };
}

function g9CrossRoute(mainGold9, diagnostics) {
  return {
    scope: "The proxy and dynamic-first runs are diagnostic controls, not primary cohort members.",
    routes: [
      {
        label: "original_frozen_direct",
        frozen_prompt: true,
        prompt_sha256: mainGold9.identity.prompt_sha256,
        product_commit: mainGold9.identity.product_commit,
        model: mainGold9.identity.model,
        terminal_classification: mainGold9.lifecycle.terminal_classification,
        duration_seconds: mainGold9.lifecycle.event_duration_seconds,
        semantic_route: "static_to_dynamic_family",
        causal_milestones: [
          "Static execution encountered acquisition failures, then a deterministic static validation rejection after carriers were acquired.",
          "The first successful prepare_dynamic_family_publication coincided with the durable semantic-route update to dynamic_family at 2026-09-03T17:56:04.118Z.",
          "Two dynamic-family publication events followed; v2 is the current byte-verified publication.",
        ],
      },
      {
        label: "frozen_proxy",
        frozen_prompt: true,
        prompt_sha256: diagnostics.gold9_frozen_proxy.prompt_sha256,
        product_commit: diagnostics.gold9_frozen_proxy.product_commit,
        model: diagnostics.gold9_frozen_proxy.model,
        terminal_classification: diagnostics.gold9_frozen_proxy.terminal_classification,
        duration_seconds: diagnostics.gold9_frozen_proxy.duration_seconds,
        semantic_route: diagnostics.gold9_frozen_proxy.semantic_route,
        execute_attempts: diagnostics.gold9_frozen_proxy.execute_attempts,
        acquisition_all_succeeded: diagnostics.gold9_frozen_proxy.acquisition_all_succeeded,
        deterministic_error_code: diagnostics.gold9_frozen_proxy.deterministic_error_code,
        normalized_terminal_rejection: diagnostics.gold9_frozen_proxy.normalized_terminal_rejection,
      },
      {
        label: "dynamic_first_prompt_variant",
        frozen_prompt: false,
        prompt_sha256: diagnostics.gold9_dynamic_first.prompt_sha256,
        frozen_prompt_sha256: diagnostics.gold9_dynamic_first.frozen_prompt_sha256,
        product_commit: diagnostics.gold9_dynamic_first.product_commit,
        model: diagnostics.gold9_dynamic_first.model,
        terminal_classification: diagnostics.gold9_dynamic_first.terminal_classification,
        duration_seconds: diagnostics.gold9_dynamic_first.duration_seconds,
        semantic_route: diagnostics.gold9_dynamic_first.semantic_route,
        dynamic_first_directive_honored: diagnostics.gold9_dynamic_first.dynamic_first_directive_honored,
        dynamic_profile_result: diagnostics.gold9_dynamic_first.dynamic_profile_result,
        execute_attempts: diagnostics.gold9_dynamic_first.execute_attempts,
        acquisition_all_succeeded: diagnostics.gold9_dynamic_first.acquisition_all_succeeded,
        deterministic_error_code: diagnostics.gold9_dynamic_first.deterministic_error_code,
        normalized_terminal_rejection: diagnostics.gold9_dynamic_first.normalized_terminal_rejection,
      },
    ],
    assessment: {
      proven: [
        "The original run's durable route changed only after a successful dynamic-family preparation, and it then emitted formal publication events.",
        "The frozen proxy run stayed on the registered static family for all 15 execution attempts despite successful acquisitions, and it never reached the publication chain.",
        "The dynamic-first variant remained static because the requested four-table dynamic profile was rejected; an instruction does not create an unavailable registered profile.",
      ],
      strongly_supported: [
        "Network/acquisition behavior was not sufficient for publication: both diagnostic proxy runs acquired their carriers successfully but were stopped by deterministic static-family validation.",
        "The original run's eventual publication avoided the static-family invariant by producing a dynamic scientific-assertion publication, rather than repairing the rejected static four-table family.",
      ],
      unproven: [
        "The evidence does not isolate a causal model-level reason for the original agent's route choice. The frozen proxy is a different execution trajectory and host environment.",
        "The original dynamic publication and the dynamic-first requested four-table profile are not interchangeable requirements, so their outcomes are not a controlled quality comparison.",
      ],
    },
  };
}

function markdownEscape(value) {
  if (value === null || value === undefined) return "-";
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function inlineCode(value) {
  return value === null || value === undefined ? "-" : `\`${value}\``;
}

function markdownTable(headers, rows) {
  const header = `| ${headers.map(markdownEscape).join(" | ")} |`;
  const divider = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.map(markdownEscape).join(" | ")} |`);
  return [header, divider, ...body].join("\n");
}

function formatInteger(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatSeconds(value) {
  const seconds = Math.max(0, value);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds - hours * 3600 - minutes * 60;
  const secondText = remainder.toFixed(3).replace(/\.000$/, "");
  if (hours > 0) return `${hours} h ${minutes} min ${secondText} s`;
  if (minutes > 0) return `${minutes} min ${secondText} s`;
  return `${secondText} s`;
}

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function runHref(run) {
  return `runs/${run.label}.md`;
}

function buildRunMarkdown(run, campaign) {
  const publication = run.publication.current_publication;
  const output = [];
  output.push(`# ${run.display_name} Principal-Run Report`);
  output.push("");
  output.push("This file is a derived, redacted report. It contains no prompt text, assistant deltas, tool arguments, or tool outputs. All timing and counters are regenerated from the selected authoritative event stream.");
  output.push("");
  output.push("## Identity and Scope");
  output.push("");
  output.push(markdownTable(["Field", "Value"], [
    ["Campaign", campaign.campaign_id],
    ["Principal cohort", "yes"],
    ["Task", inlineCode(run.identity.task_id)],
    ["Run", inlineCode(run.identity.run_id)],
    ["Request", inlineCode(run.identity.request_id)],
    ["Product commit", inlineCode(run.identity.product_commit)],
    ["Model", inlineCode(run.identity.model)],
    ["Model profile", `reasoning=${run.identity.model_profile.reasoning_effort}; thinking=${run.identity.model_profile.thinking_enabled}; search=${run.identity.model_profile.search_enabled}`],
    ["Prompt SHA-256", inlineCode(run.identity.prompt_sha256)],
    ["Prompt provenance", run.identity.prompt_provenance],
    ["Execution-context SHA-256", inlineCode(run.identity.execution_context_sha256)],
    ["Semantic route", run.route.initial_semantic_route === run.route.final_semantic_route ? run.route.final_semantic_route : `${run.route.initial_semantic_route} -> ${run.route.final_semantic_route}`],
    ["Publication route", run.route.publication_route],
  ]));
  if (run.identity.context_metadata_correction) {
    output.push("");
    output.push(`Context metadata correction before start: ${formatInteger(run.identity.context_metadata_correction.context_window)} context tokens and ${formatInteger(run.identity.context_metadata_correction.max_tokens)} maximum output tokens.`);
  }

  output.push("");
  output.push("## Event-Derived Lifecycle");
  output.push("");
  output.push(markdownTable(["Milestone", "UTC / Value"], [
    ["Queued", run.lifecycle.queued_at],
    ["Started", run.lifecycle.started_at],
    ["Finished", run.lifecycle.finished_at],
    ["Terminal classification", inlineCode(run.lifecycle.terminal_classification)],
    ["Event-derived wall time", `${run.lifecycle.event_duration_seconds} s (${formatSeconds(run.lifecycle.event_duration_seconds)})`],
    ["Queue to start", `${run.lifecycle.queued_to_started_milliseconds} ms`],
    ["Event range", `${formatInteger(run.execution.event_count)} events, sequences ${run.execution.first_sequence}-${run.execution.last_sequence}, contiguous=${run.execution.sequences_contiguous}`],
  ]));
  if (run.lifecycle.duration_discrepancy) {
    output.push("");
    output.push(`Duration reconciliation: the recorder field ${inlineCode(run.lifecycle.duration_discrepancy.declared_field)} reports ${run.lifecycle.duration_discrepancy.declared_seconds} s, but the authoritative event interval is ${run.lifecycle.duration_discrepancy.event_derived_seconds} s (delta ${run.lifecycle.duration_discrepancy.delta_seconds} s). The event interval is used here and in the main report.`);
  }
  output.push("");
  output.push(run.lifecycle.terminal_summary);

  output.push("");
  output.push("## Paper-Use Boundary");
  output.push("");
  for (const note of run.paper_use_notes) {
    output.push(`- ${note}`);
  }

  output.push("");
  output.push("## Model and Context Usage");
  output.push("");
  output.push(markdownTable(["Metric", "Value"], [
    ["Model calls", formatInteger(run.execution.model_calls)],
    ["Context-usage events", formatInteger(run.execution.context_usage_events)],
    ["Context windows", run.execution.context_window_tokens.map(formatInteger).join(", ")],
    ["Peak context", `${formatInteger(run.execution.peak_context_tokens)} tokens (${run.execution.peak_context_percent.toFixed(4)}%)`],
    ["Compaction events", formatInteger(run.execution.compaction_events)],
    ["Input tokens", formatInteger(run.execution.tokens.input_tokens)],
    ["Output tokens", formatInteger(run.execution.tokens.output_tokens)],
    ["Cache-read tokens", formatInteger(run.execution.tokens.cache_read_tokens)],
    ["Cache-write tokens", formatInteger(run.execution.tokens.cache_write_tokens)],
    ["Reasoning tokens", formatInteger(run.execution.tokens.reasoning_tokens)],
    ["Total tokens", formatInteger(run.execution.tokens.total_tokens)],
    ["Event sum equals closure", String(run.execution.token_totals_match_closure)],
  ]));

  output.push("");
  output.push("## Tools and Named Operations");
  output.push("");
  output.push(`Tool events: started=${run.execution.tool_pairs.started}, called=${run.execution.tool_pairs.called}, completed=${run.execution.tool_pairs.completed}. Durations are sums of paired spans and can overlap when the runtime ran work concurrently.`);
  output.push("");
  output.push(markdownTable(["Tool", "Calls", "Error completions", "Span sum", "Max span"], run.execution.tools.map((tool) => [
    inlineCode(tool.tool_name),
    tool.completed,
    tool.errors,
    `${tool.duration_seconds_sum.toFixed(3)} s`,
    `${tool.duration_seconds_max.toFixed(3)} s`,
  ])));
  output.push("");
  output.push(markdownTable(["Operation family", "Category", "Started", "Completed", "Failed", "Open", "Observed span sum"], run.execution.named_operations.map((operation) => [
    inlineCode(operation.operation_family),
    operation.category,
    operation.started,
    operation.completed,
    operation.failed,
    operation.open,
    `${operation.duration_seconds_sum.toFixed(3)} s`,
  ])));

  output.push("");
  output.push("## HIL and Permission Summary");
  output.push("");
  output.push(markdownTable(["HIL category", "Requested", "Resolved", "Wait"], run.execution.hils.length > 0 ? run.execution.hils.map((hil) => [
    hil.category,
    hil.requested,
    hil.resolved,
    `${hil.wait_seconds.toFixed(3)} s`,
  ]) : [["none", 0, 0, "0 s"]]));
  output.push("");
  output.push(markdownTable(["Capability", "Scope", "Decision", "Count", "Observed wait"], run.execution.permissions.length > 0 ? run.execution.permissions.map((permission) => [
    permission.capability,
    permission.scope,
    permission.decision,
    permission.count,
    `${permission.wait_seconds.toFixed(3)} s`,
  ]) : [["none", "-", "-", 0, "0 s"]]));
  output.push("");
  output.push("Permission resources and request text are intentionally omitted from this derived report.");

  output.push("");
  output.push("## Publication and Formal Artifacts");
  output.push("");
  if (!publication) {
    output.push("No Publication was produced. There are no formal artifacts or formal artifact hashes for this terminal outcome.");
  } else {
    output.push(markdownTable(["Field", "Value"], [
      ["Current publication", inlineCode(publication.publication_id)],
      ["Requirement", inlineCode(publication.requirement_id)],
      ["Published at", publication.published_at],
      ["Manifest SHA-256", inlineCode(publication.manifest_sha256)],
      ["Package digest", inlineCode(publication.package_digest)],
      ["Artifact receipts verified", String(run.publication.formal_artifact_receipts_verified)],
      ["Product status", run.publication.product_status || "unavailable"],
    ]));
    output.push("");
    output.push(markdownTable(["Role", "Relative path", "Bytes", "SHA-256", "Receipt match"], run.publication.formal_artifacts.map((artifact) => [
      artifact.role,
      inlineCode(artifact.relative_path),
      formatInteger(artifact.size_bytes),
      inlineCode(artifact.sha256),
      String(artifact.receipt_verified),
    ])));
  }
  if (run.publication.publication_created_events.length > 0) {
    output.push("");
    output.push(markdownTable(["Publication event", "Published at", "Manifest SHA-256", "Supersedes"], run.publication.publication_created_events.map((event) => [
      inlineCode(event.publication_id),
      event.published_at,
      inlineCode(event.manifest_sha256),
      inlineCode(event.supersedes_publication_id),
    ])));
  }
  if (run.publication.b3) {
    output.push("");
    output.push(`B3 evidence: ${formatInteger(run.publication.b3.checked_count)} checks, ${formatInteger(run.publication.b3.failed_count)} failed, profile ${inlineCode(run.publication.b3.profile_ref)}.`);
  }

  output.push("");
  output.push("## Evidence Integrity and Redaction Boundary");
  output.push("");
  const integrity = run.source_evidence;
  output.push(markdownTable(["Check", "Value"], [
    ["Authoritative event source", inlineCode(integrity.authoritative_event_source.path)],
    ["Authoritative event SHA-256", inlineCode(integrity.authoritative_event_source.sha256)],
    ["Evidence manifest", `${integrity.evidence_manifest.verified}/${integrity.evidence_manifest.entries} verified, base=${integrity.evidence_manifest.base}`],
    ["Evidence manifest SHA-256", inlineCode(integrity.evidence_manifest.manifest_sha256)],
    ["Runtime comparison", integrity.runtime_event_comparison.byte_identical_to_runtime === undefined ? `object-identical=${integrity.runtime_event_comparison.api_refetch_object_identical_to_runtime}` : `byte-identical=${integrity.runtime_event_comparison.byte_identical_to_runtime}`],
  ]));
  if (integrity.supervisor_or_evidence_mirror) {
    output.push("");
    output.push(`Evidence mirror: ${inlineCode(integrity.supervisor_or_evidence_mirror.path)}, ${formatInteger(integrity.supervisor_or_evidence_mirror.event_count)} events, byte-identical=${integrity.supervisor_or_evidence_mirror.byte_identical_to_authoritative}, missing authoritative sequences=${integrity.supervisor_or_evidence_mirror.missing_authoritative_sequences.join(", ") || "none"}.`);
  }
  output.push("");
  output.push("The corresponding processed JSONL contains only lifecycle timestamps, counts, normalized tool/operation families, status codes, formal artifact hashes, and integrity checks. It excludes prompt bodies, assistant/reasoning deltas, tool arguments, tool outputs, HIL summaries, permission resources, and raw terminal/error messages.");
  output.push("");
  output.push("Back to the [campaign report](../report.md).");
  return `${output.join("\n")}\n`;
}

function buildProcessedLog(runs, campaign) {
  const rows = [];
  for (const run of runs) {
    const base = {
      schema_version: "1.0",
      campaign_id: campaign.campaign_id,
      run_label: run.label,
      task_id: run.identity.task_id,
      run_id: run.identity.run_id,
    };
    rows.push({
      ...base,
      kind: "run_summary",
      terminal_classification: run.lifecycle.terminal_classification,
      queued_at: run.lifecycle.queued_at,
      started_at: run.lifecycle.started_at,
      finished_at: run.lifecycle.finished_at,
      event_duration_seconds: run.lifecycle.event_duration_seconds,
      model_calls: run.execution.model_calls,
      total_tokens: run.execution.tokens.total_tokens,
      tool_calls: run.execution.tool_pairs.completed,
      user_input_required: run.execution.user_input_required,
      current_publication_id: run.publication.current_publication?.publication_id || null,
      formal_artifact_count: run.publication.formal_artifact_count,
    });
    rows.push({
      ...base,
      kind: "event_counts",
      event_count: run.execution.event_count,
      first_sequence: run.execution.first_sequence,
      last_sequence: run.execution.last_sequence,
      sequences_contiguous: run.execution.sequences_contiguous,
      context_usage_events: run.execution.context_usage_events,
      compaction_events: run.execution.compaction_events,
      operation_events: run.execution.named_operation_event_counts,
    });
    for (const tool of run.execution.tools) {
      rows.push({
        ...base,
        kind: "tool_summary",
        tool_name: tool.tool_name,
        calls_completed: tool.completed,
        error_completions: tool.errors,
        duration_seconds_sum: tool.duration_seconds_sum,
        duration_seconds_max: tool.duration_seconds_max,
      });
    }
    for (const operation of run.execution.named_operations) {
      rows.push({
        ...base,
        kind: "named_operation_summary",
        operation_family: operation.operation_family,
        category: operation.category,
        started: operation.started,
        completed: operation.completed,
        failed: operation.failed,
        open: operation.open,
        observed_duration_seconds_sum: operation.duration_seconds_sum,
      });
    }
    for (const hil of run.execution.hils) {
      rows.push({
        ...base,
        kind: "hil_summary",
        hil_category: hil.category,
        requested: hil.requested,
        resolved: hil.resolved,
        wait_seconds: hil.wait_seconds,
      });
    }
    for (const permission of run.execution.permissions) {
      rows.push({
        ...base,
        kind: "permission_summary",
        capability: permission.capability,
        scope: permission.scope,
        decision: permission.decision,
        count: permission.count,
        observed_wait_seconds: permission.wait_seconds,
      });
    }
    for (const publication of run.publication.publication_created_events) {
      rows.push({
        ...base,
        kind: "publication_event",
        publication_id: publication.publication_id,
        manifest_sha256: publication.manifest_sha256,
        published_at: publication.published_at,
        supersedes_publication_id: publication.supersedes_publication_id,
      });
    }
    for (const artifact of run.publication.formal_artifacts) {
      rows.push({
        ...base,
        kind: "formal_artifact",
        artifact_id: artifact.artifact_id,
        role: artifact.role,
        relative_path: artifact.relative_path,
        size_bytes: artifact.size_bytes,
        sha256: artifact.sha256,
        receipt_verified: artifact.receipt_verified,
      });
    }
    rows.push({
      ...base,
      kind: "evidence_integrity",
      authoritative_event_sha256: run.source_evidence.authoritative_event_source.sha256,
      evidence_manifest_sha256: run.source_evidence.evidence_manifest.manifest_sha256,
      evidence_manifest_entries: run.source_evidence.evidence_manifest.entries,
      evidence_manifest_verified: run.source_evidence.evidence_manifest.verified,
      runtime_comparison: run.source_evidence.runtime_event_comparison.method,
      runtime_match: run.source_evidence.runtime_event_comparison.byte_identical_to_runtime ?? run.source_evidence.runtime_event_comparison.api_refetch_object_identical_to_runtime ?? null,
    });
  }
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function buildReportMarkdown({ campaign, runs, diagnostics, crossRoute, qoder }) {
  const publicationRuns = runs.filter((run) => run.lifecycle.terminal_classification === "succeeded_publication");
  const output = [];
  output.push("# Gold6-10 Corrected Campaign Session Report");
  output.push("");
  output.push("## Scope");
  output.push("");
  output.push("This report fixes the primary cohort before comparison: Gold6 Flash, Gold7 Flash, Gold8 Flash, Gold9 Flash, Gold10 Flash, and corrected Gold6 Max v2. All six ran against product commit `e5aadfe0c46dacddda9464656c551bea0e203ba3`. The cohort contains five `succeeded_publication` terminals and one valid `blocked_no_publication` terminal. The invalid-profile batch, Gold6 Max v1, Gold9 proxy, and Gold9 dynamic-first runs are diagnostic appendices only and are excluded from the primary rates and totals.");
  output.push("");
  output.push(`Campaign ID: ${inlineCode(campaign.campaign_id)}. Model profile: reasoning=${campaign.model_profile.reasoning_effort}, thinking=${campaign.model_profile.thinking_mode}, search=${campaign.model_profile.enable_search}.`);

  output.push("");
  output.push("## Main Results");
  output.push("");
  output.push(markdownTable([
    "Run",
    "Prompt provenance",
    "Model",
    "Terminal",
    "Event-derived wall time",
    "Calls",
    "Total tokens",
    "Tools",
    "Business HILs",
    "Formal artifacts",
  ], runs.map((run) => [
    `[${run.display_name}](${runHref(run)})`,
    run.identity.prompt_provenance,
    inlineCode(run.identity.model),
    inlineCode(run.lifecycle.terminal_classification),
    `${run.lifecycle.event_duration_seconds.toFixed(3)} s`,
    formatInteger(run.execution.model_calls),
    formatInteger(run.execution.tokens.total_tokens),
    formatInteger(run.execution.tool_pairs.completed),
    formatInteger(run.execution.user_input_required),
    formatInteger(run.publication.formal_artifact_count),
  ])));
  output.push("");
  output.push(`Formal publication success rate: ${publicationRuns.length}/${runs.length} (${formatPercent(publicationRuns.length / runs.length)}). This is an outcome rate over heterogeneous Gold requirements, not a controlled benchmark of model quality.`);
  output.push("");
  output.push("Publication success is not synonymous with full scientific-task completion: Gold8 formally published the FAERS assertion/study dimension while other requested integration dimensions remained staging. Conversely, Gold10 is a task-level non-completion whose zero-Publication outcome is useful evidence that the formal boundary failed closed. Publication-level artifact-quality comparisons therefore cover only the five runs with formal outputs and must retain each run's Paper-Use Boundary.");

  output.push("");
  output.push("## Measurement Method");
  output.push("");
  output.push("Each principal run is rebuilt from the evidence-pack manifest, selected authoritative JSONL stream, closure, run metadata, and formal artifact receipts. The generator validates manifest entries, sequence contiguity, lifecycle timestamps, context-usage sums against closure token totals, tool pairing, and formal artifact receipt hashes. Raw assistant/reasoning deltas, prompt content, tool arguments, tool outputs, permission resources, and raw error text are deliberately excluded from this report and from `processed-log.jsonl`.");
  output.push("");
  output.push("Wall time is always the `run_started` to terminal-event interval from the selected authoritative stream. Gold8 is the material reconciliation: monitor metadata states 2174.166 s, while event timestamps yield 2754.172 s. The latter is used throughout.");

  output.push("");
  output.push("## Publication and Artifact Evidence");
  output.push("");
  output.push(markdownTable(["Run", "Current Publication", "Manifest SHA-256", "Package digest", "Artifacts", "Receipt verification"], runs.map((run) => [
    run.display_name,
    inlineCode(run.publication.current_publication?.publication_id),
    inlineCode(run.publication.current_publication?.manifest_sha256),
    inlineCode(run.publication.current_publication?.package_digest),
    run.publication.formal_artifact_count,
    run.publication.formal_artifact_receipts_verified === null ? "not applicable" : String(run.publication.formal_artifact_receipts_verified),
  ])));
  output.push("");
  output.push("The individual run reports list the final formal artifact paths, bytes, SHA-256 values, and receipt checks. Gold7 has two independent run-bound publications (ten artifacts across history); its current risk-loci publication is the primary formal projection. Gold6 Flash and Gold9 each emitted an earlier publication that was superseded by the listed current publication.");

  output.push("");
  output.push("## Prompt Provenance and Comparability");
  output.push("");
  output.push("Gold6 Flash and Gold6 Max v2 share the exact-data Gold6 prompt and frozen execution-context lineage. Gold6 Max v2 is nevertheless not a pure model-only comparison: it ran through the isolated proxy host and corrects the Max registry metadata to a 1,000,000-token context and 32,768-token maximum output. Gold7, Gold8, and Gold10 use reconstructed historical TOPIC prompts. Gold9 uses an exact original `run_queued.input` recovered from the durable event stream. Therefore, aggregate campaign results establish observed terminal behavior and evidence integrity, not interchangeable task difficulty or causal model ranking.");

  output.push("");
  output.push("## Gold9 Three-Route Analysis");
  output.push("");
  output.push(markdownTable(["Route", "Prompt", "Final semantic route", "Acquisition", "Deterministic terminal barrier", "Outcome"], [
    ["Original frozen/direct", "exact frozen", "static -> dynamic_family", "initial direct download failures; later carriers acquired", "static rejection observed before dynamic pivot", "published v2"],
    ["Frozen/proxy", "same frozen SHA", "static", "all 24 attempts succeeded", "INVALID_INPUT / conflicting ClinGen classifications", "blocked_no_publication"],
    ["Dynamic-first variant", "variant, not frozen", "static", "12 Core attempts succeeded", "INVALID_INPUT / conflicting OMIM identifiers; requested profile rejected", "blocked_no_publication"],
  ]));
  output.push("");
  output.push("Proven facts: the direct run changed its durable route immediately after successful dynamic-family preparation and then emitted publication events; the frozen proxy run never selected that route and failed 15 static execution attempts; the dynamic-first directive did not create an unavailable four-table profile and the run remained static. Strongly supported inference: successful network acquisition alone was insufficient, because both proxy diagnostics acquired inputs and still failed deterministic static validation. Unproven: a model-level causal explanation for the direct agent's route choice. The successful direct dynamic publication uses a different scientific-assertion publication profile from the requested static four-table product, so it is not a controlled like-for-like quality comparison.");
  output.push("");
  output.push(`Structured route evidence is recorded in ${inlineCode("results.json")}, field ${inlineCode("gold9_cross_route")}.`);

  output.push("");
  output.push("## Gold6 Qoder Offline 2x2 Analysis");
  output.push("");
  output.push("The Qoder Flash/Max zip comparison is an offline, read-only artifact analysis. It is not part of the principal run cohort and neither zip is a formal BioMed-QAgent Publication. Source zips: Flash SHA-256 `" + qoder.source_archives.flash_zip_sha256 + "`; Max SHA-256 `" + qoder.source_archives.max_zip_sha256 + "`.");
  output.push("");
  output.push(markdownTable(["Side", "Structural coverage/reuse (X)", "Evidence auditability (Y)", "Placement"], [
    ["Flash", qoder.placement.flash.x, qoder.placement.flash.y, qoder.placement.flash.quadrant],
    ["Max", qoder.placement.max.x, qoder.placement.max.y, qoder.placement.max.quadrant],
  ]));
  output.push("");
  output.push("Key measured differences: Flash has finer provenance granularity (10,215 distinct locations across 10,682 facts versus 11 across 6,439); Flash's manifest has a self-referential SHA-1 mismatch and truncated SHA-1 prefixes while Max validates 5/5 full MD5 entries; and neither offline export contains the raw payloads or scripts referenced by its methods log. The offline analysis verification has `" + qoder.source_outputs.verification_entries + "` checked hashes and pass=`" + qoder.source_outputs.verification_pass + "`. Its source root is `" + qoder.source_root + "`.");

  output.push("");
  output.push("## Diagnostic Appendices Excluded from Main Statistics");
  output.push("");
  output.push(markdownTable(["Diagnostic", "Observed condition", "Why excluded"], [
    ["Initial Flash batch", `${diagnostics.invalid_profile_batch.runs} failed runs; ${diagnostics.invalid_profile_batch.model_calls} rejected provider calls; 0 tokens/tools/HIL/artifacts`, diagnostics.invalid_profile_batch.exclusion_reason],
    ["Gold6 Max v1", `${diagnostics.gold6_max_v1.context_window_tokens}-token metadata; ${diagnostics.gold6_max_v1.compaction_events} compactions; terminal ${diagnostics.gold6_max_v1.terminal_code}`, diagnostics.gold6_max_v1.exclusion_reason],
    ["Gold9 frozen/proxy", `${diagnostics.gold9_frozen_proxy.execute_attempts} static execute attempts; no publication`, diagnostics.gold9_frozen_proxy.exclusion_reason],
    ["Gold9 dynamic-first", `profile scaffold rejected; ${diagnostics.gold9_dynamic_first.execute_attempts} INVALID_INPUT failures; no publication`, diagnostics.gold9_dynamic_first.exclusion_reason],
  ]));

  output.push("");
  output.push("## Reproduction and Derived Files");
  output.push("");
  output.push("Run the generator from a checkout containing this script:");
  output.push("");
  output.push("```bash");
  output.push("node scripts/generate-gold6-10-session-report.mjs \\");
  output.push("  --campaign-root /home/modenicheng/coding/BioMed-QAgent/data/gold-campaigns/2026-09-03-main-e5aadfe0-qwen38-six-run-corrected \\");
  output.push("  --output-dir docs/evaluation/gold6-10-2026-09-03");
  output.push("```");
  output.push("");
  output.push("Derived files: `results.json` (structured facts), `processed-log.jsonl` (redacted normalized event summaries), six reports under `runs/`, and `evidence-manifest.sha256` (SHA-256 of every derived artifact except itself). The generator verifies its own JSON output, every generated manifest entry, and credential-like patterns without printing any match content.");
  return `${output.join("\n")}\n`;
}

function writeText(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function writeJson(file, value) {
  writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

function credentialScan(files) {
  let matches = 0;
  for (const file of files) {
    const content = readText(file);
    for (const expression of CREDENTIAL_PATTERNS) {
      expression.lastIndex = 0;
      const found = content.match(expression);
      matches += found ? found.length : 0;
    }
  }
  return { files_scanned: files.length, patterns_checked: CREDENTIAL_PATTERNS.length, matches, status: matches === 0 ? "no_hits" : "hits_detected" };
}

function writeDerivedManifest(outputDir, relativeFiles) {
  const lines = relativeFiles
    .slice()
    .sort()
    .map((relativeFile) => `${sha256File(path.join(outputDir, relativeFile))}  ${relativeFile}`);
  const manifestPath = path.join(outputDir, "evidence-manifest.sha256");
  writeText(manifestPath, `${lines.join("\n")}\n`);
  return manifestPath;
}

function verifyDerivedManifest(outputDir, manifestPath) {
  const entries = readText(manifestPath)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^([0-9a-f]{64})\s{2}(.+)$/);
      if (!match) throw new Error(`Malformed derived manifest line: ${line}`);
      return { sha256: match[1], relative: match[2] };
    });
  for (const entry of entries) {
    const target = safeManifestPath(outputDir, entry.relative);
    if (sha256File(target) !== entry.sha256) {
      throw new Error(`Derived manifest mismatch for ${entry.relative}`);
    }
  }
  return { entries: entries.length, pass: true, sha256: sha256File(manifestPath) };
}

function buildResults({ campaign, runs, diagnostics, crossRoute, qoder, outputDir }) {
  const published = runs.filter((run) => run.lifecycle.terminal_classification === "succeeded_publication").length;
  const totalTokens = runs.reduce((total, run) => total + run.execution.tokens.total_tokens, 0);
  const totalWallSeconds = runs.reduce((total, run) => total + run.lifecycle.event_duration_seconds, 0);
  return {
    schema_version: "1.0",
    report_id: "gold6-10-2026-09-03-corrected-session",
    generator: {
      script: "scripts/generate-gold6-10-session-report.mjs",
      script_version: SCRIPT_VERSION,
      script_sha256: sha256File(SCRIPT_PATH),
      deterministic_generation: "No wall-clock generation timestamp is emitted; output is determined by the named evidence inputs and generator version.",
    },
    campaign: {
      campaign_id: campaign.campaign_id,
      product_commit: campaign.product_commit,
      models: campaign.models,
      model_profile: campaign.model_profile,
      prompt_provenance: campaign.prompt_provenance,
      concurrency_plan: campaign.concurrency_plan,
    },
    primary_cohort: {
      definition: RUN_SPECS.map((spec) => spec.key),
      run_count: runs.length,
      succeeded_publication_count: published,
      blocked_no_publication_count: runs.filter((run) => run.lifecycle.terminal_classification === "blocked_no_publication").length,
      publication_success_rate: published / runs.length,
      total_event_derived_wall_seconds: Number(totalWallSeconds.toFixed(3)),
      total_tokens: totalTokens,
      comparability_note: "The cohort is a collection of heterogeneous Gold requirements. Prompt provenance, route, host, and context metadata differences preclude a causal model ranking.",
    },
    redaction_policy: {
      excluded_from_processed_outputs: [
        "prompt bodies",
        "assistant and reasoning deltas",
        "tool arguments",
        "tool outputs",
        "permission resource paths and summaries",
        "raw errors and terminal text",
      ],
      retained: [
        "lifecycle timestamps",
        "aggregate token counts",
        "tool and operation families with counts and durations",
        "HIL and permission categories with counts and wait times",
        "publication and formal artifact identifiers, sizes, and SHA-256 hashes",
        "evidence integrity checks",
      ],
    },
    runs,
    gold9_cross_route: crossRoute,
    qoder_gold6_offline_2x2: qoder,
    diagnostics_excluded_from_primary: diagnostics,
    verification: {
      json_parse: "pending_generation_check",
      processed_log_jsonl_parse: "pending_generation_check",
      derived_manifest: "pending_generation_check",
      credential_scan: "pending_generation_check",
      output_directory: outputDir,
    },
  };
}

function verifyJsonl(file) {
  let rows = 0;
  for (const line of readText(file).split(/\r?\n/)) {
    if (!line) continue;
    JSON.parse(line);
    rows += 1;
  }
  if (rows === 0) throw new Error("Processed log is empty");
  return rows;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const campaignRoot = requirePath(args["campaign-root"], "--campaign-root");
  const outputDir = requirePath(args["output-dir"], "--output-dir");
  const repoRoot = path.resolve(campaignRoot, "..", "..", "..");
  const campaign = readJson(path.join(campaignRoot, "campaign.json"));

  const runs = RUN_SPECS.map((spec) => deriveRun({ campaignRoot, repoRoot, campaign, spec }));
  const diagnostics = loadDiagnostics(campaignRoot, repoRoot, args["diagnostic-root"]);
  const qoder = loadQoderAnalysis(campaignRoot, repoRoot, args["qoder-analysis-root"]);
  const originalGold9 = runs.find((run) => run.label === "gold9-flash");
  const crossRoute = g9CrossRoute(originalGold9, diagnostics);

  const reportPath = path.join(outputDir, "report.md");
  const resultsPath = path.join(outputDir, "results.json");
  const processedLogPath = path.join(outputDir, "processed-log.jsonl");
  const runFiles = runs.map((run) => path.join(outputDir, "runs", `${run.label}.md`));

  const results = buildResults({ campaign, runs, diagnostics, crossRoute, qoder, outputDir: relativeTo(repoRoot, outputDir) });
  writeText(reportPath, buildReportMarkdown({ campaign, runs, diagnostics, crossRoute, qoder }));
  for (const run of runs) {
    writeText(path.join(outputDir, "runs", `${run.label}.md`), buildRunMarkdown(run, campaign));
  }
  writeText(processedLogPath, buildProcessedLog(runs, campaign));
  writeJson(resultsPath, results);

  JSON.parse(readText(resultsPath));
  const processedRows = verifyJsonl(processedLogPath);
  const derivedFiles = [
    "processed-log.jsonl",
    "report.md",
    "results.json",
    ...runs.map((run) => `runs/${run.label}.md`),
  ];

  let scan = credentialScan(derivedFiles.map((relative) => path.join(outputDir, relative)));
  if (scan.matches !== 0) {
    throw new Error(`Credential-like patterns were found in generated output: ${scan.matches}`);
  }
  results.verification = {
    json_parse: "pass",
    processed_log_jsonl_parse: { status: "pass", rows: processedRows },
    derived_manifest: "pending",
    credential_scan: scan,
  };
  writeJson(resultsPath, results);

  const manifestPath = writeDerivedManifest(outputDir, derivedFiles);
  const manifest = verifyDerivedManifest(outputDir, manifestPath);
  scan = credentialScan([...derivedFiles.map((relative) => path.join(outputDir, relative)), manifestPath]);
  if (scan.matches !== 0) {
    throw new Error(`Credential-like patterns were found after manifest generation: ${scan.matches}`);
  }
  results.verification = {
    json_parse: "pass",
    processed_log_jsonl_parse: { status: "pass", rows: processedRows },
    derived_manifest: { status: "pass", entries: manifest.entries }, 
    credential_scan: scan,
  };
  writeJson(resultsPath, results);
  const finalManifest = writeDerivedManifest(outputDir, derivedFiles);
  verifyDerivedManifest(outputDir, finalManifest);

  process.stdout.write(JSON.stringify({
    output_dir: outputDir,
    report: reportPath,
    results: resultsPath,
    processed_log: processedLogPath,
    manifest: finalManifest,
    runs: runs.length,
    published: runs.filter((run) => run.lifecycle.terminal_classification === "succeeded_publication").length,
    processed_log_rows: processedRows,
  }, null, 2));
  process.stdout.write("\n");
}

try {
  main();
} catch (error) {
  process.stderr.write(`gold6-10 report generation failed: ${error.stack || error.message}\n`);
  process.exitCode = 1;
}
