import type { ProviderRevisionEvidenceV1, SourceAssetRegistrationReceipt } from "@biomed/contracts";
import type { DatasetBuildSpec, SourceAsset } from "../contracts/index.js";
import { parseProviderRevisionEvidenceV1 } from "../contracts/index.js";
import { BuildError } from "../adapters/errors.js";
import {
  createAuthoritativeDatasetIdentityContext,
  type AuthoritativeDatasetIdentityContext,
  type ExpressionV2SchemaRef,
  type SourceAssetRegistrationFact,
} from "./authoritative.js";
import {
  expressionAdapterIdentityFromCore,
  type ExpressionAdapterIdentityContext,
} from "../adapters/identity-context.js";

type AssetRole = "source" | "mapping" | "metadata" | "carrier";

export interface ProductionIdentityDerivationInput {
  readonly spec: DatasetBuildSpec;
  readonly taskId: string;
  readonly sourceAssets: Readonly<Record<string, SourceAsset>>;
  readonly mappingAssets: Readonly<Record<string, SourceAsset>>;
  readonly metadataAssets: Readonly<Record<string, SourceAsset>>;
  readonly providerRevisionEvidence: readonly ProviderRevisionEvidenceV1[] | null | undefined;
  readonly registrationReceipts: readonly SourceAssetRegistrationReceipt[] | null | undefined;
}

export interface ProductionIdentityDerivation {
  readonly context: AuthoritativeDatasetIdentityContext;
  readonly byBinding: ReadonlyMap<string, ExpressionAdapterIdentityContext>;
}

function isExpressionV2Schema(schemaRef: string): schemaRef is ExpressionV2SchemaRef {
  return schemaRef === "gene_expression.long.v2" || schemaRef === "gene_expression.probe_long.v2";
}

function fail(message: string): never {
  throw new BuildError(`authoritative dataset identity rejected: ${message}`);
}

