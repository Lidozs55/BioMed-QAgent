import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type {
  EvaluationCheckStatus,
  EvaluationDiagnosticFinding,
  EvaluationDiagnosticChecks,
} from "@biomed/contracts";

import {
  projectTrustedEvidenceChain,
  type TrustedEvidenceChainProjection,
} from "../trusted-evidence-chain.js";

const SAFE_CASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COMMIT = /^[0-9a-f]{40,64}$/;
const MAX_JSON_BYTES = 16 * 1024 * 1024;

type JsonObject = Record<string, unknown>;

type InventoryStatus = EvaluationCheckStatus;

export interface GoldEvidenceInventoryInput {
  evidence_root: string;
  case_id: string;
  target_product_commit: string;
  gold_root?: string;
}

export interface GoldEvidenceIdentity {
  status: InventoryStatus;
  manifest_id: string | null;
  manifest_version: number | null;
  product_commit: string | null;
  request_id: string | null;
  task_id: string | null;
  run_id: string | null;
  accepted_status: string | null;
  terminal_status: string | null;
  hash_checks: Readonly<Record<string, InventoryStatus>>;
}

export interface GoldEvidenceObservedFacts {
  task_status: string | null;
  run_status: string | null;
  build_status: string | null;
  build_id: string | null;
  build_publication_id: string | null;
  publication_ids: readonly string[];
  artifact_count: number | null;
  hil_count: number | null;
}

export interface GoldEvidenceInventory {
  schema_version: "1.0";
  case_id: string;
  target_product_commit: string;
  identity: GoldEvidenceIdentity;
  historical: {
    status: InventoryStatus;
    admissible_as_current_evidence: boolean | null;
  };
  checks: EvaluationDiagnosticChecks;
  observed: GoldEvidenceObservedFacts;
  trusted_evidence_chain?: TrustedEvidenceChainProjection | null;
  evidence_refs: readonly string[];
  findings: readonly EvaluationDiagnosticFinding[];
}

interface ReadJsonResult {
  value: JsonObject | null;
  exists: boolean;
  malformed: boolean;
}

