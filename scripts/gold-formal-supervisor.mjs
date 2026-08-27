#!/usr/bin/env node
/**
 * Gold formal rerun supervisor.
 *
 * Stdlib-only and intentionally external to the production Dataset Core. It
 * drives one pre-created task, records the durable event stream, handles only
 * a tiny allow-list of safe permissions, and stops for every business review.
 * A human must review the emitted report before a separate --resume
 * invocation. This program never executes commands itself.
 */
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export const EXIT_CODES = Object.freeze({
  SUCCESS: 0,
  USAGE: 2,
  HEALTH: 10,
  TASK: 11,
  ACTIVE_RUN: 12,
  PERMISSION: 20,
  DATA_REVIEW: 21,
  TERMINAL: 30,
  ARTIFACT: 31,
  TIMEOUT: 32,
  PROTOCOL: 33,
});

export const TERMINAL_RUN_STATUSES = Object.freeze([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

const TERMINAL_RUN_SET = new Set(TERMINAL_RUN_STATUSES);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const DEFAULT_TIMEOUT_MS = 3_600_000;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PROMPT_BYTES = 64 * 1024;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const FIXED_PARSER_EXECUTABLES = new Set(["node", "node.exe"]);
const FIXED_PARSER_SCRIPT = /^parse(?:[-_][a-z0-9][a-z0-9_-]*)?\.m?js$/iu;
const SECRET_KEY = /(?:access[_-]?token|api[_-]?key|authorization|credential|password|private[_-]?key|secret|token)/iu;
const SECRET_BASENAME = /^(?:\.env(?!\.example$)(?:\..*)?|credentials?\.json|secrets?\.json|.*\.(?:key|pem|p12|pfx)|.*(?:secret|credential|token|password|private[_-]?key).*)$/iu;
const SHELL_META = /[;&|<>`\n\r$()]/u;

export class SupervisorError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "SupervisorError";
    this.code = code;
    this.details = details;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new SupervisorError("protocol", `${name} must be a non-empty string`);
  }
  return value;
}

function safeId(value, name) {
  nonEmptyString(value, name);
  if (!SAFE_ID.test(value)) throw new SupervisorError("protocol", `${name} is not a safe identifier`);
  return value;
}

function normalizedBaseUrl(value = "http://127.0.0.1:5173") {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
    if (url.username !== "" || url.password !== "") throw new Error("credentials in base-url are not allowed");
    url.pathname = url.pathname.replace(/\/+$/u, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/u, "");
  } catch (error) {
    throw new SupervisorError("usage", `base-url is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function pathWithin(root, candidate) {
  const rootPath = path.resolve(root);
  const candidatePath = path.resolve(candidate);
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function sensitivePath(value) {
  const base = value.replaceAll("\\", "/").split("/").at(-1) ?? "";
  return SECRET_BASENAME.test(base);
}

function redacted(value, key = "") {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    if (/\bBearer\s+[A-Za-z0-9._~+/=-]+/iu.test(value)) return value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]");
    if (/https?:\/\/[^\s/]+\/[^\s]*[?&](?:token|key|secret|signature)=/iu.test(value)) return "[REDACTED_URL]";
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => redacted(item));
  if (isRecord(value)) {
    const result = {};
    for (const [childKey, childValue] of Object.entries(value)) result[childKey] = redacted(childValue, childKey);
    return result;
  }
  return value;
}

function normalizedCommand(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/gu, " ") : null;
}

/**
 * Return true only for the fixed, shell-free parser form `node parse*.m?js`
 * whose command and working directory stay inside this task workspace.
 * Arguments are deliberately disallowed: a parser may only be invoked by its
 * fixed entry point, never with an attacker-controlled output or URL.
 */
export function isFixedParserCommand(command, cwd, workspaceRoot) {
  if (typeof command !== "string" || typeof cwd !== "string" || typeof workspaceRoot !== "string") return false;
  if (SHELL_META.test(command) || /(?:https?:\/\/|\.env(?:\.|$)|secret|credential|token|password|private[_-]?key)/iu.test(command)) return false;
  const parts = command.trim().split(/\s+/u);
  if (parts.length !== 2) return false;
  const executable = path.basename(parts[0] ?? "").toLowerCase();
  const script = parts[1] ?? "";
  if (!FIXED_PARSER_EXECUTABLES.has(executable) || !FIXED_PARSER_SCRIPT.test(path.basename(script))) return false;
  if (!pathWithin(workspaceRoot, cwd)) return false;
  if (path.isAbsolute(script) || script.includes("\\")) return false;
  const scriptPath = path.resolve(cwd, script);
  return pathWithin(workspaceRoot, scriptPath) && !sensitivePath(scriptPath);
}

/**
 * Fail-closed permission classifier. It has no network/shell/secret branch.
 * `canonical_resource` is preferred because the Host already canonicalizes it.
 */
export function classifyPermission(request, options = {}) {
  if (!isRecord(request)) return { action: "stop", reason: "malformed permission request" };
  const workspaceRoot = options.workspaceRoot;
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) {
    return { action: "stop", reason: "current task workspace is unavailable" };
  }
  const resource = request.canonical_resource ?? request.resource;
  if (request.capability === "fs.read" && request.scope === "workspace" && typeof resource === "string") {
    if (pathWithin(workspaceRoot, resource) && !sensitivePath(resource)) {
      return {
        action: "allow",
        decision: "allow",
        grant_scope: "once",
        reason: "strict workspace fs.read",
      };
    }
    return { action: "stop", reason: "fs.read target is outside workspace or sensitive" };
  }
  if (request.capability === "process.exec" && request.scope === "workspace") {
    if (isFixedParserCommand(request.command, request.cwd, workspaceRoot)) {
      return {
        action: "allow",
        decision: "allow",
        grant_scope: "once",
        reason: "fixed shell-free parser command",
      };
    }
    return { action: "stop", reason: "process.exec is not a fixed parser command" };
  }
  return { action: "stop", reason: "capability is not automatically allowed" };
}

