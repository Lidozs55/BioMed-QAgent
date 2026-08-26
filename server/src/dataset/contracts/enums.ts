/**
 * Deterministic Dataset Core enums (Python ``app.datasets.contracts``).
 *
 * Expressed as const objects + union types (no runtime TS enums) so the
 * module stays directly runnable under Node type stripping.
 */

export const VALIDATION_RESULT_STATUS = {
  PASSED: "passed",
  FAILED: "failed",
} as const;
export type ValidationResultStatus =
  (typeof VALIDATION_RESULT_STATUS)[keyof typeof VALIDATION_RESULT_STATUS];

export const ACQUISITION_MODE = {
  BUILTIN: "builtin",
  WORKFLOW_RECIPE: "workflow_recipe",
} as const;
export type AcquisitionMode =
  (typeof ACQUISITION_MODE)[keyof typeof ACQUISITION_MODE];

export const MAPPING_METHOD = {
  ADAPTER_DECLARED: "adapter_declared",
  SCHEMA_REGISTRY: "schema_registry",
  TRUSTED_METADATA: "trusted_metadata",
  EXPLICIT_RULE: "explicit_rule",
  HUMAN_APPROVED: "human_approved",
  STRING_SIMILARITY: "string_similarity",
} as const;
export type MappingMethod =
  (typeof MAPPING_METHOD)[keyof typeof MAPPING_METHOD];

export const MAPPING_REVIEW_STATUS = {
  PROPOSED: "proposed",
  ACCEPTED: "accepted",
  REJECTED: "rejected",
} as const;
export type MappingReviewStatus =
  (typeof MAPPING_REVIEW_STATUS)[keyof typeof MAPPING_REVIEW_STATUS];

export const VALUE_SCALE = {
  LINEAR: "linear",
  LOG2: "log2",
  LOG10: "log10",
  UNKNOWN: "unknown",
} as const;
export type ValueScale = (typeof VALUE_SCALE)[keyof typeof VALUE_SCALE];

export const BINDING_REJECTION_KIND = {
  NO_PRIMARY: "no_primary",
  ERROR: "error",
} as const;
export type BindingRejectionKind =
  (typeof BINDING_REJECTION_KIND)[keyof typeof BINDING_REJECTION_KIND];

export const CONFIDENCE_LEVEL = {
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
} as const;
export type ConfidenceLevel =
  (typeof CONFIDENCE_LEVEL)[keyof typeof CONFIDENCE_LEVEL];

const VALUE_SCALES = new Set<string>(Object.values(VALUE_SCALE));
const MAPPING_METHODS = new Set<string>(Object.values(MAPPING_METHOD));
const MAPPING_REVIEW_STATUSES = new Set<string>(
  Object.values(MAPPING_REVIEW_STATUS),
);
const CONFIDENCE_LEVELS = new Set<string>(Object.values(CONFIDENCE_LEVEL));
const VALIDATION_RESULT_STATUSES = new Set<string>(
  Object.values(VALIDATION_RESULT_STATUS),
);

export function assertValidationResultStatus(value: unknown, name: string): ValidationResultStatus {
  if (typeof value !== "string" || !VALIDATION_RESULT_STATUSES.has(value)) {
    throw new TypeError(`${name} must be one of ${[...VALIDATION_RESULT_STATUSES].join(", ")}`);
  }
  return value as ValidationResultStatus;
}

export function assertValueScale(value: unknown, name: string): ValueScale {
  if (typeof value !== "string" || !VALUE_SCALES.has(value)) {
    throw new TypeError(`${name} must be one of ${[...VALUE_SCALES].join(", ")}`);
  }
  return value as ValueScale;
}

export function assertMappingMethod(value: unknown, name: string): MappingMethod {
  if (typeof value !== "string" || !MAPPING_METHODS.has(value)) {
    throw new TypeError(`${name} must be one of ${[...MAPPING_METHODS].join(", ")}`);
  }
  return value as MappingMethod;
}

export function assertMappingReviewStatus(value: unknown, name: string): MappingReviewStatus {
  if (typeof value !== "string" || !MAPPING_REVIEW_STATUSES.has(value)) {
    throw new TypeError(
      `${name} must be one of ${[...MAPPING_REVIEW_STATUSES].join(", ")}`,
    );
  }
  return value as MappingReviewStatus;
}

export function assertConfidenceLevel(value: unknown, name: string): ConfidenceLevel {
  if (typeof value !== "string" || !CONFIDENCE_LEVELS.has(value)) {
    throw new TypeError(`${name} must be one of ${[...CONFIDENCE_LEVELS].join(", ")}`);
  }
  return value as ConfidenceLevel;
}

export const DATA_LEVEL = {
  RAW_SEQUENCE: "raw_sequence",
  SUBMITTER_PROCESSED: "submitter_processed",
  REPOSITORY_PROCESSED: "repository_processed",
  METADATA: "metadata",
} as const;
export type DataLevel = (typeof DATA_LEVEL)[keyof typeof DATA_LEVEL];

const DATA_LEVELS = new Set<string>(Object.values(DATA_LEVEL));

export function assertDataLevel(value: unknown, name: string): DataLevel {
  if (typeof value !== "string" || !DATA_LEVELS.has(value)) {
    throw new TypeError(`${name} must be one of ${[...DATA_LEVELS].join(", ")}`);
  }
  return value as DataLevel;
}

