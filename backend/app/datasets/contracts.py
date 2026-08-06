"""V2 dataset construction contracts (Phase 1).

Self-contained ``DatasetBuildSpec`` plus the four orthogonal status contracts
(RunStatus is V1 runtime state; ``BuildResult`` / ``ValidationResult`` /
``DatasetPublication`` live here) — ARCHITECTURE §3.1, §9.1; Design §8.

The base model rejects unknown fields, so an Agent cannot smuggle acceptance
thresholds (``minimum_valid_rows``, ``allow_empty_primary_dataset``, ...) into
the spec; those belong to the server-side ``ValidationProfile``.
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from pydantic import Field, JsonValue, model_validator

from app.domain.contracts.base import ContractModel
from app.domain.contracts.source import FileAsset, SourceLocator


class BuildResultStatus(StrEnum):
    SUCCEEDED = "succeeded"
    PARTIAL_SUCCESS = "partial_success"
    NO_DATA = "no_data"
    SPEC_REJECTED = "spec_rejected"


class ValidationResultStatus(StrEnum):
    PASSED = "passed"
    FAILED = "failed"


class ArtifactRole(StrEnum):
    PRIMARY_DATASET = "primary_dataset"
    SUPPORTING_DATASET = "supporting_dataset"
    SCHEMA = "schema"
    PROVENANCE = "provenance"
    AUDIT_REPORT = "audit_report"


class AcquisitionMode(StrEnum):
    BUILTIN = "builtin"
    WORKFLOW_RECIPE = "workflow_recipe"


class MappingMethod(StrEnum):
    ADAPTER_DECLARED = "adapter_declared"
    SCHEMA_REGISTRY = "schema_registry"
    TRUSTED_METADATA = "trusted_metadata"
    EXPLICIT_RULE = "explicit_rule"
    HUMAN_APPROVED = "human_approved"
    STRING_SIMILARITY = "string_similarity"


class MappingReviewStatus(StrEnum):
    PROPOSED = "proposed"
    ACCEPTED = "accepted"
    REJECTED = "rejected"


class ConfidenceLevel(StrEnum):
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


class SchemaField(ContractModel):
    """One field of a canonical dataset schema (Design §8.2)."""

    name: str = Field(min_length=1)
    data_type: str = Field(min_length=1)
    semantic_role: str = Field(min_length=1)
    required: bool = True
    unit_policy: str | None = None
    ontology: str | None = None
    description: str = ""
    derivation_policy: str | None = None


class DatasetSchema(ContractModel):
    """Versioned canonical schema registered in the Schema Registry."""

    schema_id: str = Field(min_length=1)
    dataset_family: str = Field(min_length=1)
    row_granularity: str = Field(min_length=1)
    primary_key: list[str] = Field(min_length=1)
    fields: list[SchemaField] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_fields(self) -> DatasetSchema:
        names = [field.name for field in self.fields]
        if len(names) != len(set(names)):
            raise ValueError("schema field names must be unique")
        missing = [key for key in self.primary_key if key not in names]
        if missing:
            raise ValueError(f"primary_key fields missing from fields: {missing}")
        return self


class SourceBindingAcquisition(ContractModel):
    """How a source is acquired: trusted builtin or a promoted WorkflowRecipe."""

    mode: AcquisitionMode
    provider_id: str | None = Field(default=None, min_length=1)
    recipe_id: str | None = Field(default=None, min_length=1)
    recipe_version: int | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def validate_mode_fields(self) -> SourceBindingAcquisition:
        if self.mode is AcquisitionMode.BUILTIN and self.provider_id is None:
            raise ValueError("builtin acquisition requires provider_id")
        if self.mode is AcquisitionMode.WORKFLOW_RECIPE:
            if self.recipe_id is None:
                raise ValueError("workflow_recipe acquisition requires recipe_id")
            if self.recipe_version is None:
                raise ValueError("workflow_recipe acquisition requires recipe_version")
        return self


class SourceBinding(ContractModel):
    """One source selected by the Agent for a build (Design §8.3)."""

    binding_id: str = Field(min_length=1)
    source: str = Field(min_length=1)
    acquisition: SourceBindingAcquisition
    adapter_id: str = Field(min_length=1)
    accession: str | None = None
    parameters: dict[str, JsonValue] = Field(default_factory=dict)


class DatasetBuildSpec(ContractModel):
    """Self-contained build input produced by the Agent (ARCHITECTURE §3.1).

    The Agent cannot embed executable steps or acceptance thresholds; unknown
    fields are rejected by the base model.
    """

    build_id: str = Field(min_length=1)
    objective: str = Field(min_length=1)
    dataset_family: str = Field(min_length=1)
    row_granularity: str = Field(min_length=1)
    entities: dict[str, list[str]] = Field(default_factory=dict)
    cohort_filters: dict[str, list[str]] = Field(default_factory=dict)
    required_fields: list[str] = Field(default_factory=list)
    schema_ref: str = Field(min_length=1)
    source_bindings: list[SourceBinding] = Field(min_length=1)
    normalization_profile_ref: str | None = None
    merge_strategy: str = "append_by_canonical_row"
    validation_profile_ref: str = Field(min_length=1)
    output_format: str = "csv"


class DataBatch(ContractModel):
    """One source's parsed output (replaces the V1 in-memory ParsedDataset)."""

    batch_id: str = Field(min_length=1)
    binding_id: str = Field(min_length=1)
    dataset_family: str = Field(min_length=1)
    row_granularity: str = Field(min_length=1)
    schema_ref: str = Field(min_length=1)
    file_asset: FileAsset | None = None
    row_count: int = Field(ge=0)
    column_count: int = Field(ge=0)
    parser_id: str = Field(min_length=1)
    parser_version: str = Field(min_length=1)
    statistics: dict[str, JsonValue] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)
    declared_mappings: list[FieldMapping] = Field(default_factory=list)