/** Validate bytes as strict, canonical UTF-8 text and reject U+FFFD. */
export function validateCleanUtf8Bytes(bytes, label = "input") {
  if (!(bytes instanceof Uint8Array)) throw new SupervisorError("usage", `${label} must be bytes`);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new SupervisorError("usage", `${label} is not valid UTF-8`, { cause: String(error) });
  }
  if (Buffer.from(text, "utf8").compare(Buffer.from(bytes)) !== 0) throw new SupervisorError("usage", `${label} is not canonical UTF-8`);
  return validateCleanUtf8Text(text, label);
}

export function validateCleanUtf8Text(text, label = "input") {
  nonEmptyString(text, label);
  if (text.includes("\uFFFD")) throw new SupervisorError("usage", `${label} contains U+FFFD replacement character`);
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)) {
    throw new SupervisorError("usage", `${label} contains a lone UTF-16 surrogate`);
  }
  return text;
}

export async function readCleanPrompt(promptFile) {
  const bytes = await readFile(promptFile);
  if (bytes.length > MAX_PROMPT_BYTES) throw new SupervisorError("usage", "prompt is too large");
  const text = validateCleanUtf8Bytes(bytes, promptFile);
  if (text.trim() === "") throw new SupervisorError("usage", "prompt must not be empty");
  return text;
}

/** Parse a JSONL file; a malformed final record is not silently discarded. */
export async function readJsonl(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  const records = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] === "") throw new SupervisorError("protocol", `${file} contains an empty line`);
    try {
      records.push(JSON.parse(lines[index]));
    } catch (error) {
      throw new SupervisorError("protocol", `${file} line ${index + 1} is invalid JSON`, { cause: String(error) });
    }
  }
  return records;
}

