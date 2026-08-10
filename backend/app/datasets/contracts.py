"""V2 dataset construction contracts (Phase 1).

Self-contained ``DatasetBuildSpec`` plus the four orthogonal status contracts
(RunStatus is V1 runtime state; ``BuildResult`` / ``ValidationResult`` /
``DatasetPublication`` live here) — ARCHITECTURE §3.1, §9.1; Design §8.

The base model rejects unknown fields, so an Agent cannot smuggle acceptance
thresholds (``minimum_valid_rows``, ``allow_empty_primary_dataset``, ...) into
the spec; those belong to the server-side ``ValidationProfile``.

``BuildResultStatus`` / ``ArtifactRole`` / ``BuildResult`` are re-exported from
``app.domain.contracts.dataset_state`` (which ``app.domain.contracts.runtime``
imports directly); keeping them here preserves every existing import site while
breaking the datasets <-> contracts import cycle.
"""

from __future__ import annotations

import math
import re
from datetime import datetime
from enum import StrEnum
from typing import Literal

from pydantic import Field, JsonValue, field_validator, model_validator

from app.domain.contracts.base import ContractModel
from app.domain.contracts.dataset_state import (
    ArtifactRole,
)
from app.domain.contracts.dataset_state import (
    BindingFailureDetail as BindingFailureDetail,
)
from app.domain.contracts.dataset_state import (
    BuildResult as BuildResult,
)
from app.domain.contracts.dataset_state import (
    BuildResultStatus as BuildResultStatus,
)
from app.domain.contracts.source import FileAsset, SourceLocator
from app.tools.workdir import validate_safe_path_id

#: Stable validation check id for the gene-required probe-coverage policy
#: (T5): shared by ``profiles.py`` (the check) and ``dataset_build_tool.py``
#: (the outcome classifier) so the two cannot drift (review-loop R3-6).
CHECK_ID_PROBE_COVERAGE_REQUIRED_GENE_LEVEL = "probe_coverage_required_gene_level"

#: Stable NO_DATA reason code emitted when a gene-required build has no
#: publishable gene rows (T7); shared by ``expression_runner.py`` and
#: ``dataset_build_tool.py`` (review-loop R3-6).
REASON_PROBE_MAPPING_UNAVAILABLE_REQUIRED_GENE_LEVEL = (
    "probe_mapping_unavailable_required_gene_level"
)


class ValidationResultStatus(StrEnum):
    PASSED = "passed"
    FAILED = "failed"


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


class ValueScale(StrEnum):
    """Honest value-scale declaration for expression measurements (Phase 5 D3).

    ``unknown`` is a legitimate value: a scale that cannot be proven from
    metadata/parameters must be declared ``unknown`` and is never promoted to
    a known scale by guessing.  ``raw_count`` is a value *semantics*, not a
    scale.
    """

    LINEAR = "linear"
    LOG2 = "log2"
    LOG10 = "log10"
    UNKNOWN = "unknown"


class BindingRejectionKind(StrEnum):
    """Why one source binding was rejected during phase A (Phase 5 T7 D5).

    ``no_primary`` means the binding produced no publishable primary rows
    (empty source, zero valid rows, or — for gene-required builds — no
    publishable gene rows); ``error`` means the binding's parse/structure
    step failed.
    """

    NO_PRIMARY = "no_primary"
    ERROR = "error"


class BindingRejection(ContractModel):
    """Per-binding rejection captured by the per-binding fan-out (Phase 5 T7).

    Phase A (acquire/parse/canonicalize) executes independently per binding;
    a binding's ``EmptySourceError`` / parse failure / zero-usable-rows
    outcome is recorded here instead of aborting the other bindings.  Phase B
    (integrate/validate/publish) only receives phase-A successes and is
    skipped entirely when every binding is rejected.
    """

    binding_id: str = Field(min_length=1)
    kind: BindingRejectionKind
    #: Stable reason code: ``no_primary_data``, ``parse_error``,
    #: ``build_error``, or ``probe_mapping_unavailable_required_gene_level``.
    reason_code: str = Field(min_length=1)
    message: str = ""