class FieldMapping(ContractModel):
    """Formal field mapping record (ARCHITECTURE §8; Design §8.5).

    String-similarity generated mappings must remain ``proposed`` and are never
    admitted into a formal merge.
    """

    mapping_id: str = Field(min_length=1)
    source_schema_ref: str = Field(min_length=1)
    target_schema_ref: str = Field(min_length=1)
    source_field: str = Field(min_length=1)
    target_field: str = Field(min_length=1)
    transform: str = "identity"
    mapping_method: MappingMethod
    confidence_level: ConfidenceLevel = ConfidenceLevel.MEDIUM
    evidence: str = Field(min_length=1)
    review_status: MappingReviewStatus = MappingReviewStatus.PROPOSED

    @model_validator(mode="after")
    def validate_similarity_review(self) -> FieldMapping:
        if (
            self.mapping_method is MappingMethod.STRING_SIMILARITY
            and self.review_status is not MappingReviewStatus.PROPOSED
        ):
            raise ValueError("string-similarity mappings must remain proposed")
        return self


class TransformRecord(ContractModel):
    transform_id: str = Field(min_length=1)
    input: str = ""
    output: str = ""


class ProvenanceRecord(ContractModel):
    """Record- or batch-level lineage sidecar (ARCHITECTURE §12; Design §8.6)."""

    provenance_id: str = Field(min_length=1)
    record_id: str = Field(min_length=1)
    source_asset_id: str = Field(min_length=1)
    source_locator: SourceLocator
    transforms: list[TransformRecord] = Field(default_factory=list)


class ConfidenceComponents(ContractModel):
    source_reliability: ConfidenceLevel | None = None
    extraction_reliability: ConfidenceLevel | None = None
    mapping_reliability: ConfidenceLevel | None = None
    validation_status: str = "not_checked"
    cross_source_consistency: str = "not_checked"


class ConfidenceRecord(ContractModel):
    """Explainable confidence, never an uncalibrated probability (Design §8.7)."""

    confidence_id: str = Field(min_length=1)
    record_id: str = Field(min_length=1)
    level: ConfidenceLevel
    channel: str = Field(min_length=1)
    components: ConfidenceComponents = Field(default_factory=ConfidenceComponents)
    reasons: list[str] = Field(default_factory=list)
    requires_human_review: bool = False


class BuildResult(ContractModel):
    """Business outcome of a normally completed build (ARCHITECTURE §9.1).

    Only produced when ``RunStatus == COMPLETED``; execution failures and
    user cancellation are expressed by RunStatus, not by this enum.
    """

    status: BuildResultStatus
    valid_row_count: int = Field(ge=0)
    successful_sources: list[str] = Field(default_factory=list)
    rejected_sources: list[str] = Field(default_factory=list)
    available_artifact_roles: list[ArtifactRole] = Field(default_factory=list)
    publication_id: str | None = None
    reason_codes: list[str] = Field(default_factory=list)
    user_summary: str = ""
    recommended_next_action: str = ""

    @model_validator(mode="after")
    def validate_state(self) -> BuildResult:
        if self.status is BuildResultStatus.SUCCEEDED:
            if not self.successful_sources:
                raise ValueError("succeeded build requires successful_sources")
            if self.publication_id is None:
                raise ValueError("succeeded build requires publication_id")
        if self.status is BuildResultStatus.NO_DATA and self.valid_row_count != 0:
            raise ValueError("no_data build must have zero valid rows")
        if (
            self.status is BuildResultStatus.SPEC_REJECTED
            and not self.reason_codes
        ):
            raise ValueError("spec_rejected build requires reason_codes")
        if (
            self.publication_id is not None
            and self.status
            not in (BuildResultStatus.SUCCEEDED, BuildResultStatus.PARTIAL_SUCCESS)
        ):
            raise ValueError(
                "publication_id is only valid for succeeded or partial_success"
            )
        return self


