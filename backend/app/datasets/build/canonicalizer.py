"""Canonicalizer: DataBatch -> canonical ``gene_expression.long.v1`` rows.

Applies the expression normalization profile (ARCHITECTURE §8; Design §8.5):

- authorizes each gene-id namespace (ensembl_gene / gene_symbol) and splits
  version suffixes, recording a normalization-log entry per entity;
- enforces the profile's allowed units / value semantics / value scales
  (Phase 5 D3: a scale outside the profile's ``allowed_value_scales`` is
  rejected; ``unknown`` is honest and never promoted to a known scale);
- separates normalization-rejected rows into an audit file.

The canonicalizer is pure and deterministic: identical inputs produce
identical outputs and audits, which is the component-level foundation for
Operation reuse in the Phase 2 runtime.
"""

from __future__ import annotations

import csv
import math
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from app.datasets.build.errors import BuildError
from app.datasets.build.hashing import sha256_file
from app.datasets.build.identity import MeasurementIdentity
from app.datasets.contracts import (
    DataBatch,
    DatasetSchema,
    FieldMapping,
    FileAsset,
    JsonValue,
    NormalizationProfile,
    ValueScale,
)
from app.domain.contracts import asset_id_from_sha256, make_record_id

_ENSEMBL_PATTERN = re.compile(r"^(ENSG\d{11})(?:\.(\d+))?$")
_SYMBOL_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_.\-]*$")
#: Affymetrix control/quality probes (``AFFX-...``) are not gene symbols;
#: namespace must come from the adapter declaration, never the ID shape
#: (Phase 5 D1).
_AFFYMETRIX_CONTROL_PATTERN = re.compile(r"^AFFX-", re.IGNORECASE)

NORMALIZATION_LOG_COLUMNS = (
    "record_id",
    "gene_id_raw",
    "gene_id",
    "gene_id_namespace",
    "gene_id_version",
    "rule_id",
    "evidence",
)

FIELD_MAPPING_COLUMNS = (
    "mapping_id",
    "source_schema_ref",
    "target_schema_ref",
    "source_field",
    "target_field",
    "transform",
    "mapping_method",
    "confidence_level",
    "evidence",
    "review_status",
)

REJECTED_COLUMNS = (
    "rejected_id",
    "batch_id",
    "gene_id_raw",
    "sample_id",
    "reason_code",
    "reason",
    "source_logical_file",
    "source_line_number",
    "source_raw_value",
)


@dataclass(frozen=True)
class CanonicalizationResult:
    """Output of one source's canonicalization step."""

    batch: DataBatch
    canonical_path: Path
    row_count: int
    rejected_count: int
    namespaces: tuple[str, ...]
    audit_paths: tuple[Path, ...]


def authorize_namespace(
    gene_id_raw: str, declared_namespace: str = ""
) -> tuple[str, str, str] | None:
    """Return ``(gene_id, namespace, version)`` or None when unauthorized.

    Phase 5 D1: the adapter-declared namespace
    (``gene_id_namespace_declared`` source-long column) is authoritative when
    present — ``geo_probe`` rows are never guessed into ``gene_symbol`` by ID
    shape.  Without a declaration (legacy GDC/Xena rows) the ENSG shape and a
    conservative gene-symbol shape authorize; probe-like identifiers such as
    Affymetrix control probes are never authorized as ``gene_symbol``.
    """
    if declared_namespace:
        if declared_namespace == "ensembl_gene":
            ensembl = _ENSEMBL_PATTERN.fullmatch(gene_id_raw)
            if ensembl:
                return ensembl.group(1), "ensembl_gene", ensembl.group(2) or ""
            return None
        if declared_namespace == "gene_symbol":
            return gene_id_raw, "gene_symbol", ""
        if declared_namespace == "geo_probe":
            return gene_id_raw, "geo_probe", ""
        return None
    ensembl = _ENSEMBL_PATTERN.fullmatch(gene_id_raw)
    if ensembl:
        return ensembl.group(1), "ensembl_gene", ensembl.group(2) or ""
    if _SYMBOL_PATTERN.fullmatch(gene_id_raw) and not (
        _AFFYMETRIX_CONTROL_PATTERN.match(gene_id_raw)
    ):
        return gene_id_raw, "gene_symbol", ""
    return None


