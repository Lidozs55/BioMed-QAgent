import {
  assertArray,
  assertFinite,
  assertNumber,
  assertHex64,
  assertObject,
  assertString,
  assertStringOrNull,
  optSchemaVersion,
} from "./runtime/primitives.js";

export const BROWSER_ACQUISITION_EVIDENCE_SCHEMA_VERSION = "1.0" as const;
export const BROWSER_ACQUISITION_PROVIDER_ID = "browser.snapshot.v1" as const;
export const LEGACY_BROWSER_ACQUISITION_POLICY_REVISION = "public-http-browser.v1" as const;
export const BROWSER_ACQUISITION_POLICY_REVISION = "public-http-browser.v2" as const;
export type BrowserAcquisitionPolicyRevision =
  | typeof LEGACY_BROWSER_ACQUISITION_POLICY_REVISION
  | typeof BROWSER_ACQUISITION_POLICY_REVISION;
export const BROWSER_ACQUISITION_PROVIDER_IMPLEMENTATION_DIGEST = "f666e9539a47e4a1f61bb323295566122559c2807fd95ebd8109e1b4f01afb03" as const;

export interface BrowserRedirectHop {
  from_url: string;
  to_url: string;
  status: number;
}

export interface BrowserAcquisitionEvidence {
  schema_version: typeof BROWSER_ACQUISITION_EVIDENCE_SCHEMA_VERSION;
  evidence_id: string;
  task_id: string;
  run_id: string | null;
  requested_url: string;
  final_url: string;
  redirect_chain: BrowserRedirectHop[];
  status: number;
  media_type: string;
  retrieved_at: string;
  bytes_received: number;
  sha256: string;
  browser_policy_revision: BrowserAcquisitionPolicyRevision;
  source_asset_id: string;
  source_id: string;
  relative_path: string;
  download_attempt_id: string;
  provider_id: typeof BROWSER_ACQUISITION_PROVIDER_ID;
  provider_implementation_digest: string;
}

export interface BrowserAcquisitionProposal {
  schema_version: "1.0";
  proposal_id: string;
  evidence_digest: string;
  task_id: string;
  run_id: string;
  requirement_id: string | null;
  generation: number;
  recipe_id: string;
  recipe_version: string;
  binding_id: string;
  family_id: string;
  schema_ref: string;
  table_id: string;
  input_role: string;
  intended_role: "source" | "mapping" | "metadata" | "carrier";
  status: "draft" | "hil_pending" | "accepted" | "rejected" | "formalizing" | "formalized" | "failed";
  created_at: string;
  updated_at: string;
  failure_reason: string | null;
}

export function parseBrowserAcquisitionEvidence(
  value: unknown,
  path = "browser_acquisition_evidence",
): BrowserAcquisitionEvidence {
  const obj = assertObject(value, path);
  const redirects = assertArray(obj.redirect_chain, `${path}.redirect_chain`, (item, index) => {
    const hop = assertObject(item, `${path}.redirect_chain[${index}]`);
    return {
      from_url: assertString(hop.from_url, `${path}.redirect_chain[${index}].from_url`, true),
      to_url: assertString(hop.to_url, `${path}.redirect_chain[${index}].to_url`, true),
      status: assertNumber(hop.status, `${path}.redirect_chain[${index}].status`),
    };
  });
  return {
    schema_version: assertFinite(obj.schema_version, `${path}.schema_version`, ["1.0"] as const),
    evidence_id: assertString(obj.evidence_id, `${path}.evidence_id`, true),
    task_id: assertString(obj.task_id, `${path}.task_id`, true),
    run_id: assertStringOrNull(obj.run_id, `${path}.run_id`),
    requested_url: assertString(obj.requested_url, `${path}.requested_url`, true),
    final_url: assertString(obj.final_url, `${path}.final_url`, true),
    redirect_chain: redirects,
    status: assertNumber(obj.status, `${path}.status`),
    media_type: assertString(obj.media_type, `${path}.media_type`, true),
    retrieved_at: assertString(obj.retrieved_at, `${path}.retrieved_at`, true),
    bytes_received: assertNumber(obj.bytes_received, `${path}.bytes_received`),
    sha256: assertHex64(obj.sha256, `${path}.sha256`),
    browser_policy_revision: assertFinite(
      obj.browser_policy_revision,
      `${path}.browser_policy_revision`,
      [LEGACY_BROWSER_ACQUISITION_POLICY_REVISION, BROWSER_ACQUISITION_POLICY_REVISION] as const,
    ),
    source_asset_id: assertString(obj.source_asset_id, `${path}.source_asset_id`, true),
    source_id: assertString(obj.source_id, `${path}.source_id`, true),
    relative_path: assertString(obj.relative_path, `${path}.relative_path`, true),
    download_attempt_id: assertString(obj.download_attempt_id, `${path}.download_attempt_id`, true),
    provider_id: assertFinite(obj.provider_id, `${path}.provider_id`, [BROWSER_ACQUISITION_PROVIDER_ID] as const),
    provider_implementation_digest: assertHex64(
      obj.provider_implementation_digest,
      `${path}.provider_implementation_digest`,
    ),
  };
}

export function parseBrowserAcquisitionProposal(
  value: unknown,
  path = "browser_acquisition_proposal",
): BrowserAcquisitionProposal {
  const obj = assertObject(value, path);
  return {
    schema_version: optSchemaVersion(obj.schema_version, `${path}.schema_version`) ?? "1.0",
    proposal_id: assertString(obj.proposal_id, `${path}.proposal_id`, true),
    evidence_digest: assertHex64(obj.evidence_digest, `${path}.evidence_digest`),
    task_id: assertString(obj.task_id, `${path}.task_id`, true),
    run_id: assertString(obj.run_id, `${path}.run_id`, true),
    requirement_id: assertStringOrNull(obj.requirement_id, `${path}.requirement_id`),
    generation: assertNumber(obj.generation, `${path}.generation`),
    recipe_id: assertString(obj.recipe_id, `${path}.recipe_id`, true),
    recipe_version: assertString(obj.recipe_version, `${path}.recipe_version`, true),
    binding_id: assertString(obj.binding_id, `${path}.binding_id`, true),
    family_id: assertString(obj.family_id, `${path}.family_id`, true),
    schema_ref: assertString(obj.schema_ref, `${path}.schema_ref`, true),
    table_id: assertString(obj.table_id, `${path}.table_id`, true),
    input_role: assertString(obj.input_role, `${path}.input_role`, true),
    intended_role: assertFinite(obj.intended_role, `${path}.intended_role`, ["source", "mapping", "metadata", "carrier"] as const),
    status: assertFinite(obj.status, `${path}.status`, ["draft", "hil_pending", "accepted", "rejected", "formalizing", "formalized", "failed"] as const),
    created_at: assertString(obj.created_at, `${path}.created_at`, true),
    updated_at: assertString(obj.updated_at, `${path}.updated_at`, true),
    failure_reason: assertStringOrNull(obj.failure_reason, `${path}.failure_reason`),
  };
}