class ValidationResult(ContractModel):
    """Whether a manifest digest passed a profile (ARCHITECTURE §9.1)."""

    manifest_digest: str = Field(min_length=1)
    profile_ref: str = Field(min_length=1)
    status: ValidationResultStatus
    checked_count: int = Field(ge=0)
    failed_count: int = Field(ge=0)
    report_path: str | None = None

    @model_validator(mode="after")
    def validate_counts(self) -> ValidationResult:
        if self.failed_count > self.checked_count:
            raise ValueError("failed_count must not exceed checked_count")
        if self.status is ValidationResultStatus.PASSED and self.failed_count != 0:
            raise ValueError("passed requires zero failed checks")
        if self.status is ValidationResultStatus.FAILED and self.failed_count == 0:
            raise ValueError("failed requires at least one failed check")
        return self


class ManifestArtifactEntry(ContractModel):
    artifact_id: str = Field(min_length=1)
    role: ArtifactRole
    relative_path: str = Field(min_length=1)
    media_type: str = Field(min_length=1)
    size_bytes: int = Field(ge=0)
    sha256: str = Field(min_length=1)


class DatasetManifest(ContractModel):
    """Immutable artifact inventory, role-based (ARCHITECTURE §3.6; Design §8.9)."""

    manifest_id: str = Field(min_length=1)
    task_id: str = Field(min_length=1)
    build_id: str = Field(min_length=1)
    dataset_family: str = Field(min_length=1)
    row_granularity: str = Field(min_length=1)
    schema_ref: str = Field(min_length=1)
    primary_key: list[str] = Field(default_factory=list)
    row_count: int = Field(ge=0)
    sha256: str = Field(min_length=1)
    artifacts: list[ManifestArtifactEntry] = Field(default_factory=list)
    source_summary: dict[str, JsonValue] = Field(default_factory=dict)
    validation_summary: dict[str, JsonValue] = Field(default_factory=dict)
    confidence_summary: dict[str, JsonValue] = Field(default_factory=dict)
    provenance_summary: dict[str, JsonValue] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_primary_role(self) -> DatasetManifest:
        primaries = [
            entry for entry in self.artifacts
            if entry.role is ArtifactRole.PRIMARY_DATASET
        ]
        if len(primaries) > 1:
            raise ValueError("manifest may declare at most one primary_dataset")
        return self


class DatasetPublication(ContractModel):
    """Atomically promoted immutable version (ARCHITECTURE §9.1; Design §8.9).

    ``final`` is just the session pointer ``current_publication_id``, never an
    intrinsic artifact state.
    """

    publication_id: str = Field(min_length=1)
    manifest_ref: str = Field(min_length=1)
    validation_result_ref: str = Field(min_length=1)
    published_at: datetime
    supersedes_publication_id: str | None = None

    @model_validator(mode="after")
    def validate_supersede(self) -> DatasetPublication:
        if self.supersedes_publication_id == self.publication_id:
            raise ValueError("publication cannot supersede itself")
        return self


class AcceptancePolicy(ContractModel):
    """Server-side acceptance thresholds (Design §9.2).

    Agents cannot pass these; they belong to the versioned profile.
    """

    minimum_valid_rows: int = Field(ge=0, default=1)
    allow_empty_primary_dataset: bool = False
    allow_partial_publish: bool = True


class ValidationProfile(ContractModel):
    """Versioned validation profile skeleton (ARCHITECTURE §10; Design §8).

    Per-family checks (units, probe mapping coverage, chart bbox/model, ...)
    are filled in during Phase 3/6; the acceptance policy is authoritative here.
    """

    profile_id: str = Field(min_length=1)
    dataset_family: str = Field(min_length=1)
    acceptance: AcceptancePolicy = Field(default_factory=AcceptancePolicy)
    description: str = ""


class UnitConversionRule(ContractModel):
    """A provably-equivalent unit conversion declared by the server (Design §8.5)."""

    rule_id: str = Field(min_length=1)
    from_unit: str = Field(min_length=1)
    to_unit: str = Field(min_length=1)
    formula: str = Field(min_length=1)
    evidence: str = Field(min_length=1)


class NormalizationProfile(ContractModel):
    """Versioned entity/unit normalization policy (ARCHITECTURE §8; Design §8.5).

    Authorizes gene-id namespaces, the units and value semantics a source may
    declare, and the many-to-one aggregation policy.  Conversions are opt-in:
    without a declared rule, two units are never silently merged.
    """

    profile_id: str = Field(min_length=1)
    dataset_family: str = Field(min_length=1)
    allowed_namespaces: list[str] = Field(min_length=1)
    allowed_units: list[str] = Field(min_length=1)
    allowed_semantics: list[str] = Field(min_length=1)
    unit_conversions: list[UnitConversionRule] = Field(default_factory=list)
    aggregation_policy: str = Field(default="keep_all", min_length=1)
    description: str = ""