def canonicalize(
    *,
    batch: DataBatch,
    schema: DatasetSchema,
    profile: NormalizationProfile,
    output_dir: Path,
    gene_symbol_map: Mapping[str, str] | None = None,
    probe_map: Mapping[str, str] | None = None,
    probe_target_namespace: str = "gene_symbol",
) -> CanonicalizationResult:
    """Transform one source-long batch into canonical schema rows.

    ``gene_symbol_map`` optionally maps ``gene_symbol`` IDs to Ensembl gene
    IDs (local, ship-bound; REVIEW §9.6).  A mapped row is re-namespaced to
    ``ensembl_gene`` and the conversion is recorded in the normalization log;
    unmapped symbols stay in their original namespace and are never dropped.

    Phase 5 T7 (D2/D5): ``probe_map`` optionally maps ``geo_probe`` rows to
    gene identifiers (a GPL platform annotation).  A hit is re-namespaced to
    ``probe_target_namespace`` (``gene_symbol`` or ``ensembl_gene``) and
    recorded with rule ``probe_gene_map``; an unmapped probe stays
    ``geo_probe`` (entity-level publish policy lives in the validation
    profile).  Under the probe schema (``gene_expression.probe_long.v1``)
    the canonical row carries ``probe_id``/``platform_id``/``value`` instead
    of the gene-schema primary columns.
    """
    source_path = output_dir / batch.file_asset.relative_path
    if not source_path.is_file():
        raise BuildError(f"batch file not found: {source_path}")
    canonical_dir = output_dir / "canonical"
    canonical_dir.mkdir(parents=True, exist_ok=True)
    canonical_path = canonical_dir / f"{batch.binding_id}.csv"
    rejected_path = canonical_dir / f"{batch.binding_id}_rejected.csv"
    log_path = canonical_dir / f"{batch.binding_id}_normalization_log.csv"
    mappings_path = canonical_dir / f"{batch.binding_id}_field_mappings.csv"

    columns = [field.name for field in schema.fields]
    probe_schema = any(field.name == "probe_id" for field in schema.fields)
    platform_ids = [
        str(platform_id) for platform_id in batch.statistics.get("platform_ids", [])
    ]
    row_count = 0
    rejected_count = 0
    mapped_count = 0
    probe_mapped_count = 0
    namespaces: set[str] = set()
    units: set[str] = set()
    identities: set[tuple[str, str, str]] = set()
    with (
        source_path.open("r", encoding="utf-8", newline="") as source,
        canonical_path.open("w", encoding="utf-8", newline="") as canonical,
        rejected_path.open("w", encoding="utf-8", newline="") as rejected,
        log_path.open("w", encoding="utf-8", newline="") as log,
    ):
        reader = csv.DictReader(source)
        writer = csv.DictWriter(canonical, fieldnames=columns)
        writer.writeheader()
        rejected_writer = csv.DictWriter(rejected, fieldnames=REJECTED_COLUMNS)
        rejected_writer.writeheader()
        log_writer = csv.DictWriter(log, fieldnames=NORMALIZATION_LOG_COLUMNS)
        log_writer.writeheader()
        for row in reader:
            gene_id_raw = row.get("gene_id_raw", "")
            declared = row.get("gene_id_namespace_declared", "") or ""
            normalized = (
                authorize_namespace(gene_id_raw, declared) if gene_id_raw else None
            )
            if normalized is None:
                rejected_writer.writerow(_rejected_row(row, batch, "unauthorized_namespace"))
                rejected_count += 1
                continue
            gene_id, namespace, version = normalized
            if namespace not in profile.allowed_namespaces:
                rejected_writer.writerow(_rejected_row(row, batch, "unauthorized_namespace"))
                rejected_count += 1
                continue
            unit = row.get("expression_unit", "")
            semantics = row.get("value_semantics", "")
            if unit not in profile.allowed_units:
                rejected_writer.writerow(
                    _rejected_row(row, batch, "unknown_unit", f"unit={unit!r}")
                )
                rejected_count += 1
                continue
            if semantics not in profile.allowed_semantics:
                rejected_writer.writerow(
                    _rejected_row(row, batch, "unknown_semantics", f"semantics={semantics!r}")
                )
                rejected_count += 1
                continue
            # Phase 5 D3/T4: the declared value scale must be an honest
            # ``ValueScale`` member that the profile explicitly allows.
            # ``unknown`` is accepted only when allowed; it is never promoted
            # to a known scale (log2) by inference.
            scale_raw = row.get("value_scale", "")
            try:
                scale = ValueScale(scale_raw)
            except ValueError:
                rejected_writer.writerow(
                    _rejected_row(row, batch, "unknown_scale", f"scale={scale_raw!r}")
                )
                rejected_count += 1
                continue
            if scale not in profile.allowed_value_scales:
                rejected_writer.writerow(
                    _rejected_row(row, batch, "unknown_scale", f"scale={scale_raw!r}")
                )
                rejected_count += 1
                continue
            try:
                if not math.isfinite(float(row.get("expression_value", ""))):
                    raise ValueError
            except ValueError:
                rejected_writer.writerow(
                    _rejected_row(
                        row,
                        batch,
                        "non_finite_value",
                        f"value={row.get('expression_value')!r}",
                    )
                )
                rejected_count += 1
                continue
            mapped = False
            if (
                namespace == "gene_symbol"
                and gene_symbol_map is not None
                and gene_id in gene_symbol_map
            ):
                gene_id = gene_symbol_map[gene_id]
                namespace = "ensembl_gene"
                version = ""
                mapped = True
                mapped_count += 1
            probe_mapped = False
            if (
                namespace == "geo_probe"
                and probe_map is not None
                and gene_id in probe_map
            ):
                gene_id = probe_map[gene_id]
                namespace = probe_target_namespace
                version = ""
                probe_mapped = True
                probe_mapped_count += 1
            canonical_row = {
                # Canonical output carries exactly the schema's columns: internal
                # source-long columns the schema does not declare (e.g. the
                # Phase 5 ``gene_id_namespace_declared``) must not leak into the
                # published contract, which keeps ``gene_id_namespace``
                # authoritative.
                key: value for key, value in row.items() if key in columns
            }
            canonical_row["record_id"] = make_record_id(
                row["dataset_id"], row["gene_id_raw"], row["sample_id"]
            )
            if probe_schema:
                # Under the probe contract the identity column is the ORIGINAL
                # probe id; probe->gene mapping only flips the namespace (D2:
                # mapped rows carry the target namespace, unmapped rows stay
                # geo_probe; the mapped gene id itself lives in the mapping
                # audit CSV).
                canonical_row["probe_id"] = row.get("gene_id_raw", "")
                canonical_row["platform_id"] = platform_ids[0] if platform_ids else ""
                if "value" in columns:
                    canonical_row["value"] = row.get("expression_value", "")
            else:
                canonical_row["gene_id"] = gene_id
                canonical_row["gene_id_version"] = version
            canonical_row["gene_id_namespace"] = namespace
            is_star = batch.statistics.get("format") == "star_counts"
            canonical_row["source_sample_alias"] = (
                "" if is_star else row.get("source_column_name", "")
            )
            writer.writerow(canonical_row)
            log_writer.writerow(
                {
                    "record_id": canonical_row["record_id"],
                    "gene_id_raw": row.get("gene_id_raw", ""),
                    "gene_id": gene_id,
                    "gene_id_namespace": namespace,
                    "gene_id_version": version,
                    "rule_id": (
                        "probe_gene_map"
                        if probe_mapped
                        else (
                            "gene_symbol_map"
                            if mapped
                            else (
                                "ensembl_version_split"
                                if namespace == "ensembl_gene" and version
                                else f"namespace_{namespace}"
                            )
                        )
                    ),
                    "evidence": (
                        "GPL platform annotation (probe->gene)"
                        if probe_mapped
                        else (
                            "local gene symbol map (symbol->ensembl)"
                            if mapped
                            else (
                                "Ensembl ID pattern ENSG###########(.N)"
                                if namespace == "ensembl_gene"
                                else "HGNC gene symbol pattern"
                            )
                        )
                    ),
                }
            )
            namespaces.add(namespace)
            units.add(unit)
            identities.add(
                MeasurementIdentity(
                    value_semantics=row.get("value_semantics", ""),
                    value_scale=scale,
                    expression_unit=unit,
                )
            )
            row_count += 1

    _write_field_mappings(mappings_path, batch.declared_mappings)

    payload_checksum = sha256_file(canonical_path)
    file_asset = FileAsset(
        asset_id=asset_id_from_sha256(payload_checksum),
        kind="normalized",
        relative_path=canonical_path.relative_to(output_dir).as_posix(),
        sha256=payload_checksum,
        size_bytes=canonical_path.stat().st_size,
        media_type="text/csv",
        generated_by_step_id="step_canonicalizer_v1",
    )
    # Unit-inconsistency detection (TODO Phase 6 P1, 原 §2.7.2): a canonical
    # batch that mixes more than one expression unit is recorded as an audit
    # warning so the publication decision can surface it instead of silently
    # merging incompatible scales. The profile-level unit_consistency check
    # remains the authoritative release gate.
    unit_warnings: list[str] = []
    if len(units) > 1:
        unit_warnings.append(
            f"multiple expression units in one batch: {sorted(units)!r}"
        )
    statistics: dict[str, JsonValue] = dict(batch.statistics)
    statistics.update(
        {
            "row_count": row_count,
            "rejected_count": rejected_count,
            "gene_id_namespaces": sorted(namespaces),
            "gene_symbol_mapped_count": mapped_count,
            "probe_mapped_count": probe_mapped_count,
            "expression_units": sorted(units),
            "unit_inconsistency_detected": len(units) > 1,
            "measurement_identities": [
                identity.serialize() for identity in sorted(identities)
            ],
            "schema_ref": schema.schema_id,
        }
    )
    canonical_batch = DataBatch(
        batch_id=f"canon_{batch.binding_id}",
        binding_id=batch.binding_id,
        dataset_family=batch.dataset_family,
        row_granularity=batch.row_granularity,
        schema_ref=schema.schema_id,
        file_asset=file_asset,
        row_count=row_count,
        column_count=len(columns),
        parser_id="expression.canonicalizer.v1",
        parser_version="1.0.0",
        statistics=statistics,
        warnings=batch.warnings + unit_warnings,
        declared_mappings=batch.declared_mappings,
    )
    audit_paths = (rejected_path, log_path, mappings_path)
    return CanonicalizationResult(
        batch=canonical_batch,
        canonical_path=canonical_path,
        row_count=row_count,
        rejected_count=rejected_count,
        namespaces=tuple(sorted(namespaces)),
        audit_paths=audit_paths,
    )