export const DATABASE = {
  PUBMED: "pubmed",
  GEO: "geo",
  GDC: "gdc",
  UCSC_XENA: "ucsc_xena",
  PDB: "pdb",
  REACTOME: "reactome",
  PUBCHEM: "pubchem",
  DBSNP: "dbsnp",
  CLINVAR: "clinvar",
  CLINICALTRIALS_GOV: "clinicaltrials_gov",
  MGNIFY: "mgnify",
  OPENFDA: "openfda",
  GWAS_CATALOG: "gwas_catalog",
  GMREPO: "gmrepo",
  BROWSER: "browser",
  UNIPROT: "uniprot",
  CHEMBL: "chembl",
} as const;
export type Database = (typeof DATABASE)[keyof typeof DATABASE];

export const SOURCE_CAPABILITY = {
  PIPELINE_SUPPORTED: "pipeline_supported",
  RESEARCH_ONLY: "research_only",
  PENDING: "pending",
} as const;
export type SourceCapability =
  (typeof SOURCE_CAPABILITY)[keyof typeof SOURCE_CAPABILITY];

export const DOWNLOAD_STATUS = {
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const;
export type DownloadStatus = (typeof DOWNLOAD_STATUS)[keyof typeof DOWNLOAD_STATUS];

export const ERROR_CODE = {
  CONFIGURATION_ERROR: "configuration_error",
  NETWORK_ERROR: "network_error",
  TIMEOUT: "timeout",
  DOWNLOAD_INCOMPLETE: "download_incomplete",
  CHECKSUM_MISMATCH: "checksum_mismatch",
  PARSE_ERROR: "parse_error",
  VALIDATION_ERROR: "validation_error",
  CANCELLED: "cancelled",
  INTERNAL_ERROR: "internal_error",
} as const;
export type ErrorCode = (typeof ERROR_CODE)[keyof typeof ERROR_CODE];

const DATABASES = new Set<string>(Object.values(DATABASE));
const SOURCE_CAPABILITIES_SET = new Set<string>(Object.values(SOURCE_CAPABILITY));
const DOWNLOAD_STATUSES = new Set<string>(Object.values(DOWNLOAD_STATUS));
const ERROR_CODES = new Set<string>(Object.values(ERROR_CODE));

export function assertDatabase(value: unknown, name: string): Database {
  if (typeof value !== "string" || !DATABASES.has(value)) {
    throw new TypeError(`${name} must be one of ${[...DATABASES].join(", ")}`);
  }
  return value as Database;
}

export function assertSourceCapability(value: unknown, name: string): SourceCapability {
  if (typeof value !== "string" || !SOURCE_CAPABILITIES_SET.has(value)) {
    throw new TypeError(
      `${name} must be one of ${[...SOURCE_CAPABILITIES_SET].join(", ")}`,
    );
  }
  return value as SourceCapability;
}

export function assertDownloadStatus(value: unknown, name: string): DownloadStatus {
  if (typeof value !== "string" || !DOWNLOAD_STATUSES.has(value)) {
    throw new TypeError(`${name} must be one of ${[...DOWNLOAD_STATUSES].join(", ")}`);
  }
  return value as DownloadStatus;
}

export function assertErrorCode(value: unknown, name: string): ErrorCode {
  if (typeof value !== "string" || !ERROR_CODES.has(value)) {
    throw new TypeError(`${name} must be one of ${[...ERROR_CODES].join(", ")}`);
  }
  return value as ErrorCode;
}

// Single source of truth for source capabilities (Python SOURCE_CAPABILITIES).
export const SOURCE_CAPABILITIES: Record<Database, SourceCapability> = {
  pubmed: "pipeline_supported",
  geo: "pipeline_supported",
  gdc: "pipeline_supported",
  ucsc_xena: "pipeline_supported",
  reactome: "pipeline_supported",
  dbsnp: "research_only",
  clinvar: "research_only",
  clinicaltrials_gov: "research_only",
  mgnify: "research_only",
  openfda: "research_only",
  gwas_catalog: "research_only",
  gmrepo: "research_only",
  pdb: "research_only",
  pubchem: "research_only",
  browser: "research_only",
  uniprot: "research_only",
  chembl: "research_only",
};

// Stable identifier aliases users may pass to pipeline/skill entry points
// (e.g. "xena" for ucsc_xena). Keys are user-facing identifiers.
export const DATABASE_IDENTIFIER_ALIASES: Record<string, Database> = {
  pubmed: "pubmed",
  geo: "geo",
  gdc: "gdc",
  xena: "ucsc_xena",
  ucsc_xena: "ucsc_xena",
  pdb: "pdb",
  reactome: "reactome",
  dbsnp: "dbsnp",
  clinvar: "clinvar",
  ncbi_clinvar: "clinvar",
  clinicaltrials_gov: "clinicaltrials_gov",
  mgnify: "mgnify",
  openfda: "openfda",
  openfda_faers: "openfda",
  gwas_catalog: "gwas_catalog",
  gmrepo: "gmrepo",
  pubchem: "pubchem",
  browser: "browser",
  uniprot: "uniprot",
  chembl: "chembl",
};

/** Resolve a user-facing database alias to its canonical Database value. */
export function resolveDatabaseIdentifier(identifier: string): Database | undefined {
  return DATABASE_IDENTIFIER_ALIASES[identifier];
}
