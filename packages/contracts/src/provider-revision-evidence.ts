import type { SourceAssetRegistrationReceipt } from "./source-asset.js";

/**
 * Core-owned evidence needed to derive a stable dataset revision identity.
 *
 * A provider that does not expose a revision token must report null. The field
 * is required so callers cannot silently replace missing provider evidence with
 * a build ID, request parameter, registration time, or another local value.
 */
export interface ProviderRevisionEvidenceV1 {
  schema_version: "1.0";
  canonical_accession: string;
  provider_snapshot_identity: string;
  provider_revision_token: string | null;
  source_asset_registration_receipt: SourceAssetRegistrationReceipt;
}
