"""Stable wire enums used by deterministic pipeline contracts."""

from __future__ import annotations

from enum import StrEnum


class Database(StrEnum):
    PUBMED = "pubmed"
    GEO = "geo"
    GDC = "gdc"
    UCSC_XENA = "ucsc_xena"
    PDB = "pdb"
    REACTOME = "reactome"
    PUBCHEM = "pubchem"
    BROWSER = "browser"


class SourceCapability(StrEnum):
    """Pipeline input-level capability of a data source (TODO §1.4).

    Distinguishes sources the deterministic Pipeline has accepted
    (search/metadata/download/parse/validate closed loop) from sources that
    are Agent-only research channels or pending integration. A source marked
    ``research_only`` may be used for investigation but must never be routed
    into the Pipeline as if it were a verified data source.
    """

    PIPELINE_SUPPORTED = "pipeline_supported"
    RESEARCH_ONLY = "research_only"
    PENDING = "pending"


# Single source of truth for source capabilities (TODO §1.4). The Pipeline
# tool resolves user-selected databases against this table; skill catalog
# ``pipeline_supported`` derives from it as well so the two declarations
# cannot drift apart.
SOURCE_CAPABILITIES: dict[Database, SourceCapability] = {
    Database.PUBMED: SourceCapability.PIPELINE_SUPPORTED,
    Database.GEO: SourceCapability.PIPELINE_SUPPORTED,
    Database.GDC: SourceCapability.PIPELINE_SUPPORTED,
    Database.UCSC_XENA: SourceCapability.PIPELINE_SUPPORTED,
    Database.REACTOME: SourceCapability.PIPELINE_SUPPORTED,
    Database.PDB: SourceCapability.RESEARCH_ONLY,
    Database.PUBCHEM: SourceCapability.RESEARCH_ONLY,
    Database.BROWSER: SourceCapability.RESEARCH_ONLY,
}

# Stable identifier aliases users may pass to run_research_pipeline
# (e.g. "xena" for ucsc_xena). Keys are user-facing identifiers.
DATABASE_IDENTIFIER_ALIASES: dict[str, Database] = {
    "pubmed": Database.PUBMED,
    "geo": Database.GEO,
    "gdc": Database.GDC,
    "xena": Database.UCSC_XENA,
    "ucsc_xena": Database.UCSC_XENA,
    "pdb": Database.PDB,
    "reactome": Database.REACTOME,
    "pubchem": Database.PUBCHEM,
    "browser": Database.BROWSER,
}

# Source-level capability is necessary but not sufficient: the deterministic
# Pipeline only closes the following end-to-end combinations. Keep this table
# canonical so Agent admission and direct Pipeline callers fail identically.
SUPPORTED_PIPELINE_SOURCE_COMBINATIONS: frozenset[frozenset[Database]] = frozenset(
    {
        frozenset({Database.GEO}),
        frozenset({Database.PUBMED, Database.GEO}),
        frozenset({Database.GDC}),
        frozenset({Database.UCSC_XENA}),
        frozenset({Database.GDC, Database.UCSC_XENA}),
        frozenset({Database.REACTOME}),
    }
)


def is_supported_pipeline_source_combination(
    databases: set[Database] | frozenset[Database],
) -> bool:
    """Return whether the deterministic Pipeline implements this source set."""

    return frozenset(databases) in SUPPORTED_PIPELINE_SOURCE_COMBINATIONS


class DataLevel(StrEnum):
    RAW_SEQUENCE = "raw_sequence"
    SUBMITTER_PROCESSED = "submitter_processed"
    REPOSITORY_PROCESSED = "repository_processed"
    METADATA = "metadata"


class RequestedOutput(StrEnum):
    MAIN_DATA = "main_data"
    LITERATURE = "literature"
    DATASET_CATALOG = "dataset_catalog"
    SAMPLE_METADATA = "sample_metadata"


class TaskState(StrEnum):
    CREATED = "created"
    PLANNING = "planning"
    DISCOVERY = "discovery"
    ACQUISITION = "acquisition"
    PROCESSING = "processing"
    BUILDING_ARTIFACTS = "building_artifacts"
    VALIDATING = "validating"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class TaskMode(StrEnum):
    AGENT = "agent"
    FIXTURE = "fixture"
    IMPORT = "import"


class RunStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    FINALIZING = "finalizing"
    CANCEL_REQUESTED = "cancel_requested"
    AWAITING_USER_INPUT = "awaiting_user_input"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    INTERRUPTED = "interrupted"


class SubagentType(StrEnum):
    SOURCE_RESEARCH = "source_research"
    SKILL_BUILDER = "skill_builder"


class SubagentStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCEL_REQUESTED = "cancel_requested"
    CANCELLED = "cancelled"
    INTERRUPTED = "interrupted"


class SubagentErrorCode(StrEnum):
    NOT_FOUND = "not_found"
    CAPABILITY_GAP = "capability_gap"
    EXTRACTION_FAILED = "extraction_failed"
    AUTH_REQUIRED = "auth_required"
    CAPTCHA_REQUIRED = "captcha_required"
    CREDENTIAL_REQUIRED = "credential_required"
    PAYMENT_REQUIRED = "payment_required"
    POLICY_DENIED = "policy_denied"
    RATE_LIMITED = "rate_limited"
    TIMED_OUT = "timed_out"
    CANCELLED = "cancelled"
    INTERNAL_ERROR = "internal_error"
    MAX_TURNS_EXCEEDED = "max_turns_exceeded"


class MessageRole(StrEnum):
    SYSTEM = "system"
    USER = "user"
    ASSISTANT = "assistant"
    TOOL = "tool"


class StageName(StrEnum):
    DISCOVERY = "discovery"
    ACQUISITION = "acquisition"
    PROCESSING = "processing"
    ARTIFACT_BUILD = "artifact_build"
    VALIDATION = "validation"


class AttemptStatus(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"
    SKIPPED = "skipped"


class DownloadStatus(StrEnum):
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class WarningSeverity(StrEnum):
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"


class ErrorCode(StrEnum):
    CONFIGURATION_ERROR = "configuration_error"
    NETWORK_ERROR = "network_error"
    TIMEOUT = "timeout"
    DOWNLOAD_INCOMPLETE = "download_incomplete"
    CHECKSUM_MISMATCH = "checksum_mismatch"
    PARSE_ERROR = "parse_error"
    VALIDATION_ERROR = "validation_error"
    CANCELLED = "cancelled"
    INTERNAL_ERROR = "internal_error"


class QueryStatus(StrEnum):
    """Unified status for ``RunContext.log_query`` entries.

    Replaces the pre-§1.8 mix of ``ok`` / ``succeeded`` / ``completed`` /
    ``failed`` / ``error`` / ``page_fallback`` with a single enum so the
    competition judges can aggregate query statistics deterministically.

    Values:
        SUCCESS: query succeeded with results (records_count > 0)
        NOT_FOUND: query succeeded but returned 0 results (project_memory:
            failed queries must be marked ``not_found`` and not retried)
        FAILED: query failed (network error, API error, parse error)
        SKIPPED: query skipped (database not selected, dependency unmet)
        PAGE_FALLBACK: API failed, fell back to page scraping
            (project_memory L1: crawler log status for page fallback must be
            ``page_fallback`` with code 0, not ``ok`` with code 1)
    """

    SUCCESS = "success"
    NOT_FOUND = "not_found"
    FAILED = "failed"
    SKIPPED = "skipped"
    PAGE_FALLBACK = "page_fallback"