export async function appendJsonl(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(redacted(value))}\n`, "utf8");
}

async function atomicWrite(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  await writeFile(temporary, value, { encoding: "utf8", flag: "wx" });
  try {
    await unlink(file);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
  await rename(temporary, file);
}

async function readState(evidenceDir) {
  const file = path.join(evidenceDir, "supervisor-state.json");
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    if (!isRecord(value) || value.version !== 1 || !Number.isSafeInteger(value.after_sequence) || value.after_sequence < 0) {
      throw new Error("state must contain version 1 and a non-negative after_sequence");
    }
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return {
      version: 1,
      after_sequence: 0,
      task_id: null,
      case_label: null,
      request_id: null,
      run_id: null,
      stopped: false,
      pending_hil: null,
    };
    throw new SupervisorError("protocol", "supervisor state is invalid", { cause: String(error) });
  }
}

async function writeState(evidenceDir, state) {
  await atomicWrite(path.join(evidenceDir, "supervisor-state.json"), `${JSON.stringify(redacted(state))}\n`);
}

function route(root, pathname) {
  return new URL(pathname, `${root}/`).toString();
}

async function responseJson(response) {
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_JSON_BYTES) throw new SupervisorError("protocol", "Host JSON response is too large");
  const text = validateCleanUtf8Bytes(bytes, "Host response");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new SupervisorError("protocol", `Host response is invalid JSON: ${String(error)}`);
  }
}

/** Small injectable HTTP client used by tests and the CLI. */
export function createApiClient(baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch) {
  const root = normalizedBaseUrl(baseUrl);
  if (typeof fetchImpl !== "function") throw new SupervisorError("protocol", "fetch is unavailable");
  async function request(method, pathname, body = undefined) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(route(root, pathname), {
        method,
        headers: body === undefined
          ? { accept: "application/json" }
          : { accept: "application/json", "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const parsed = await responseJson(response);
      if (!response.ok) throw new SupervisorError("http", `Host returned HTTP ${response.status}`, { status: response.status });
      return parsed;
    } catch (error) {
      if (error?.name === "AbortError") throw new SupervisorError("timeout", `HTTP request timed out after ${timeoutMs}ms`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  async function download(pathname) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(route(root, pathname), { headers: { accept: "application/octet-stream" }, signal: controller.signal });
      if (!response.ok) throw new SupervisorError("http", `Host returned HTTP ${response.status}`, { status: response.status });
      return { bytes: Buffer.from(await response.arrayBuffer()), headers: response.headers };
    } catch (error) {
      if (error?.name === "AbortError") throw new SupervisorError("timeout", `artifact download timed out after ${timeoutMs}ms`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  return Object.freeze({ root, request, download });
}

/** Parse the formal event page shape. */
export function parseEventPage(body) {
  if (!isRecord(body) || !Array.isArray(body.events)) throw new SupervisorError("protocol", "event page must contain events[]");
  return body.events;
}

/** Backward-compatible helper for callers that normalize duplicate pages. */
export function dedupeEvents(events, afterSequence = 0) {
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new SupervisorError("protocol", "event cursor is invalid");
  const bySequence = new Map();
  for (const event of events) {
    if (!isRecord(event) || !Number.isSafeInteger(event.sequence) || event.sequence < 1) throw new SupervisorError("protocol", "event sequence is invalid");
    if (event.sequence <= afterSequence) continue;
    const prior = bySequence.get(event.sequence);
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(event)) throw new SupervisorError("protocol", "event sequence was repeated with different content");
    bySequence.set(event.sequence, event);
  }
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
}

/** Validate one page and require a contiguous cursor from `after`. */
export function validateEventPage(body, after = 0, taskId = null) {
  const events = dedupeEvents(parseEventPage(body), after);
  if (!Number.isSafeInteger(after) || after < 0) throw new SupervisorError("protocol", "event cursor is invalid");
  let cursor = after;
  for (const event of events) {
    if (taskId !== null && event.task_id !== taskId) throw new SupervisorError("protocol", "event task identity mismatch");
    if (event.sequence !== cursor + 1) throw new SupervisorError("protocol", `event cursor gap: expected ${cursor + 1}, got ${event.sequence}`);
    cursor = event.sequence;
  }
  return { events, nextSequence: cursor };
}

function eventPayload(event) {
  return isRecord(event) && isRecord(event.payload) ? event.payload : null;
}

function eventType(event) {
  return isRecord(event) && typeof event.type === "string" ? event.type : eventPayload(event)?.type;
}

function permissionRequest(event) {
  return eventType(event) === "permission_requested" ? eventPayload(event) : null;
}

function hilRequest(event) {
  if (eventType(event) !== "user_input_required") return null;
  const payload = eventPayload(event);
  if (payload === null) return null;
  return isRecord(payload.hil_request) ? payload.hil_request : payload;
}

/** All data_review variants are a hard stop, including acceptance review types. */
export function classifyHIL(event) {
  const request = hilRequest(event);
  if (request === null) return null;
  const detail = isRecord(request.detail) ? request.detail : {};
  const kind = typeof request.kind === "string"
    ? request.kind
    : typeof detail.kind === "string" ? detail.kind : null;
  const reviewType = typeof request.review_type === "string"
    ? request.review_type
    : typeof request.reviewType === "string"
      ? request.reviewType
      : typeof detail.review_type === "string" ? detail.review_type : null;
  const dataReview = kind === "data_review" ||
    request.prompt_kind === "data_correction" ||
    reviewType === "data_review" ||
    reviewType === "browser_evidence_acceptance" ||
    reviewType === "publication_acceptance";
  return {
    action: "stop",
    reason: dataReview ? "data_review_requires_human" : "human_review_requires_human",
    request_id: typeof request.request_id === "string" ? request.request_id : null,
    evidence_digest: typeof request.evidence_digest === "string" ? request.evidence_digest : null,
    kind,
    review_type: reviewType,
    request,
  };
}

/** Terminal classifier used by both the supervisor and fixture tests. */
export function classifyTerminal({ run, publication }) {
  const runStatus = run?.status ?? null;
  const hasPublication = publication !== null && publication !== undefined;
  if (runStatus === "completed" && hasPublication) {
    return { classification: "succeeded_publication", publication };
  }
  if (runStatus === "completed" && !hasPublication) return { classification: "blocked_no_publication", publication: null };
  if (TERMINAL_RUN_SET.has(runStatus)) {
    return { classification: "failed_or_cancelled", status: runStatus, publication: publication ?? null };
  }
  return { classification: "nonterminal", status: runStatus, publication: publication ?? null };
}

export function verifyArtifactBytes(bytes, receipt, label = receipt?.artifact_id ?? "artifact") {
  if (!(bytes instanceof Uint8Array) || !isRecord(receipt)) throw new SupervisorError("artifact", `${label} receipt is invalid`);
  const expectedSize = receipt.size ?? receipt.size_bytes;
  const expectedSha = receipt.sha256;
  if (!Number.isInteger(expectedSize) || expectedSize < 0 || typeof expectedSha !== "string" || !SHA256.test(expectedSha)) throw new SupervisorError("artifact", `${label} receipt is invalid`);
  const actualSize = bytes.byteLength;
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSize !== expectedSize || actualSha256 !== expectedSha) {
    throw new SupervisorError("artifact", `${label} file digest mismatch`, {
      expected_size: expectedSize,
      actual_size: actualSize,
      expected_sha256: expectedSha,
      actual_sha256: actualSha256,
    });
  }
  return { size: actualSize, sha256: actualSha256 };
}

export function digestManifestFile(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new SupervisorError("artifact", "manifest bytes are invalid");
  return createHash("sha256").update(bytes).digest("hex");
}

/** Same package-digest algorithm as the TS publish manifest (path + NUL + hash). */
export function digestPackage(receipts) {
  if (!Array.isArray(receipts)) throw new SupervisorError("artifact", "package receipts are invalid");
  const sorted = [...receipts].map((receipt) => {
    if (!isRecord(receipt) || typeof receipt.relative_path !== "string" || receipt.relative_path === "" || typeof receipt.sha256 !== "string" || !SHA256.test(receipt.sha256)) throw new SupervisorError("artifact", "package receipt is invalid");
    return receipt;
  }).sort((left, right) => left.relative_path < right.relative_path ? -1 : left.relative_path > right.relative_path ? 1 : 0);
  const hash = createHash("sha256");
  for (const receipt of sorted) hash.update(`${receipt.relative_path}\u0000${receipt.sha256}\u0000`, "utf8");
  return hash.digest("hex");
}

async function writeHilReport(evidenceDir, taskId, runId, hil, reason) {
  const report = {
    schema_version: "1.0",
    task_id: taskId,
    run_id: runId,
    request_id: hil.request_id,
    kind: hil.kind,
    review_type: hil.review_type,
    evidence_digest: hil.evidence_digest,
    reason,
    instruction: "Human review is required. Resolve the HIL through the Host, then invoke --resume.",
    request: redacted(hil.request),
  };
  await atomicWrite(path.join(evidenceDir, "HIL-STOP.json"), `${JSON.stringify(report, null, 2)}\n`);
  await appendJsonl(path.join(evidenceDir, "supervisor-events.jsonl"), { type: "hil_stop", report });
  return report;
}

function activeRunId(snapshot) {
  return isRecord(snapshot?.task) && (snapshot.task.active_run_id === null || typeof snapshot.task.active_run_id === "string")
    ? snapshot.task.active_run_id
    : undefined;
}

function requireTask(snapshot, taskId) {
  if (!isRecord(snapshot) || !isRecord(snapshot.task) || snapshot.task.task_id !== taskId) throw new SupervisorError("task", "task identity is missing or mismatched");
  if (snapshot.task.mode !== "agent") throw new SupervisorError("task", "formal rerun requires an agent task");
}

function runFrom(snapshot, runId) {
  if (!Array.isArray(snapshot?.runs)) return null;
  return snapshot.runs.find((run) => isRecord(run) && run.run_id === runId) ?? null;
}

function currentPublicationIdFrom(snapshot) {
  const value = isRecord(snapshot?.task) ? snapshot.task.current_publication_id : undefined;
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new SupervisorError("protocol", "current_publication_id is malformed");
  return value;
}

/** Strict summary view; run binding (detail.run_id) is enforced by the caller. */
function publicationSummaryOf(detail) {
  if (
    !isRecord(detail)
    || typeof detail.publication_id !== "string"
    || typeof detail.run_id !== "string"
    || !isRecord(detail.publication)
  ) throw new SupervisorError("protocol", "publication detail response is invalid");
  return {
    publication_id: detail.publication_id,
    requirement_id: typeof detail.requirement_id === "string" ? detail.requirement_id : null,
    manifest_ref: typeof detail.manifest_ref === "string" ? detail.manifest_ref : null,
    manifest_sha256: typeof detail.publication.manifest_sha256 === "string" ? detail.publication.manifest_sha256 : null,
    published_at: typeof detail.publication.published_at === "string" ? detail.publication.published_at : null,
  };
}

function artifactReceipts(detail) {
  const entries = Array.isArray(detail?.artifacts)
    ? detail.artifacts
    : isRecord(detail?.manifest) && Array.isArray(detail.manifest.artifacts)
      ? detail.manifest.artifacts
      : null;
  if (!Array.isArray(entries)) throw new SupervisorError("artifact", "publication artifacts are missing");
  return entries.map((item) => {
    if (
      !isRecord(item)
      || typeof item.artifact_id !== "string"
      || !SAFE_ID.test(item.artifact_id)
      || typeof item.relative_path !== "string"
      || item.relative_path === ""
      || typeof item.sha256 !== "string"
      || !SHA256.test(item.sha256)
    ) throw new SupervisorError("artifact", "artifact receipt is invalid");
    if (item.artifact_id === "dataset_manifest") throw new SupervisorError("artifact", "dataset_manifest must not appear in the published artifact entries");
    if (!Number.isInteger(item.size_bytes) || item.size_bytes < 0) throw new SupervisorError("artifact", "artifact size receipt is invalid");
    return {
      artifact_id: item.artifact_id,
      relative_path: item.relative_path,
      role: typeof item.role === "string" ? item.role : null,
      size: item.size_bytes,
      sha256: item.sha256,
    };
  });
}

/** Download every published artifact plus the manifest and recompute all digests. */
export async function verifyArtifacts(api, taskId, evidenceDir, detail = null) {
  if (!isRecord(detail) || typeof detail.publication_id !== "string" || !SAFE_ID.test(detail.publication_id)) {
    throw new SupervisorError("artifact", "publication identity for downloads is invalid");
  }
  const manifestSha = isRecord(detail.publication) && typeof detail.publication.manifest_sha256 === "string"
    ? detail.publication.manifest_sha256
    : null;
  if (manifestSha === null || !SHA256.test(manifestSha)) throw new SupervisorError("artifact", "publication receipt has no valid manifest_sha256");
  const base = `/api/v1/publications/${encodeURIComponent(detail.publication_id)}`;
  const taskQuery = `?task_id=${encodeURIComponent(taskId)}`;
  const records = [];
  const packageEntries = [];
  for (const entry of artifactReceipts(detail)) {
    const downloaded = await api.download(`${base}/artifacts/${encodeURIComponent(entry.artifact_id)}${taskQuery}`);
    const fileDigest = verifyArtifactBytes(downloaded.bytes, entry, entry.artifact_id);
    const record = {
      artifact_id: entry.artifact_id,
      relative_path: entry.relative_path,
      role: entry.role,
      expected_size: entry.size,
      actual_size: fileDigest.size,
      expected_file_sha256: entry.sha256,
      actual_file_sha256: fileDigest.sha256,
      file_digest_match: true,
    };
    records.push(record);
    packageEntries.push({ relative_path: entry.relative_path, sha256: entry.sha256 });
    await appendJsonl(path.join(evidenceDir, "artifacts.jsonl"), record);
    await mkdir(path.join(evidenceDir, "artifacts"), { recursive: true });
    await writeFile(path.join(evidenceDir, "artifacts", entry.artifact_id), downloaded.bytes, { flag: "w" });
  }
  const manifestDownloaded = await api.download(`${base}/artifacts/dataset_manifest${taskQuery}`);
  const manifestFileDigest = digestManifestFile(manifestDownloaded.bytes);
  if (manifestFileDigest !== manifestSha) {
    throw new SupervisorError("artifact", "dataset_manifest digest mismatch", {
      expected_sha256: manifestSha,
      actual_sha256: manifestFileDigest,
    });
  }
  await mkdir(path.join(evidenceDir, "artifacts"), { recursive: true });
  await writeFile(path.join(evidenceDir, "artifacts", "dataset_manifest"), manifestDownloaded.bytes, { flag: "w" });
  await appendJsonl(path.join(evidenceDir, "artifacts.jsonl"), {
    artifact_id: "dataset_manifest",
    expected_file_sha256: manifestSha,
    actual_file_sha256: manifestFileDigest,
    actual_size: manifestDownloaded.bytes.byteLength,
    file_digest_match: true,
  });
  const packageDigest = digestPackage(packageEntries);
  return {
    artifacts: records,
    package_digest: packageDigest,
    manifest_file_digest: manifestFileDigest,
  };
}

async function postNewRun(api, taskId, requestId, prompt) {
  const accepted = await api.request("POST", `/api/v1/tasks/${encodeURIComponent(taskId)}/runs`, { request_id: requestId, input: prompt });
  if (!isRecord(accepted) || accepted.task_id !== taskId || accepted.request_id !== requestId || typeof accepted.run_id !== "string") throw new SupervisorError("protocol", "run acceptance response is invalid");
  return accepted;
}

async function resolvePermission(api, taskId, runId, request, decision) {
  if (decision.action !== "allow") return;
  if (typeof request.request_id !== "string") throw new SupervisorError("protocol", "permission request id is missing");
  await api.request("POST", `/api/v1/tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}/permissions/${encodeURIComponent(request.request_id)}`, { decision: "allow", grant_scope: decision.grant_scope });
}

async function latestHumanResolution(evidenceDir) {
  const records = await readJsonl(path.join(evidenceDir, "human-review.jsonl"));
  return records.at(-1) ?? null;
}

function validHumanDecision(value) {
  if (value === "approve" || value === "reject") return { action: value };
  if (!isRecord(value) || typeof value.action !== "string" || !new Set(["approve", "accept", "correct", "reject", "skip"]).has(value.action)) return null;
  if (value.action === "correct" && !("correction" in value)) return null;
  return value;
}

async function resumeHuman(api, taskId, runId, hil, evidenceDir) {
  const human = await latestHumanResolution(evidenceDir);
  if (!isRecord(human) || human.request_id !== hil.request_id || typeof human.evidence_digest !== "string" || !SHA256.test(human.evidence_digest) || (hil.evidence_digest !== null && human.evidence_digest !== hil.evidence_digest)) {
    throw new SupervisorError("data_review", "--resume requires an explicit matching human-review.jsonl record");
  }
  const decision = validHumanDecision(human.decision);
  if (decision === null) throw new SupervisorError("data_review", "human-review.jsonl decision is invalid");
  return api.request("POST", `/api/v1/tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}/resume`, {
    request_id: human.request_id,
    evidence_digest: human.evidence_digest,
    decision,
    reason: typeof human.reason === "string" ? human.reason : "Human review completed",
  });
}

async function journalRecords(evidenceDir) {
  return readJsonl(path.join(evidenceDir, "events.jsonl"));
}

function eventIdentity(event) {
  return typeof event.event_id === "string" && event.event_id !== "" ? event.event_id : `sequence:${event.sequence}`;
}

function journalHasEvent(records, event) {
  return records.some((candidate) => candidate?.sequence === event.sequence && eventIdentity(candidate) === eventIdentity(event));
}

function journalCursor(records) {
  let cursor = 0;
  for (const event of records) {
    if (!isRecord(event) || !Number.isSafeInteger(event.sequence) || event.sequence !== cursor + 1) break;
    cursor = event.sequence;
  }
  return cursor;
}

function permissionAlreadyHandled(records, requestId) {
  return records.some((event) => {
    const payload = eventPayload(event);
    return (eventType(event) === "permission_resolved" && payload?.request_id === requestId) ||
      (eventType(event) === "permission_requested" && payload?.request_id === requestId && payload?.decision === "allow");
  });
}

function pendingHilFromEvents(records, runId) {
  const pending = new Map();
  for (const event of records) {
    if (event?.run_id !== runId) continue;
    const hil = classifyHIL(event);
    if (hil?.request_id !== null && hil?.request_id !== undefined) pending.set(hil.request_id, hil);
    const payload = eventPayload(event);
    if (eventType(event) === "user_input_resumed" && typeof payload?.request_id === "string") pending.delete(payload.request_id);
  }
  return [...pending.values()].at(-1) ?? null;
}

function observedCommit(...values) {
  for (const value of values) {
    if (!isRecord(value)) continue;
    for (const key of ["product_commit", "commit", "product_revision"]) if (typeof value[key] === "string") return value[key];
  }
  return null;
}

function checkExpectedCommit(expected, ...values) {
  if (expected === null || expected === undefined) return null;
  const observed = observedCommit(...values);
  if (observed !== null && observed !== expected) throw new SupervisorError("health", "Host product commit does not match expected commit");
  return observed;
}

function parseOptions(argv) {
  const options = {
    baseUrl: "http://127.0.0.1:5173",
    taskId: null,
    requestId: null,
    promptFile: null,
    evidenceDir: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    caseLabel: "gold-formal",
    expectedCommit: null,
    pageSize: DEFAULT_PAGE_SIZE,
    workspaceRoot: null,
    resume: false,
  };
  const next = (index, label) => {
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) throw new SupervisorError("usage", `${label} requires a value`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--resume") options.resume = true;
    else if (arg === "--base-url") { options.baseUrl = next(index, arg); index += 1; }
    else if (arg === "--task-id") { options.taskId = next(index, arg); index += 1; }
    else if (arg === "--request-id") { options.requestId = next(index, arg); index += 1; }
    else if (arg === "--prompt-file") { options.promptFile = next(index, arg); index += 1; }
    else if (arg === "--evidence-dir") { options.evidenceDir = next(index, arg); index += 1; }
    else if (arg === "--timeout") { options.timeoutMs = Number(next(index, arg)); index += 1; }
    else if (arg === "--case-label") { options.caseLabel = next(index, arg); index += 1; }
    else if (arg === "--expected-commit") { options.expectedCommit = next(index, arg); index += 1; }
    else if (arg === "--page-size") { options.pageSize = Number(next(index, arg)); index += 1; }
    else if (arg === "--workspace-root") { options.workspaceRoot = next(index, arg); index += 1; }
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new SupervisorError("usage", `unknown argument: ${arg}`);
  }
  if (options.help) return options;
  for (const [name, value] of [["task-id", options.taskId], ["evidence-dir", options.evidenceDir], ["case-label", options.caseLabel]]) if (typeof value !== "string" || value.trim() === "") throw new SupervisorError("usage", `--${name} is required`);
  safeId(options.taskId, "task-id");
  if (!options.resume) {
    if (typeof options.requestId !== "string" || typeof options.promptFile !== "string") throw new SupervisorError("usage", "--request-id and --prompt-file are required for a fresh run");
    safeId(options.requestId, "request-id");
  } else if (options.requestId !== null) safeId(options.requestId, "request-id");
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) throw new SupervisorError("usage", "--timeout must be a positive integer");
  if (!Number.isSafeInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 1000) throw new SupervisorError("usage", "--page-size must be 1..1000");
  if (options.expectedCommit !== null && !/^[0-9a-f]{7,64}$/u.test(options.expectedCommit)) throw new SupervisorError("usage", "--expected-commit must be a lowercase git hash");
  return options;
}
export { parseOptions as parseArgs };

function errorForTerminal(terminal) {
  return new SupervisorError("terminal", `terminal outcome is ${terminal.classification}`);
}

export async function supervise(input, dependencies = {}) {
  const options = { ...input };
  options.baseUrl = normalizedBaseUrl(options.baseUrl);
  safeId(options.taskId, "taskId");
  if (typeof options.caseLabel !== "string" || options.caseLabel.trim() === "") throw new SupervisorError("usage", "caseLabel is required");
  if (!options.resume) {
    safeId(options.requestId, "requestId");
    if (typeof options.promptFile !== "string") throw new SupervisorError("usage", "promptFile is required");
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) throw new SupervisorError("usage", "timeout must be positive");
  options.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 1000) throw new SupervisorError("usage", "pageSize must be 1..1000");
  const prompt = options.resume ? null : await readCleanPrompt(options.promptFile);
  await mkdir(options.evidenceDir, { recursive: true });
  const state = await readState(options.evidenceDir);
  if (state.task_id !== null && state.task_id !== options.taskId) throw new SupervisorError("protocol", "evidence state belongs to another task");
  if (!options.resume && state.request_id !== null && state.request_id !== options.requestId) throw new SupervisorError("protocol", "evidence state belongs to another request");
  if (options.resume && options.requestId !== null && state.request_id !== null && options.requestId !== state.request_id) throw new SupervisorError("protocol", "--resume request id does not match evidence state");
  const api = dependencies.api ?? createApiClient(options.baseUrl, options.timeoutMs, dependencies.fetchImpl);
  const health = await api.request("GET", "/api/v1/health");
  if (!isRecord(health) || health.status !== "ok" || health.app_host !== "ts" || health.agent_runtime !== "pi" || health.dataset_core !== "ts") throw new SupervisorError("health", "Host health is not the fixed TS/Pi/TS runtime");
  const healthCommit = checkExpectedCommit(options.expectedCommit, health);
  let snapshot = await api.request("GET", `/api/v1/tasks/${encodeURIComponent(options.taskId)}`);
  requireTask(snapshot, options.taskId);
  let runId = state.run_id;
  const active = activeRunId(snapshot);
  if (active === undefined) throw new SupervisorError("protocol", "task active_run_id is missing");
  if (active !== null && (!options.resume || active !== runId)) throw new SupervisorError("active_run", "task already has an active run");
  if (!options.resume) {
    const accepted = await postNewRun(api, options.taskId, options.requestId, prompt);
    runId = accepted.run_id;
    state.request_id = accepted.request_id;
    state.run_id = runId;
    state.stopped = false;
    state.pending_hil = null;
    await writeState(options.evidenceDir, { ...state, task_id: options.taskId, case_label: options.caseLabel, expected_commit: options.expectedCommit ?? null, observed_commit: healthCommit });
  } else if (typeof runId !== "string") {
    throw new SupervisorError("protocol", "--resume requires supervisor state with run_id");
  }
  const workspaceRoot = options.workspaceRoot ?? dependencies.workspaceRoot ?? path.resolve("data", "workspaces", options.taskId);
  const deadline = Date.now() + options.timeoutMs;
  let records = await journalRecords(options.evidenceDir);
  const journalAfterSequence = journalCursor(records);
  if (journalAfterSequence > state.after_sequence) state.after_sequence = journalAfterSequence;
  if (journalAfterSequence < state.after_sequence) throw new SupervisorError("protocol", "event journal is behind the persisted cursor");
  let pendingHil = state.pending_hil ?? pendingHilFromEvents(records, runId);
  let humanResumeSubmitted = false;

  for (;;) {
    if (Date.now() > deadline) throw new SupervisorError("timeout", "supervisor timeout exceeded");
    const page = await api.request("GET", `/api/v1/tasks/${encodeURIComponent(options.taskId)}/events?after_sequence=${state.after_sequence}&limit=${options.pageSize}`);
    const validated = validateEventPage(page, state.after_sequence, options.taskId);
    for (const event of validated.events) {
      if (!journalHasEvent(records, event)) {
        await appendJsonl(path.join(options.evidenceDir, "events.jsonl"), event);
        records.push(redacted(event));
      }
      const isRunEvent = event.run_id === runId;
      const permission = permissionRequest(event);
      if (isRunEvent && permission !== null && typeof permission.request_id === "string" && !permissionAlreadyHandled(records, permission.request_id)) {
        const decision = classifyPermission(permission, { workspaceRoot });
        if (decision.action !== "allow") {
          await appendJsonl(path.join(options.evidenceDir, "permissions.jsonl"), { request_id: permission.request_id, decision });
          state.stopped = true;
          await writeState(options.evidenceDir, { ...state, task_id: options.taskId, case_label: options.caseLabel });
          throw new SupervisorError("permission", `unsafe permission request: ${decision.reason}`);
        }
        await resolvePermission(api, options.taskId, runId, permission, decision);
        await appendJsonl(path.join(options.evidenceDir, "permissions.jsonl"), { request_id: permission.request_id, decision });
      }
      if (isRunEvent) {
        const classifiedHil = classifyHIL(event);
        if (classifiedHil !== null) {
          pendingHil = classifiedHil;
          state.pending_hil = {
            request_id: classifiedHil.request_id,
            evidence_digest: classifiedHil.evidence_digest,
            kind: classifiedHil.kind,
            review_type: classifiedHil.review_type,
            request: redacted(classifiedHil.request),
          };
          state.stopped = true;
          state.after_sequence = event.sequence;
          await writeHilReport(options.evidenceDir, options.taskId, runId, classifiedHil, classifiedHil.reason);
          await writeState(options.evidenceDir, { ...state, task_id: options.taskId, case_label: options.caseLabel });
          if (!options.resume) throw new SupervisorError("data_review", "human review required");
        }
        const payload = eventPayload(event);
        if (eventType(event) === "user_input_resumed" && typeof payload?.request_id === "string" && pendingHil?.request_id === payload.request_id) {
          pendingHil = null;
          state.pending_hil = null;
          state.stopped = false;
          humanResumeSubmitted = false;
        }
        const type = eventType(event);
        if (type === "run_completed" || type === "run_failed" || type === "run_cancelled" || type === "run_interrupted") state.terminal_sequence = event.sequence;
      }
      state.after_sequence = event.sequence;
      await writeState(options.evidenceDir, { ...state, task_id: options.taskId, case_label: options.caseLabel, expected_commit: options.expectedCommit ?? null, observed_commit: healthCommit });
    }

    if (options.resume && pendingHil !== null && !humanResumeSubmitted) {
      const human = await latestHumanResolution(options.evidenceDir);
      if (isRecord(human)) {
        await resumeHuman(api, options.taskId, runId, pendingHil, options.evidenceDir);
        humanResumeSubmitted = true;
      } else if (state.pending_hil !== null) {
        state.stopped = true;
        await writeState(options.evidenceDir, { ...state, task_id: options.taskId, case_label: options.caseLabel });
        throw new SupervisorError("data_review", "human review has not been resolved; --resume will not auto-resolve HIL");
      }
    }

    await writeState(options.evidenceDir, { ...state, task_id: options.taskId, case_label: options.caseLabel, expected_commit: options.expectedCommit ?? null, observed_commit: healthCommit });
    snapshot = await api.request("GET", `/api/v1/tasks/${encodeURIComponent(options.taskId)}`);
    requireTask(snapshot, options.taskId);
    const run = runFrom(snapshot, runId);
    if (run === null) throw new SupervisorError("protocol", "supervised run is absent from task snapshot");
    if (!TERMINAL_RUN_SET.has(run.status)) {
      if (Date.now() >= deadline) throw new SupervisorError("timeout", "supervisor timeout exceeded");
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
      continue;
    }

    const currentPublicationId = currentPublicationIdFrom(snapshot);
    let publicationDetail = null;
    if (currentPublicationId !== null) {
      publicationDetail = await api.request(
        "GET",
        `/api/v1/publications/${encodeURIComponent(currentPublicationId)}?task_id=${encodeURIComponent(options.taskId)}`,
      );
      publicationSummaryOf(publicationDetail);
      if (publicationDetail.publication_id !== currentPublicationId) {
        throw new SupervisorError("protocol", "publication detail does not match the task's current publication");
      }
    }
    // A "current" publication produced by a later run is never claimable as
    // this supervised run's outcome.
    const boundPublication = publicationDetail !== null && publicationDetail.run_id === runId
      ? publicationSummaryOf(publicationDetail)
      : null;
    let terminal;
    if (publicationDetail !== null && boundPublication === null) {
      terminal = {
        classification: "blocked_publication_mismatch",
        expected_run_id: runId,
        actual_run_id: publicationDetail.run_id,
        publication_id: publicationDetail.publication_id,
        publication: null,
      };
    } else {
      terminal = classifyTerminal({ run, publication: boundPublication });
    }
    const observedFinalCommit = checkExpectedCommit(options.expectedCommit, snapshot, publicationDetail);
    if (terminal.classification !== "succeeded_publication") {
      await atomicWrite(path.join(options.evidenceDir, "closure.json"), `${JSON.stringify(redacted({ schema_version: "1.0", case_label: options.caseLabel, task_id: options.taskId, run_id: runId, expected_commit: options.expectedCommit ?? null, observed_commit: observedFinalCommit ?? healthCommit, health, terminal }), null, 2)}\n`);
      throw errorForTerminal(terminal);
    }
    const verified = await verifyArtifacts(api, options.taskId, options.evidenceDir, publicationDetail);
    if (
      !isRecord(publicationDetail.manifest)
      || typeof publicationDetail.manifest.sha256 !== "string"
      || !SHA256.test(publicationDetail.manifest.sha256)
    ) throw new SupervisorError("artifact", "publication manifest has no valid package sha256");
    if (verified.package_digest !== publicationDetail.manifest.sha256) throw new SupervisorError("artifact", "package digest mismatch");
    const closure = {
      schema_version: "1.0",
      case_label: options.caseLabel,
      expected_commit: options.expectedCommit ?? null,
      observed_commit: observedFinalCommit ?? healthCommit,
      task_id: options.taskId,
      run_id: runId,
      health: redacted(health),
      terminal: redacted(terminal),
      publication: redacted(boundPublication),
      publication_detail: redacted(publicationDetail),
      package_digest: verified.package_digest,
      manifest_file_digest: verified.manifest_file_digest,
      artifacts: verified.artifacts,
    };
    await atomicWrite(path.join(options.evidenceDir, "closure.json"), `${JSON.stringify(closure, null, 2)}\n`);
    state.stopped = false;
    state.pending_hil = null;
    await writeState(options.evidenceDir, { ...state, task_id: options.taskId, case_label: options.caseLabel, expected_commit: options.expectedCommit ?? null, observed_commit: observedFinalCommit ?? healthCommit });
    return closure;
  }
}

export const runSupervisor = supervise;

export function usage() {
  return [
    "Usage: node scripts/gold-formal-supervisor.mjs --task-id ID --request-id ID --prompt-file FILE --evidence-dir DIR --case-label LABEL [options]",
    "Options:",
    "  --base-url URL       formal TypeScript Host URL (default http://127.0.0.1:5173)",
    "  --timeout MS         wall-clock timeout; agent session has no turn limit",
    "  --expected-commit H  expected frozen product commit",
    "  --page-size N        event page size, 1..1000",
    "  --workspace-root DIR current task workspace (defaults to data/workspaces/<task-id>)",
    "  --resume             resume only after an explicit human resolution",
    "  --help",
  ].join("\n");
}

function errorExitCode(error) {
  switch (error?.code) {
    case "usage": return EXIT_CODES.USAGE;
    case "health": return EXIT_CODES.HEALTH;
    case "task": return EXIT_CODES.TASK;
    case "active_run": return EXIT_CODES.ACTIVE_RUN;
    case "permission": return EXIT_CODES.PERMISSION;
    case "data_review": return EXIT_CODES.DATA_REVIEW;
    case "terminal": return EXIT_CODES.TERMINAL;
    case "artifact": return EXIT_CODES.ARTIFACT;
    case "timeout": return EXIT_CODES.TIMEOUT;
    default: return EXIT_CODES.PROTOCOL;
  }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  try {
    const options = parseOptions(argv);
    if (options.help) { process.stdout.write(`${usage()}\n`); return EXIT_CODES.SUCCESS; }
    const result = await supervise(options, dependencies);
    process.stdout.write(`${JSON.stringify({ case_label: result.case_label, task_id: result.task_id, run_id: result.run_id, package_digest: result.package_digest, manifest_file_digest: result.manifest_file_digest })}\n`);
    return EXIT_CODES.SUCCESS;
  } catch (error) {
    const failure = error instanceof SupervisorError ? error : new SupervisorError("protocol", error instanceof Error ? error.message : String(error));
    // Deliberately no body/details: prompts, tokens, credentials, and server
    // payloads must never be printed by this evidence driver.
    process.stderr.write(`gold-formal-supervisor: ${failure.message}\n`);
    return errorExitCode(failure);
  }
}

if (process.argv[1]?.endsWith("gold-formal-supervisor.mjs")) process.exitCode = await main();