class AnnotationStatus(StrEnum):
    """GEO platform annotation outcome (Phase 5 D3 ``PlatformRecord``)."""

    MAPPED = "mapped"
    UNMAPPED = "unmapped"
    NO_GENE_ANNOTATION = "no_gene_annotation"
    ANNOTATION_UNAVAILABLE = "annotation_unavailable"
    NOT_ATTEMPTED = "not_attempted"


class ProbeMappingStatus(StrEnum):
    """Probe→gene mapping outcome per canonicalized binding/platform (D3).

    ``mapped`` means full coverage (1.0), ``partial`` means 0 < coverage < 1,
    ``unmapped`` means zero coverage.  The remaining values mirror
    ``AnnotationStatus`` for platforms whose annotation could not be used.
    """

    MAPPED = "mapped"
    PARTIAL = "partial"
    UNMAPPED = "unmapped"
    NO_GENE_ANNOTATION = "no_gene_annotation"
    ANNOTATION_UNAVAILABLE = "annotation_unavailable"
    NOT_ATTEMPTED = "not_attempted"


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

    @field_validator("binding_id")
    @classmethod
    def validate_binding_id(cls, value: str) -> str:
        # B1 (Phase 4 review): binding_id is interpolated into generated
        # filenames (batches/<binding_id>_rejected.csv, ...) so a path-like
        # value must be rejected before any path is constructed.
        return validate_safe_path_id(value, "binding_id")


# GEO platform accessions and content-addressed asset digests.
_GPL_PATTERN = re.compile(r"^GPL\d+$")
_SHA256_PATTERN = re.compile(r"^[0-9a-fA-F]{64}$")


class AdapterParams(ContractModel):
    """Typed adapter parameters for GEO expression parsing (Phase 5 D1).

    The caller declares the parse format, measurement semantics/scale/unit
    and platform accessions up front; the adapter never infers a value scale
    from file names or metadata.  ``unknown`` scales are honest and allowed.
    ``delimiter`` is only meaningful for the ``supplementary_matrix`` format.
    """

    format: Literal["tximport_counts", "series_matrix", "supplementary_matrix"]
    value_semantics: str = Field(min_length=1)
    value_scale: ValueScale
    expression_unit: str = Field(min_length=1)
    is_normalized: bool = False
    platform_ids: list[str] = Field(default_factory=list)
    delimiter: str = "auto"

    @field_validator("platform_ids")
    @classmethod
    def validate_platform_ids(cls, value: list[str]) -> list[str]:
        for platform_id in value:
            if not _GPL_PATTERN.fullmatch(platform_id):
                raise ValueError(
                    f"platform_id {platform_id!r} must match ^GPL\\d+$"
                )
        return value

    @field_validator("delimiter")
    @classmethod
    def validate_delimiter(cls, value: str) -> str:
        if value != "auto" and len(value) != 1:
            raise ValueError("delimiter must be 'auto' or a single character")
        return value

    @model_validator(mode="after")
    def validate_format_applicability(self) -> AdapterParams:
        if self.delimiter != "auto" and self.format != "supplementary_matrix":
            raise ValueError(
                "delimiter is only applicable to supplementary_matrix format"
            )
        return self


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
    # Phase 5 D2: optional entity-level declaration; None defers to the
    # selected validation profile's ``required_entity_level`` (T4/T5).
    target_entity_level: Literal["gene", "probe"] | None = None

    @field_validator("build_id")
    @classmethod
    def validate_build_id(cls, value: str) -> str:
        # B1 (Phase 4 review): build_root / build_id must stay inside the
        # task work directory; reject absolute/traversal path-like values at
        # model construction (defense in depth in the tool as well).
        return validate_safe_path_id(value, "build_id")


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
    are filled in during Phase 3/6; the acceptance policy is authoritative
    here.  ``required_entity_level`` (Phase 5 D4) is the entity level this
    profile's release gate requires; it is a server-side versioned field and
    drives the Spec Validator's entity-level compatibility check.
    """

    profile_id: str = Field(min_length=1)
    dataset_family: str = Field(min_length=1)
    acceptance: AcceptancePolicy = Field(default_factory=AcceptancePolicy)
    description: str = ""
    required_entity_level: Literal["gene", "probe", "any"]


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
    declare, the value scales (Phase 5 D3) and the many-to-one aggregation
    policy.  Conversions are opt-in: without a declared rule, two units are
    never silently merged.  ``allowed_value_scales`` is a required non-empty
    allowlist: ``unknown`` is honest but must be explicitly allowed, and is
    never promoted to a known scale by inference.
    """

    profile_id: str = Field(min_length=1)
    dataset_family: str = Field(min_length=1)
    allowed_namespaces: list[str] = Field(min_length=1)
    allowed_units: list[str] = Field(min_length=1)
    allowed_semantics: list[str] = Field(min_length=1)
    allowed_value_scales: list[ValueScale] = Field(min_length=1)
    unit_conversions: list[UnitConversionRule] = Field(default_factory=list)
    aggregation_policy: str = Field(default="keep_all", min_length=1)
    description: str = ""


