import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OperationResultManifest } from "@biomed/contracts";
import type { DynamicFamilyTableOutputs } from "../dynamic-family/index.js";

export interface BrowserFamilyEvidenceInput {
  readonly taskId: string;
  readonly runId?: string;
  readonly requirementId: string;
  readonly evidenceRoot: string;
  readonly implementationDigest: string;
  readonly integratedTables: Readonly<Record<string, OperationResultManifest>>;
  readonly sourceEvidenceByTable: Readonly<Record<string, readonly OperationResultManifest[]>>;
}

export async function createBrowserFamilyTableOutputs(
  input: BrowserFamilyEvidenceInput,
): Promise<Readonly<Record<string, DynamicFamilyTableOutputs>>> {
  const entries = await Promise.all(Object.entries(input.integratedTables).map(async ([tableId, data]) => {
    if (data.operation_kind !== "integrate" || data.output_kind !== "integrated_table") {
      throw new Error(`browser family evidence requires integrated table: ${tableId}`);
    }
    const sourceEvidence = input.sourceEvidenceByTable[tableId];
    if (sourceEvidence === undefined || sourceEvidence.length === 0) {
      throw new Error(`browser family evidence is missing source evidence: ${tableId}`);
    }
    const provenance = await writeEvidence(input, tableId, "provenance", data, sourceEvidence);
    const confidence = await writeEvidence(input, tableId, "confidence", data, sourceEvidence);
    return [tableId, { data, provenance: [provenance], confidence: [confidence], audit: [] }] as const;
  }));
  return Object.fromEntries(entries);
}

async function writeEvidence(
  input: BrowserFamilyEvidenceInput,
  tableId: string,
  kind: "provenance" | "confidence",
  data: OperationResultManifest,
  sourceEvidence: readonly OperationResultManifest[],
): Promise<OperationResultManifest> {
  const sourceOutputDigest = data.output_digest;
  if (sourceOutputDigest === null || sourceOutputDigest === undefined) throw new Error(`browser family evidence data has no output digest: ${tableId}`);
  const relativePath = `${kind}/${tableId}.json`;
  const absolutePath = path.join(input.evidenceRoot, ...relativePath.split("/"));
  await mkdir(path.dirname(absolutePath), { recursive: true });
  const body = `${JSON.stringify({
    schema_version: "1.0",
    evidence_kind: kind,
    table_id: tableId,
    source_operation_result_manifest_id: data.result_manifest_id,
    source_evidence_manifest_ids: sourceEvidence.map((item) => item.result_manifest_id),
    confidence: kind === "confidence" ? "source_preserved" : undefined,
  })}\n`;
  await writeFile(absolutePath, body, "utf8");
  const bytes = Buffer.from(body, "utf8");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const size = (await stat(absolutePath)).size;
  const identity = createHash("sha256").update(`${kind}\0${tableId}\0${data.result_manifest_id}`, "utf8").digest("hex").slice(0, 24);
  const parameterDigest = createHash("sha256").update(JSON.stringify({ table_id: tableId, evidence_kind: kind }), "utf8").digest("hex");
  return {
    schema_version: "1.0",
    result_manifest_id: `result_${identity}`,
    task_id: input.taskId,
    run_id: input.runId ?? "run_test",
    requirement_id: input.requirementId,
    operation_id: `derive_browser_${identity}`,
    operation_kind: "derive",
    operation_attempt_id: `attempt_${identity}`,
    attempt: 1,
    status: "succeeded",
    input_digest: sourceOutputDigest,
    parameter_digest: parameterDigest,
    implementation_digest: input.implementationDigest,
    output_digest: digest,
    output_kind: "derived_evidence",
    output_summary: { table_id: tableId, evidence_kind: kind, source_evidence_manifest_ids: sourceEvidence.map((item) => item.result_manifest_id) },
    output_files: [{ relative_path: relativePath, size_bytes: size, sha256: digest }],
    dependency_closure: {
      input_asset_ids: sourceEvidence.flatMap((item) => item.dependency_closure.input_asset_ids),
      upstream_result_manifest_ids: [data.result_manifest_id, ...sourceEvidence.map((item) => item.result_manifest_id)],
      parameter_digest: parameterDigest,
      implementation_digest: input.implementationDigest,
    },
    commit: { state: "committed", commit_id: `commit_${identity}`, committed_at: new Date().toISOString() },
  };
}