function receiptKey(receipt: SourceAssetRegistrationReceipt): string {
  return `${receipt.asset_ref.role}:${receipt.asset_ref.asset_id}`;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalized(value: string): string {
  return value.normalize("NFC").trim();
}

function bindingAssets(input: ProductionIdentityDerivationInput): Array<{
  readonly bindingId: string;
  readonly role: Exclude<AssetRole, "carrier">;
  readonly asset: SourceAsset;
}> {
  const assets: Array<{
    readonly bindingId: string;
    readonly role: Exclude<AssetRole, "carrier">;
    readonly asset: SourceAsset;
  }> = [];
  for (const [bindingId, asset] of Object.entries(input.sourceAssets)) {
    assets.push({ bindingId, role: "source", asset });
  }
  for (const [bindingId, asset] of Object.entries(input.mappingAssets)) {
    assets.push({ bindingId, role: "mapping", asset });
  }
  for (const [bindingId, asset] of Object.entries(input.metadataAssets)) {
    assets.push({ bindingId, role: "metadata", asset });
  }
  return assets;
}

function bindingForReceipt(
  receipt: SourceAssetRegistrationReceipt,
  assets: readonly ReturnType<typeof bindingAssets>[number][],
): ReturnType<typeof bindingAssets>[number] | undefined {
  return assets.find((entry) =>
    entry.asset.asset_id === receipt.asset_ref.asset_id
    && (entry.role === receipt.asset_ref.role || (receipt.asset_ref.role === "carrier" && entry.role === "source")),
  );
}

/**
 * Derive the only identity capability accepted by expression V2 adapters.
 * V1 deliberately returns null so its source-long bytes and fields remain
 * unchanged. All V2 inputs must be closed by the exact task-owned receipts
 * that were resolved for this build.
 */
export function deriveProductionExpressionIdentity(
  input: ProductionIdentityDerivationInput,
): ProductionIdentityDerivation | null {
  if (!isExpressionV2Schema(input.spec.schema_ref)) return null;

  const evidenceValues = input.providerRevisionEvidence;
  const ownedValues = input.registrationReceipts;
  if (evidenceValues === undefined || evidenceValues === null || evidenceValues.length === 0) {
    fail("provider revision evidence is required");
  }
  if (ownedValues === undefined || ownedValues === null || ownedValues.length === 0) {
    fail("task-owned registration receipts are required");
  }

  const owned = new Map<string, SourceAssetRegistrationReceipt>();
  for (const receipt of ownedValues) {
    if (receipt.task_id !== input.taskId || receipt.asset_ref.task_id !== input.taskId) {
      fail("registration receipt belongs to a different task");
    }
    const key = receiptKey(receipt);
    if (owned.has(key)) fail(`registration receipt closure duplicates '${key}'`);
    owned.set(key, receipt);
  }

  const evidence: ProviderRevisionEvidenceV1[] = [];
  const evidenceKeys = new Set<string>();
  for (const value of evidenceValues) {
    let parsed: ProviderRevisionEvidenceV1;
    try {
      parsed = parseProviderRevisionEvidenceV1(value);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    const receipt = parsed.source_asset_registration_receipt;
    if (receipt.task_id !== input.taskId || receipt.asset_ref.task_id !== input.taskId) {
      fail("provider revision evidence belongs to a different task");
    }
    const key = receiptKey(receipt);
    if (evidenceKeys.has(key)) fail(`provider revision evidence duplicates '${key}'`);
    evidenceKeys.add(key);
    const ownedReceipt = owned.get(key);
    if (ownedReceipt === undefined || !sameJson(ownedReceipt, receipt)) {
      fail(`provider revision evidence receipt '${key}' is not covered by this build's registered receipts`);
    }
    evidence.push(parsed);
  }
  const assets = bindingAssets(input);
  const identityEvidenceKeys = new Set(
    evidence
      .filter((value) => value.source_asset_registration_receipt.asset_ref.role === "source" ||
        value.source_asset_registration_receipt.asset_ref.role === "carrier")
      .map((value) => receiptKey(value.source_asset_registration_receipt)),
  );
  const requiredIdentityReceiptKeys = new Set(
    [...owned.entries()]
      .filter(([, receipt]) => receipt.asset_ref.role === "source" || receipt.asset_ref.role === "carrier")
      .map(([key]) => key),
  );
  if (
    identityEvidenceKeys.size !== requiredIdentityReceiptKeys.size
    || [...requiredIdentityReceiptKeys].some((key) => !identityEvidenceKeys.has(key))
  ) {
    fail("registered carrier receipt closure is not fully covered by provider revision evidence");
  }
  const evidenceSnapshots = new Set(evidence.map((value) => value.provider_snapshot_identity));
  const evidenceTokens = new Set(evidence.map((value) => value.provider_revision_token));
  if (evidenceSnapshots.size !== 1 || evidenceTokens.size !== 1) {
    fail("carrier receipts do not share one provider revision snapshot");
  }
  for (const entry of assets) {
    const role: AssetRole = entry.role;
    const key = `${role}:${entry.asset.asset_id}`;
    const receipt = owned.get(key) ?? (role === "source" ? owned.get(`carrier:${entry.asset.asset_id}`) : undefined);
    if (receipt === undefined) {
      fail(`asset '${entry.bindingId}' is not covered by its registered receipt`);
    }
    if (
      receipt.sha256 !== entry.asset.sha256
      || receipt.size_bytes !== entry.asset.size_bytes
      || receipt.relative_path !== entry.asset.relative_path
      || receipt.source_id !== entry.asset.source_id
    ) {
      fail(`registered receipt for '${entry.bindingId}' does not match the Core asset record`);
    }
  }

  const sourceBindings = input.spec.source_bindings;
  if (sourceBindings.length === 0) fail("at least one source binding is required");
  const sourceNamespace = normalized(sourceBindings[0]!.source);
  if (sourceNamespace.length === 0) fail("source namespace is blank");
  if (sourceBindings.some((binding) => normalized(binding.source) !== sourceNamespace)) {
    fail("all expression V2 source bindings must share one source namespace");
  }
  const accessionSet = new Set<string>();
  const facts: SourceAssetRegistrationFact[] = [];
  for (const parsed of evidence.filter((value) =>
    value.source_asset_registration_receipt.asset_ref.role === "source" ||
    value.source_asset_registration_receipt.asset_ref.role === "carrier")) {
    const receipt = parsed.source_asset_registration_receipt;
    const binding = bindingForReceipt(receipt, assets);
    const accession = normalized(parsed.canonical_accession);
    if (accession.length === 0) fail("canonical accession is blank");
    accessionSet.add(accession);
    if (binding !== undefined && binding.role === "source") {
      const declared = input.spec.source_bindings.find((candidate) => candidate.binding_id === binding.bindingId)?.accession;
      if (declared !== undefined && declared !== null && normalized(declared) !== accession) {
        fail(`caller accession for '${binding.bindingId}' disagrees with provider evidence`);
      }
    }
    facts.push(Object.freeze({
      bindingId: binding?.bindingId ?? receipt.source_id,
      source: binding === undefined
        ? receipt.source_id
        : input.spec.source_bindings.find((candidate) => candidate.binding_id === binding.bindingId)?.source ?? receipt.source_id,
      role: receipt.asset_ref.role,
      assetId: receipt.asset_ref.asset_id,
      sha256: receipt.sha256,
      sizeBytes: receipt.size_bytes,
      taskId: receipt.task_id,
      buildId: input.spec.build_id,
      generation: 0,
      providerSnapshot: parsed.provider_snapshot_identity,
      revisionToken: parsed.provider_revision_token,
      accession,
    }));
  }

  let context: AuthoritativeDatasetIdentityContext;
  try {
    context = createAuthoritativeDatasetIdentityContext(Object.freeze({
      sourceNamespace,
      canonicalAccessions: Object.freeze([...accessionSet].sort()),
      taskId: input.taskId,
      buildId: input.spec.build_id,
      generation: 0,
      schemaRef: input.spec.schema_ref,
      facts: Object.freeze(facts),
    }));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const byBinding = new Map<string, ExpressionAdapterIdentityContext>();
  for (const binding of sourceBindings) {
    const asset = input.sourceAssets[binding.binding_id];
    if (asset === undefined) fail(`source asset is missing for '${binding.binding_id}'`);
    byBinding.set(
      binding.binding_id,
      expressionAdapterIdentityFromCore(context, asset.asset_id),
    );
  }
  return Object.freeze({ context, byBinding });
}