class PlatformRecord(ContractModel):
    """One GEO platform's annotation provenance and outcome (Phase 5 D3).

    A platform may be reused across matrices and mapping attempts; organism
    and asset provenance belong here, not in per-build statistics.
    """

    platform_id: str = Field(min_length=1)
    source_id: str = Field(min_length=1)
    annotation_asset_id: str | None = None
    organism: str | None = None
    annotation_status: AnnotationStatus
    probe_id_field: str | None = None
    gene_id_field: str | None = None
    target_namespace: Literal["gene_symbol", "ensembl_gene"] | None = None
    mapping_source_url: str | None = None
    annotation_sha256: str | None = None

    @field_validator("platform_id")
    @classmethod
    def validate_platform_id(cls, value: str) -> str:
        if not _GPL_PATTERN.fullmatch(value):
            raise ValueError(f"platform_id {value!r} must match ^GPL\\d+$")
        return value

    @field_validator("annotation_sha256")
    @classmethod
    def validate_annotation_sha256(cls, value: str | None) -> str | None:
        if value is not None and not _SHA256_PATTERN.fullmatch(value):
            raise ValueError("annotation_sha256 must be 64 hex characters")
        return value

    @model_validator(mode="after")
    def validate_annotation_consistency(self) -> PlatformRecord:
        if (
            self.annotation_status is AnnotationStatus.NOT_ATTEMPTED
            and any(
                value is not None
                for value in (
                    self.annotation_asset_id,
                    self.mapping_source_url,
                    self.annotation_sha256,
                )
            )
        ):
            raise ValueError(
                "not_attempted requires annotation_asset_id, "
                "mapping_source_url and annotation_sha256 to be None"
            )
        if self.annotation_asset_id is not None:
            if self.annotation_sha256 is None:
                raise ValueError(
                    "annotation_asset_id requires annotation_sha256 "
                    "(64 hex characters)"
                )
            if self.annotation_status not in (
                AnnotationStatus.MAPPED,
                AnnotationStatus.UNMAPPED,
                AnnotationStatus.NO_GENE_ANNOTATION,
            ):
                raise ValueError(
                    "annotation_asset_id requires annotation_status in "
                    "{mapped, unmapped, no_gene_annotation}"
                )
        if self.annotation_status is AnnotationStatus.MAPPED:
            if self.target_namespace is None:
                raise ValueError("mapped requires target_namespace")
            if self.gene_id_field is None:
                raise ValueError("mapped requires gene_id_field")
        return self