interface ExpectedGoldHashes {
  manifest_id: string;
  manifest_version: number;
  manifest_sha256: string;
  case_spec_sha256: string;
  prompt_sha256: string;
  runtime_profile_sha256: string;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function statusOrUnknown(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function integerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function finding(
  code: string,
  boundary: EvaluationDiagnosticFinding["boundary"],
  requirementRef: string,
  message: string,
  evidenceRefs: readonly string[] = [],
  severity: EvaluationDiagnosticFinding["severity"] = "blocker",
): EvaluationDiagnosticFinding {
  return {
    code,
    boundary,
    requirement_ref: requirementRef,
    message,
    severity,
    evidence_refs: [...new Set(evidenceRefs)].sort(),
  };
}

function chainBoundary(stage: TrustedEvidenceChainProjection["gaps"][number]["stage"]): EvaluationDiagnosticFinding["boundary"] {
  switch (stage) {
    case "identity": return "evaluator";
    case "terminal": return "evaluator";
    case "trusted_input": return "trusted_input";
    case "semantic_product": return "validation";
    case "build": return "assembly";
    case "publication": return "publication";
    case "artifact": return "reproducibility";
    case "final_answer": return "reproducibility";
    case "hil": return "trusted_input";
    case "reproducibility": return "reproducibility";
  }
}

function chainFindings(chain: TrustedEvidenceChainProjection): EvaluationDiagnosticFinding[] {
  return chain.gaps.map((item) => finding(
    `chain.${item.code}`,
    chainBoundary(item.stage),
    item.code,
    item.message,
    item.source_refs,
  ));
}

function compareFindings(
  left: EvaluationDiagnosticFinding,
  right: EvaluationDiagnosticFinding,
): number {
  return left.boundary.localeCompare(right.boundary) ||
    left.code.localeCompare(right.code) ||
    left.requirement_ref.localeCompare(right.requirement_ref) ||
    left.evidence_refs.join("\u0000").localeCompare(right.evidence_refs.join("\u0000")) ||
    left.message.localeCompare(right.message);
}

async function confinedFile(root: string, relativePath: string): Promise<string> {
  if (isAbsolute(relativePath) || relativePath.split(/[\\/]/u).includes("..")) {
    throw new Error("path escapes evidence root");
  }
  const rootPath = await realpath(root);
  const candidate = resolve(rootPath, relativePath);
  const resolved = await realpath(candidate);
  const suffix = relative(rootPath, resolved);
  if (suffix === "" || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new Error("path escapes evidence root");
  }
  return resolved;
}

async function sha256File(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

async function readJsonFile(
  root: string,
  relativePath: string,
): Promise<ReadJsonResult> {
  let filePath: string;
  try {
    filePath = await confinedFile(root, relativePath);
  } catch (error) {
    const code = isObject(error) && typeof error.code === "string" ? error.code : null;
    return { value: null, exists: false, malformed: code !== "ENOENT" };
  }
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile() || fileStat.size > MAX_JSON_BYTES) {
      return { value: null, exists: true, malformed: true };
    }
    const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
    return { value: isObject(parsed) ? parsed : null, exists: true, malformed: !isObject(parsed) };
  } catch {
    return { value: null, exists: false, malformed: true };
  }
}

async function expectedHashes(
  root: string,
  caseId: string,
): Promise<ExpectedGoldHashes | null> {
  const manifestPath = await confinedFile(root, "manifest.json");
  const manifestResult = await readJsonFile(root, "manifest.json");
  if (manifestResult.value === null) return null;
  const manifest = manifestResult.value;
  const cases = Array.isArray(manifest.cases) ? manifest.cases : [];
  const entry = cases.find((item) => isObject(item) && item.case_id === caseId);
  if (!isObject(entry) || typeof entry.spec !== "string") return null;
  const caseSpecPath = await confinedFile(root, entry.spec);
  const caseSpecResult = await readJsonFile(root, entry.spec);
  if (caseSpecResult.value === null) return null;
  const caseSpec = caseSpecResult.value;
  if (typeof caseSpec.prompt_file !== "string" || typeof manifest.runtime_profile !== "string") return null;
  const promptPath = await confinedFile(root, caseSpec.prompt_file);
  const runtimeProfilePath = await confinedFile(root, manifest.runtime_profile);
  return {
    manifest_id: typeof manifest.manifest_id === "string" ? manifest.manifest_id : "",
    manifest_version: typeof manifest.manifest_version === "number" ? manifest.manifest_version : -1,
    manifest_sha256: await sha256File(manifestPath),
    case_spec_sha256: await sha256File(caseSpecPath),
    prompt_sha256: await sha256File(promptPath),
    runtime_profile_sha256: await sha256File(runtimeProfilePath),
  };
}

function identityValues(value: JsonObject | null): JsonObject {
  if (value === null) return {};
  const nested = value.identity;
  return isObject(nested) ? nested : value;
}

function compareIdentityField(
  actual: JsonObject,
  key: string,
  expected: string | number,
  ref: string,
  findings: EvaluationDiagnosticFinding[],
  hashChecks: Record<string, InventoryStatus>,
): void {
  const value = actual[key];
  const name = key.replaceAll("_sha256", "");
  if (value === expected) {
    hashChecks[name] = "pass";
  } else {
    hashChecks[name] = "fail";
    findings.push(finding(
      `identity.${name}_mismatch`,
      "evaluator",
      key,
      `Frozen identity field ${key} does not match the local Gold manifest`,
      [ref],
    ));
  }
}

function extractObserved(evidence: JsonObject | null): GoldEvidenceObservedFacts {
  const terminal = isObject(evidence?.terminal) ? evidence.terminal : {};
  const run = isObject(terminal.run) ? terminal.run : {};
  const task = isObject(terminal.task) ? terminal.task : {};
  const summary = isObject(run.summary) ? run.summary : {};
  const build = isObject(summary.build_result) ? summary.build_result : {};
  const publications = Array.isArray(terminal.publications)
    ? terminal.publications
    : Array.isArray(evidence?.publications) ? evidence.publications : [];
  const publicationIds = publications
    .filter(isObject)
    .map((publication) => stringOrNull(publication.publication_id))
    .filter((id): id is string => id !== null)
    .sort();
  const hilValues = [evidence?.hil, evidence?.hil_requests, evidence?.permission_requests]
    .filter(Array.isArray)
    .flatMap((value) => value as unknown[]);
  return {
    task_status: statusOrUnknown(task.status),
    run_status: statusOrUnknown(run.status),
    build_status: statusOrUnknown(build.status),
    build_id: stringOrNull(build.build_id),
    build_publication_id: stringOrNull(build.publication_id),
    publication_ids: [...new Set(publicationIds)],
    artifact_count: integerOrNull(task.artifact_count),
    hil_count: hilValues.length > 0 ? hilValues.length : null,
  };
}

function checksFor(
  identity: GoldEvidenceIdentity,
  observed: GoldEvidenceObservedFacts,
  findings: readonly EvaluationDiagnosticFinding[],
  chain: TrustedEvidenceChainProjection | null,
): EvaluationDiagnosticChecks {
  const hasFinding = (prefix: string): boolean => findings.some((item) => item.code.startsWith(prefix));
  const execution: InventoryStatus = chain?.terminal.task_status === "completed" && chain.terminal.run_status === "completed"
    ? "pass"
    : observed.task_status === "completed" && observed.run_status === "completed"
      ? "pass"
      : observed.task_status === null && observed.run_status === null ? "unknown" : "fail";
  const publication: InventoryStatus = chain?.publication.state === "present" && chain.publication.consistent_with_build
    ? "pass"
    : chain?.publication.state === "conflicting" ? "fail" : "unknown";
  const reproducibility: InventoryStatus = chain?.reproducibility.state === "present"
    ? "pass"
    : hasFinding("identity.product_commit_mismatch") || hasFinding("identity.product_commit_missing") || chain?.reproducibility.state === "conflicting"
      ? "fail"
      : "unknown";
  return {
    frozen_inputs: identity.status === "pass" ? "pass" : identity.status,
    execution: hasFinding("execution.") ? "fail" : execution,
    trusted_inputs: "unknown",
    semantic_product: "unknown",
    publication,
    reproducibility,
  };
}

export async function loadGoldEvidenceInventory(
  input: GoldEvidenceInventoryInput,
): Promise<GoldEvidenceInventory> {
  if (!SAFE_CASE_ID.test(input.case_id)) throw new TypeError("case_id must be a safe identifier");
  if (!COMMIT.test(input.target_product_commit)) throw new TypeError("target_product_commit must be a lowercase commit hash");
  const root = await realpath(input.evidence_root);
  const acceptRef = `accept-${input.case_id}.json`;
  const evidenceRef = `evidence-${input.case_id}.json`;
  const hilRef = `${input.case_id}.hil-needed.json`;
  const findings: EvaluationDiagnosticFinding[] = [];
  const accept = await readJsonFile(root, acceptRef);
  const evidence = await readJsonFile(root, evidenceRef);
  const hil = await readJsonFile(root, hilRef);
  if (!accept.exists || accept.value === null) {
    findings.push(finding(
      accept.malformed ? "evidence.accept_malformed" : "evidence.accept_missing",
      "discovery",
      "accept_receipt",
      accept.malformed ? "Case-specific accepted request receipt is malformed" : "Case-specific accepted request receipt is missing",
      [acceptRef],
    ));
  }
  if (!evidence.exists || evidence.value === null) {
    findings.push(finding(
      evidence.malformed ? "evidence.terminal_malformed" : "evidence.terminal_missing",
      "discovery",
      "evidence_bundle",
      evidence.malformed ? "Case-specific terminal evidence bundle is malformed" : "Case-specific terminal evidence bundle is missing",
      [evidenceRef],
    ));
  }

  const acceptIdentity = identityValues(accept.value);
  const evidenceIdentity = identityValues(evidence.value);
  const acceptProductCommit = stringOrNull(acceptIdentity.product_commit);
  const evidenceProductCommit = stringOrNull(evidenceIdentity.product_commit);
  const productCommit = acceptProductCommit ?? evidenceProductCommit;
  const requestId = stringOrNull(acceptIdentity.request_id) ?? stringOrNull(evidenceIdentity.request_id);
  const accepted = isObject(accept.value?.accepted) ? accept.value.accepted : {};
  const terminal = isObject(evidence.value?.terminal) ? evidence.value.terminal : {};
  const run = isObject(terminal.run) ? terminal.run : {};
  const task = isObject(terminal.task) ? terminal.task : {};
  const taskId = stringOrNull(evidence.value?.task_id) ?? stringOrNull(accepted.task_id) ?? stringOrNull(task.task_id);
  const runId = stringOrNull(evidence.value?.run_id) ?? stringOrNull(accepted.run_id) ?? stringOrNull(run.run_id);
  if (accept.value !== null && acceptIdentity.case_id !== input.case_id) findings.push(finding("identity.case_mismatch", "evaluator", "case_id", "Accepted receipt case does not match requested case", [acceptRef]));
  if (evidence.value !== null && evidenceIdentity.case_id !== input.case_id) findings.push(finding("identity.case_mismatch", "evaluator", "case_id", "Evidence bundle case does not match requested case", [evidenceRef]));
  const commitMismatchRefs = [
    acceptProductCommit !== null && acceptProductCommit !== input.target_product_commit ? acceptRef : null,
    evidenceProductCommit !== null && evidenceProductCommit !== input.target_product_commit ? evidenceRef : null,
  ].filter((ref): ref is string => ref !== null);
  if (commitMismatchRefs.length > 0) findings.push(finding("identity.product_commit_mismatch", "reproducibility", "product_commit", "Evidence product commit does not match target commit", commitMismatchRefs));
  if (acceptProductCommit !== null && evidenceProductCommit !== null && acceptProductCommit !== evidenceProductCommit) findings.push(finding("identity.product_commit_conflict", "evaluator", "product_commit", "Accepted receipt and terminal evidence identify different product commits", [acceptRef, evidenceRef]));
  if (productCommit === null) findings.push(finding("identity.product_commit_missing", "reproducibility", "product_commit", "Evidence does not identify a product commit", [acceptRef, evidenceRef]));
  if (accept.value !== null && accepted.request_id !== undefined && accepted.request_id !== requestId) findings.push(finding("identity.request_id_mismatch", "evaluator", "request_id", "Accepted request ID does not match identity", [acceptRef]));

  const hashChecks: Record<string, InventoryStatus> = {};
  let expected: ExpectedGoldHashes | null = null;
  if (input.gold_root !== undefined) {
    try {
      expected = await expectedHashes(await realpath(input.gold_root), input.case_id);
    } catch {
      findings.push(finding("identity.frozen_pack_unavailable", "evaluator", "frozen_inputs", "Frozen Gold manifest cannot be loaded safely", []));
    }
    if (expected === null) {
      findings.push(finding("identity.frozen_pack_incomplete", "evaluator", "frozen_inputs", "Frozen Gold manifest does not contain the requested case", []));
    }
  } else {
    findings.push(finding("identity.frozen_pack_not_supplied", "evaluator", "frozen_inputs", "Frozen Gold root was not supplied for identity verification", [], "warning"));
  }
  if (expected !== null) {
    compareIdentityField(acceptIdentity, "manifest_id", expected.manifest_id, acceptRef, findings, hashChecks);
    compareIdentityField(acceptIdentity, "manifest_version", expected.manifest_version, acceptRef, findings, hashChecks);
    compareIdentityField(acceptIdentity, "manifest_sha256", expected.manifest_sha256, acceptRef, findings, hashChecks);
    compareIdentityField(acceptIdentity, "case_spec_sha256", expected.case_spec_sha256, acceptRef, findings, hashChecks);
    compareIdentityField(acceptIdentity, "prompt_sha256", expected.prompt_sha256, acceptRef, findings, hashChecks);
    compareIdentityField(acceptIdentity, "runtime_profile_sha256", expected.runtime_profile_sha256, acceptRef, findings, hashChecks);
  }

  let historicalAdmissible: boolean | null = null;
  if (input.gold_root !== undefined) {
    try {
      const historicalRoot = await realpath(input.gold_root);
      const historical = await readJsonFile(historicalRoot, `historical/${input.case_id}.runs.json`);
      historicalAdmissible = historical.value?.admissible_as_current_evidence === true;
      if (historical.value !== null && historicalAdmissible !== true) {
        findings.push(finding("evidence.historical_inadmissible", "reproducibility", "same_commit_evidence", "Historical evidence is explicitly inadmissible as current evidence", [`historical/${input.case_id}.runs.json`]));
      }
    } catch {
      historicalAdmissible = null;
      findings.push(finding("evidence.historical_unknown", "evaluator", "historical_evidence", "Historical evidence declaration could not be loaded", []));
    }
  }
  const historicalStatus: InventoryStatus = historicalAdmissible === false ? "blocked" : historicalAdmissible === true ? "pass" : "unknown";
  const hilRequest = isObject(hil.value?.hil_request) ? hil.value.hil_request : null;
  const pendingBlockingHil = hilRequest?.status === "pending" && hilRequest.blocking === true;
  if (hil.malformed || (hil.exists && hilRequest === null)) {
    findings.push(finding(
      "evidence.hil_malformed",
      "evaluator",
      "hil_request",
      "HIL evidence sidecar is malformed",
      [hilRef],
    ));
  } else if (pendingBlockingHil) {
    findings.push(finding(
      "trusted_input.hil_pending",
      "trusted_input",
      "hil_resolution",
      "A blocking human-in-the-loop request is pending",
      [hilRef],
    ));
  }
  const extractedObserved = extractObserved(evidence.value);
  const observed: GoldEvidenceObservedFacts = {
    ...extractedObserved,
    hil_count: hilRequest === null ? extractedObserved.hil_count : Math.max(extractedObserved.hil_count ?? 0, 1),
  };
  const trustedEvidenceChain = accept.value !== null && evidence.value !== null
    ? projectTrustedEvidenceChain({
      accepted: accept.value,
      evidence: evidence.value,
      hil: hil.value ?? undefined,
      accepted_ref: acceptRef,
      evidence_ref: evidenceRef,
      hil_ref: hilRef,
      target_product_commit: input.target_product_commit,
    })
    : null;
  if (trustedEvidenceChain !== null) findings.push(...chainFindings(trustedEvidenceChain));
  if (observed.build_status === "succeeded" && observed.publication_ids.length === 0 && observed.build_publication_id === null) {
    findings.push(finding("publication.publication_receipt_missing", "publication", "publication_receipt", "Build success is present but no publication receipt was observed", [evidenceRef]));
  }
  if (observed.publication_ids.length > 0 || observed.build_publication_id !== null) {
    findings.push(finding("reproducibility.artifact_verification_missing", "reproducibility", "artifact_download_hash", "Publication identifiers are observed, but artifact download/hash evidence is absent", [evidenceRef]));
  }
  if (observed.task_status !== null && observed.run_status !== null && (observed.task_status !== "completed" || observed.run_status !== "completed")) {
    findings.push(finding("execution.terminal_not_completed", "evaluator", "task_run_terminal", "Task and run are not both completed", [evidenceRef]));
  }
  const identityStatus: InventoryStatus = productCommit === input.target_product_commit &&
    commitMismatchRefs.length === 0 &&
    !findings.some((item) => item.code.startsWith("identity.") && item.severity === "blocker") &&
    (expected === null || Object.values(hashChecks).every((status) => status === "pass"))
    ? "pass"
    : productCommit === null ? "unknown" : "fail";
  const identity: GoldEvidenceIdentity = {
    status: identityStatus,
    manifest_id: stringOrNull(acceptIdentity.manifest_id),
    manifest_version: typeof acceptIdentity.manifest_version === "number" ? acceptIdentity.manifest_version : null,
    product_commit: productCommit,
    request_id: requestId,
    task_id: taskId,
    run_id: runId,
    accepted_status: stringOrNull(accepted.status),
    terminal_status: statusOrUnknown(evidence.value?.terminal_status) ?? statusOrUnknown(terminal.status),
    hash_checks: hashChecks,
  };
  const frozenInputsStatus: InventoryStatus = input.gold_root === undefined
    ? "unknown"
    : expected === null
      ? "unknown"
      : Object.values(hashChecks).every((status) => status === "pass")
        ? "pass"
        : "fail";
  const baseChecks = checksFor(identity, observed, findings, trustedEvidenceChain);
  const checks = {
    ...baseChecks,
    frozen_inputs: frozenInputsStatus,
    trusted_inputs: pendingBlockingHil ? "blocked" as const : baseChecks.trusted_inputs,
  };
  return {
    schema_version: "1.0",
    case_id: input.case_id,
    target_product_commit: input.target_product_commit,
    identity,
    historical: { status: historicalStatus, admissible_as_current_evidence: historicalAdmissible },
    checks,
    observed,
    trusted_evidence_chain: trustedEvidenceChain,
    evidence_refs: [accept.exists ? acceptRef : null, evidence.exists ? evidenceRef : null, hil.exists ? hilRef : null, ...(trustedEvidenceChain?.evidence_refs ?? [])].filter((ref): ref is string => ref !== null),
    findings: findings.sort(compareFindings),
  };
}
