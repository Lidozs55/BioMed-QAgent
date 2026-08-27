/**
 * GMRepo (Gut Microbiota Data Repository) fixed Core acquisition provider.
 *
 * GMRepo is a curated database of consistently annotated human gut
 * metagenomes (https://gmrepo.humangut.info). Its official REST API is
 * POST-only: every endpoint expects a JSON body, so a plain GET
 * formalization path can never produce data from it. This provider pins the
 * exact endpoint host and carries the POST body inside the trusted provider
 * plan — request parameters never reach the transport directly.
 *
 * The provider plans one NCBI taxon ID per binding and acquires that taxon's
 * phenotype prevalence/abundance summary (case-vs-control cohorts across
 * MeSH phenotypes). The legacy per-disease endpoints
 * ``getAssociatedSpeciesByMeshID`` / ``getAssociatedGeneraByMeshID`` /
 * ``getDetailedTaxonPrevalenceAndAbundanceAcrossPhenotypes`` have been dead
 * upstream since at least 2026-08 (HTTP 500) and are intentionally not
 * called. Responses enter the trusted Dataset Core acquisition path
 * unchanged: the downloader owns policy (HTTPS, host allowlist, hashing,
 * size limits, media type checks, content cache, immutable source_assets
 * publication) and CoreAcquisitionRuntime registers bytes/hash/provenance.
 */

import { createHash } from "node:crypto";

import type { CoreAcquisitionRequest } from "@biomed/contracts";

import type {
  AcquisitionDownloadPlan,
  AcquisitionProviderHandler,
} from "./runtime.js";

export const GMREPO_FILES_PROVIDER_ID = "gmrepo.files.v1";
/**
 * SHA-256 of this provider's plan implementation with the digest constant
 * line removed, so the value is stable and auditable: recompute with
 * ``sed '/^  "[0-9a-f]\{64\}" *;$/d' gmrepo-provider.ts | sha256sum``.
 */
export const GMREPO_FILES_IMPLEMENTATION_DIGEST =
  "fc83df82838c1f55948684a46fe06c15f1dcb9036357d042315b2cf941bdc14f";

const GMREPO_HOST = "gmrepo.humangut.info";
// Trailing slash is mandatory: the Django endpoint runs with APPEND_SLASH,
// which rejects slash-less POSTs with HTTP 500 (verified against the live API).
const GMREPO_TAXON_PHENOTYPES_ENDPOINT =
  `https://${GMREPO_HOST}/api/getPhenotypesAndAbundanceSummaryOfAAssociatedTaxon/`;
const MAX_GMREPO_RESPONSE_BYTES = 64 * 1024 * 1024;
const TAXON_ID = /^[1-9][0-9]{0,11}$/;
const PARAMETER_KEYS = new Set(["source", "accession", "entities"]);

type GmrepoParameters = {
  taxonId: number;
};

function parameters(request: CoreAcquisitionRequest): GmrepoParameters {
  if (request.mode !== "builtin" || request.provider_id !== GMREPO_FILES_PROVIDER_ID) {
    throw new TypeError("gmrepo.files.v1 only accepts its fixed builtin acquisition contract");
  }
  if (Object.keys(request.parameters).some((key) => !PARAMETER_KEYS.has(key))) {
    throw new TypeError("gmrepo.files.v1 accepts only source, accession, and entities");
  }
  if (request.parameters.source !== "gmrepo") {
    throw new TypeError("gmrepo.files.v1 requires binding source 'gmrepo'");
  }
  if (typeof request.parameters.accession !== "string") {
    throw new TypeError("gmrepo.files.v1 requires an NCBI taxon ID");
  }
  const accession = request.parameters.accession.trim();
  if (!TAXON_ID.test(accession)) {
    throw new TypeError("gmrepo.files.v1 requires a valid numeric NCBI taxon ID like 9606");
  }
  return { taxonId: Number(accession) };
}

function sourceId(taxonId: number): string {
  const digest = createHash("sha256")
    .update(`${GMREPO_FILES_PROVIDER_ID}\u0000${taxonId}`)
    .digest("hex")
    .slice(0, 20);
  return `source_gmrepo_${digest}`;
}

export function createGmrepoFilesProvider(): AcquisitionProviderHandler {
  return Object.freeze({
    providerId: GMREPO_FILES_PROVIDER_ID,
    implementationDigest: GMREPO_FILES_IMPLEMENTATION_DIGEST,
    async plan(request: CoreAcquisitionRequest): Promise<AcquisitionDownloadPlan> {
      const { taxonId } = parameters(request);
      return {
        source: {
          schema_version: "1.0",
          source_id: sourceId(taxonId),
          database: "gmrepo",
          accession: String(taxonId),
          url: GMREPO_TAXON_PHENOTYPES_ENDPOINT,
          title: `GMRepo phenotype prevalence summary for NCBI taxon ${taxonId}`,
          retrieved_at: new Date().toISOString(),
        },
        filename: `gmrepo_taxon_phenotypes_${taxonId}.json`,
        dataLevel: "repository_processed",
        maxBytes: MAX_GMREPO_RESPONSE_BYTES,
        method: "POST",
        body: JSON.stringify({ ncbi_taxon_id: taxonId }),
        expectedMediaTypes: new Set(["application/json"]),
        accept: "application/json",
        allowedHosts: new Set([GMREPO_HOST]),
        assetRole: "carrier",
        providerRevisionFacts: {
          canonical_accession: String(taxonId),
          provider_snapshot_identity: `${GMREPO_FILES_PROVIDER_ID}:official-api`,
          provider_revision_token: null,
        },
      };
    },
  });
}