class ProbeMappingSummary(ContractModel):
    """Probe→gene mapping audit summary per binding/platform (Phase 5 D3).

    Counts distinct probes; rows expanded to gene×sample are never recounted.
    ``coverage_ratio`` is always ``mapped_probe_count / total_probe_count``
    (``0.0`` when ``total_probe_count == 0``), verified within 1e-9.
    """

    binding_id: str = Field(min_length=1)
    platform_id: str | None = None
    source_namespace: str = "geo_probe"
    target_namespace: Literal["gene_symbol", "ensembl_gene"] | None = None
    mapping_status: ProbeMappingStatus
    total_probe_count: int = Field(ge=0)
    mapped_probe_count: int = Field(ge=0)
    unmapped_probe_count: int = Field(ge=0)
    ambiguous_probe_count: int = Field(ge=0)
    coverage_ratio: float = Field(ge=0.0, le=1.0)
    mapping_asset_id: str | None = None
    mapping_rule_id: str | None = None

    @field_validator("platform_id")
    @classmethod
    def validate_platform_id(cls, value: str | None) -> str | None:
        if value is not None and not _GPL_PATTERN.fullmatch(value):
            raise ValueError(f"platform_id {value!r} must match ^GPL\\d+$")
        return value

    @field_validator("source_namespace")
    @classmethod
    def validate_source_namespace(cls, value: str) -> str:
        if value != "geo_probe":
            raise ValueError("source_namespace must be 'geo_probe'")
        return value

    @model_validator(mode="after")
    def validate_counts(self) -> ProbeMappingSummary:
        if (
            self.mapped_probe_count + self.unmapped_probe_count
            != self.total_probe_count
        ):
            raise ValueError(
                "mapped_probe_count + unmapped_probe_count must equal "
                "total_probe_count"
            )
        if self.mapped_probe_count > self.total_probe_count:
            raise ValueError(
                "mapped_probe_count must not exceed total_probe_count"
            )
        if self.ambiguous_probe_count > self.unmapped_probe_count:
            raise ValueError(
                "ambiguous_probe_count must not exceed unmapped_probe_count"
            )
        expected = (
            0.0
            if self.total_probe_count == 0
            else self.mapped_probe_count / self.total_probe_count
        )
        if not math.isclose(self.coverage_ratio, expected, rel_tol=0.0, abs_tol=1e-9):
            raise ValueError(
                "coverage_ratio must equal mapped_probe_count / total_probe_count"
            )
        if self.mapping_status is ProbeMappingStatus.MAPPED:
            if not math.isclose(self.coverage_ratio, 1.0, rel_tol=0.0, abs_tol=1e-9):
                raise ValueError(
                    "mapping_status 'mapped' requires coverage_ratio == 1.0"
                )
        elif self.mapping_status is ProbeMappingStatus.PARTIAL:
            if not 0.0 < self.coverage_ratio < 1.0:
                raise ValueError(
                    "mapping_status 'partial' requires 0 < coverage_ratio < 1"
                )
        elif self.mapping_status is ProbeMappingStatus.UNMAPPED:
            if not math.isclose(self.coverage_ratio, 0.0, rel_tol=0.0, abs_tol=1e-9):
                raise ValueError(
                    "mapping_status 'unmapped' requires coverage_ratio == 0.0"
                )
        elif self.mapping_status is ProbeMappingStatus.NOT_ATTEMPTED:
            if any(
                count != 0
                for count in (
                    self.total_probe_count,
                    self.mapped_probe_count,
                    self.unmapped_probe_count,
                    self.ambiguous_probe_count,
                )
            ):
                raise ValueError(
                    "not_attempted requires all probe counts to be zero"
                )
            if self.mapping_asset_id is not None or self.mapping_rule_id is not None:
                raise ValueError(
                    "not_attempted requires mapping_asset_id and "
                    "mapping_rule_id to be None"
                )
        if self.mapping_status in (
            ProbeMappingStatus.MAPPED,
            ProbeMappingStatus.PARTIAL,
        ) and self.mapping_asset_id is None:
            raise ValueError(
                "mapping_status mapped/partial requires mapping_asset_id"
            )
        return self