def _rejected_row(
    row: dict[str, str], batch: DataBatch, reason_code: str, detail: str = ""
) -> dict[str, str]:
    reason = reason_code.replace("_", " ")
    if detail:
        reason = f"{reason} ({detail})"
    return {
        "rejected_id": f"rej_{batch.binding_id}_{row.get('record_id', '')}",
        "batch_id": batch.batch_id,
        "gene_id_raw": row.get("gene_id_raw", ""),
        "sample_id": row.get("sample_id", ""),
        "reason_code": reason_code,
        "reason": reason,
        "source_logical_file": row.get("source_logical_file", ""),
        "source_line_number": row.get("source_line_number", ""),
        "source_raw_value": row.get("source_raw_value", ""),
    }


def _write_field_mappings(path: Path, mappings: list[FieldMapping]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELD_MAPPING_COLUMNS)
        writer.writeheader()
        for mapping in mappings:
            writer.writerow(
                {
                    "mapping_id": mapping.mapping_id,
                    "source_schema_ref": mapping.source_schema_ref,
                    "target_schema_ref": mapping.target_schema_ref,
                    "source_field": mapping.source_field,
                    "target_field": mapping.target_field,
                    "transform": mapping.transform,
                    "mapping_method": mapping.mapping_method.value,
                    "confidence_level": mapping.confidence_level.value,
                    "evidence": mapping.evidence,
                    "review_status": mapping.review_status.value,
                }
            )
