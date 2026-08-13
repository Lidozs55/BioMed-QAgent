"""SourceAdapters: source format -> DataBatch (ARCHITECTURE §2 parse[*]).

An Adapter is the deterministic, fail-closed parser for one source format.
It verifies the SourceAsset checksum, understands the source layout (wide
matrix or single-sample STAR counts), validates every cell, and streams a
*source-long* table plus parse-level rejected rows.  It does NOT normalize
entity identifiers or units — that is the Canonicalizer's job.  The adapter
declares formal FieldMappings (method ``adapter_declared``) that become the
audited mapping evidence for the compatibility gate.

Numeric policy (uniform across adapters): structural malformation (wrong
field count, bad header, blank gene id) is fatal and fail-closed; a value
cell that is not a finite number (blank, ``nan``, ``inf``, garbage) is
rejected row-level into the audit file — never silently accepted, never
aborting the whole source.
"""

from __future__ import annotations

import csv
import math
from abc import ABC, abstractmethod
from pathlib import Path
from typing import ClassVar, TextIO

from pydantic import ValidationError

from app.datasets.build.errors import AdapterError, BuildError, EmptySourceError
from app.datasets.build.hashing import sha256_file
from app.datasets.contracts import (
    AdapterParams,
    ConfidenceLevel,
    DataBatch,
    FieldMapping,
    FileAsset,
    JsonValue,
    MappingMethod,
    MappingReviewStatus,
    SourceBinding,
)
from app.domain.contracts import SourceAsset, asset_id_from_sha256, make_record_id
from app.tools.io import open_text

# Source-long layout emitted by every expression adapter.  ``gene_id_raw`` is
# verbatim; namespace/version authorization and unit policy are applied later
# by the Canonicalizer.  ``gene_id_namespace_declared`` (Phase 5 D1) is the
# internal namespace the adapter declares for the row; the canonical schema
# output keeps ``gene_id_namespace`` authoritative, and the canonicalizer
# (T2) consumes the declared value instead of guessing from the ID shape.
SOURCE_LONG_COLUMNS: tuple[str, ...] = (
    "record_id",
    "dataset_id",
    "source_id",
    "asset_id",
    "gene_id_raw",
    "gene_id_namespace_declared",
    "sample_id",
    "measurement_type",
    "value_semantics",
    "value_scale",
    "is_normalized",
    "is_integer_expected",
    "expression_value",
    "expression_unit",
    "source_logical_file",
    "source_line_number",
    "source_column_index",
    "source_column_name",
    "source_raw_value",
)

# Parse-level rejection audit row shape.
REJECTED_COLUMNS: tuple[str, ...] = (
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

# GDC files-API expression exports may carry annotation columns next to the
# gene_id column; they are not samples and must not become long-format rows.
_GDC_ANNOTATION_COLUMNS = frozenset(
    {"gene_name", "gene_type", "gene_version", "gene_id_version"}
)


def _open_table(path: Path) -> TextIO:
    return open_text(path, encoding="utf-8", newline="")


def _verify_sha256(path: Path, expected: str) -> None:
    digest = sha256_file(path)
    if digest != expected:
        raise AdapterError(f"source asset checksum mismatch before parsing: {path}")


def _is_finite_number(value: str) -> bool:
    try:
        return math.isfinite(float(value))
    except ValueError:
        return False


def _mapping(
    *,
    mapping_id: str,
    binding_id: str,
    source_field: str,
    target_field: str,
    transform: str,
    evidence: str,
) -> FieldMapping:
    return FieldMapping(
        mapping_id=f"map_{binding_id}_{mapping_id}",
        source_schema_ref=f"binding_{binding_id}.source",
        target_schema_ref="gene_expression.long.v1",
        source_field=source_field,
        target_field=target_field,
        transform=transform,
        mapping_method=MappingMethod.ADAPTER_DECLARED,
        confidence_level=ConfidenceLevel.HIGH,
        evidence=evidence,
        review_status=MappingReviewStatus.ACCEPTED,
    )


def _wide_matrix_mappings(
    *,
    binding_id: str,
    samples: list[str],
    gene_evidence: str,
    sample_evidence: str,
) -> list[FieldMapping]:
    """Declared mappings for a wide expression matrix (gene_id + samples)."""
    mappings = [
        _mapping(
            mapping_id="gene_id_to_raw",
            binding_id=binding_id,
            source_field="gene_id",
            target_field="gene_id_raw",
            transform="identity",
            evidence=gene_evidence,
        )
    ]
    for sample in samples:
        mappings.append(
            _mapping(
                mapping_id=f"sample_id_{sample}",
                binding_id=binding_id,
                source_field=sample,
                target_field="sample_id",
                transform="wide_to_long_sample_id",
                evidence=sample_evidence,
            )
        )
        mappings.append(
            _mapping(
                mapping_id=f"value_{sample}",
                binding_id=binding_id,
                source_field=sample,
                target_field="expression_value",
                transform="wide_to_long_value",
                evidence=sample_evidence,
            )
        )
    return mappings


def _emit_matrix_cells(
    long_writer: csv.DictWriter[str],
    rejected_writer: csv.DictWriter[str],
    *,
    batch_id: str,
    source_asset: SourceAsset,
    build_id: str,
    source_name: str,
    line: int,
    values: list[str],
    header: list[str],
    samples: list[str],
) -> tuple[int, int]:
    """Emit long rows for one wide-matrix row; returns (emitted, rejected).

    Value cells that are not finite numbers become rejected audit rows.
    """
    emitted = rejected = 0
    gene_id_raw = values[0]
    for sample_id in samples:
        column = header.index(sample_id)
        raw = values[column]
        if not _is_finite_number(raw):
            rejected_writer.writerow(
                _rejected(
                    batch_id=batch_id,
                    gene_id_raw=gene_id_raw,
                    sample_id=sample_id,
                    reason_code="non_finite_value",
                    reason=f"value={raw!r} is not a finite number",
                    source_name=source_name,
                    line=line,
                    raw_value=raw,
                )
            )
            rejected += 1
            continue
        long_writer.writerow(
            _long_row(
                build_id=build_id,
                source_asset=source_asset,
                gene_id_raw=gene_id_raw,
                sample_id=sample_id,
                measurement_type="gene_expression",
                value_semantics="expression_value",
                value_scale="linear",
                is_normalized=False,
                is_integer_expected=False,
                expression_value=raw,
                expression_unit="expression_value",
                source_name=source_name,
                line=line,
                column=column,
                column_name=sample_id,
            )
        )
        emitted += 1
    return emitted, rejected


def _row_granularity_for(schema_ref: str) -> str:
    """Map the target schema to the parsed row granularity (Phase 5 D2).

    The probe-level contract describes probe x sample measurements; every
    other expression schema is gene-level.  The schema registry remains the
    authority for a schema's declared granularity; this mirrors it for the
    adapter's ``DataBatch`` without a registry dependency.
    """
    return (
        "probe_sample_measurement"
        if schema_ref == "gene_expression.probe_long.v1"
        else "gene_sample_measurement"
    )


def _file_asset(
    path: Path,
    *,
    output_dir: Path,
    kind: str,
    generated_by_step_id: str,
) -> FileAsset:
    checksum = sha256_file(path)
    return FileAsset(
        asset_id=asset_id_from_sha256(checksum),
        kind=kind,
        relative_path=path.relative_to(output_dir).as_posix(),
        sha256=checksum,
        size_bytes=path.stat().st_size,
        media_type="text/csv",
        generated_by_step_id=generated_by_step_id,
    )


def adapter_params_for_binding(binding: SourceBinding) -> AdapterParams | None:
    """Build typed AdapterParams from a binding's declared parameters.

    Returns ``None`` when the binding declares no parameters (legacy GDC/Xena
    adapters ignore them).  Declared parameters must form a valid
    ``AdapterParams`` (Phase 5 D1); a violation raises ``BuildError`` so the
    build fails closed instead of reaching the adapter with a partial
    contract.
    """
    if not binding.parameters:
        return None
    try:
        return AdapterParams.model_validate(binding.parameters)
    except ValidationError as exc:
        raise BuildError(
            f"binding {binding.binding_id!r} has invalid adapter parameters: "
            f"{exc}"
        ) from exc


class SourceAdapter(ABC):
    """Base class for expression source adapters (fail closed)."""

    adapter_id: ClassVar[str]
    version: ClassVar[str]
    source_database: ClassVar[str]

    def parse(
        self,
        source_asset: SourceAsset,
        source_path: Path,
        *,
        build_id: str,
        binding_id: str,
        schema_ref: str,
        output_dir: Path,
        parameters: AdapterParams | None = None,
        metadata_path: Path | None = None,
    ) -> DataBatch:
        """Parse *source_asset* into a source-long DataBatch.

        ``parameters`` (Phase 5 D1) carries the typed ``AdapterParams`` for
        format-selected adapters (geo.expression.v1); legacy adapters ignore
        it.  Raises ``AdapterError`` on checksum mismatch or malformed input;
        a partially written output file is removed so the chain never
        consumes a truncated batch.
        """
        source_path = Path(source_path)
        _verify_sha256(source_path, source_asset.sha256)
        source_name = source_path.name
        batch_dir = output_dir / "batches"
        batch_dir.mkdir(parents=True, exist_ok=True)
        output_path = batch_dir / f"{binding_id}.csv"
        rejected_path = batch_dir / f"{binding_id}_rejected.csv"
        supporting_paths: list[Path] = []
        try:
            with (
                _open_table(source_path) as source,
                output_path.open("w", encoding="utf-8", newline="") as target,
                rejected_path.open("w", encoding="utf-8", newline="") as rejected,
            ):
                long_writer = csv.DictWriter(target, fieldnames=SOURCE_LONG_COLUMNS)
                long_writer.writeheader()
                rejected_writer = csv.DictWriter(rejected, fieldnames=REJECTED_COLUMNS)
                rejected_writer.writeheader()
                statistics, warnings, mappings, rejected_count = self._extract(
                    source,
                    long_writer,
                    rejected_writer,
                    source_asset=source_asset,
                    build_id=build_id,
                    binding_id=binding_id,
                    source_name=source_name,
                    parameters=parameters,
                )
                supporting_paths, supporting_warnings = self._write_supporting_assets(
                    source_path=source_path,
                    metadata_path=metadata_path,
                    output_dir=output_dir,
                    binding_id=binding_id,
                    parameters=parameters,
                    statistics=statistics,
                )
                warnings.extend(supporting_warnings)
        except Exception:
            output_path.unlink(missing_ok=True)
            rejected_path.unlink(missing_ok=True)
            for supporting_path in supporting_paths:
                supporting_path.unlink(missing_ok=True)
            raise
        checksum = sha256_file(output_path)
        file_asset = FileAsset(
            asset_id=asset_id_from_sha256(checksum),
            kind="parsed",
            relative_path=output_path.relative_to(output_dir).as_posix(),
            sha256=checksum,
            size_bytes=output_path.stat().st_size,
            media_type="text/csv",
            generated_by_step_id=f"step_{self.adapter_id}",
        )
        statistics["row_count"] = int(statistics.get("row_count", 0))
        statistics["rejected_count"] = rejected_count
        supporting_assets = [
            _file_asset(
                path,
                output_dir=output_dir,
                kind="artifact",
                generated_by_step_id=f"step_{self.adapter_id}",
            )
            for path in supporting_paths
        ]
        return DataBatch(
            batch_id=f"batch_{binding_id}",
            binding_id=binding_id,
            dataset_family="gene_expression",
            row_granularity=_row_granularity_for(schema_ref),
            schema_ref=schema_ref,
            file_asset=file_asset,
            supporting_assets=supporting_assets,
            row_count=int(statistics["row_count"]),
            column_count=len(SOURCE_LONG_COLUMNS),
            parser_id=self.adapter_id,
            parser_version=self.version,
            statistics=statistics,
            warnings=warnings,
            declared_mappings=mappings,
        )

    def _write_supporting_assets(
        self,
        *,
        source_path: Path,
        metadata_path: Path | None,
        output_dir: Path,
        binding_id: str,
        parameters: AdapterParams | None,
        statistics: dict[str, JsonValue],
    ) -> tuple[list[Path], list[str]]:
        """Optional deterministic side tables emitted after a valid parse."""

        return [], []

    @abstractmethod
    def _extract(
        self,
        source_handle: TextIO,
        long_writer: csv.DictWriter[str],
        rejected_writer: csv.DictWriter[str],
        *,
        source_asset: SourceAsset,
        build_id: str,
        binding_id: str,
        source_name: str,
        parameters: AdapterParams | None = None,
    ) -> tuple[dict[str, JsonValue], list[str], list[FieldMapping], int]:
        """Stream validated source-long rows; return (statistics, warnings, mappings, rejected)."""

def _rejected(
    *,
    batch_id: str,
    gene_id_raw: str,
    sample_id: str,
    reason_code: str,
    reason: str,
    source_name: str,
    line: int,
    raw_value: str,
) -> dict[str, str]:
    return {
        "rejected_id": f"rej_{batch_id}_{line}",
        "batch_id": batch_id,
        "gene_id_raw": gene_id_raw,
        "sample_id": sample_id,
        "reason_code": reason_code,
        "reason": reason,
        "source_logical_file": source_name,
        "source_line_number": str(line),
        "source_raw_value": raw_value,
    }


def _long_row(
    *,
    build_id: str,
    source_asset: SourceAsset,
    gene_id_raw: str,
    sample_id: str,
    measurement_type: str,
    value_semantics: str,
    value_scale: str,
    is_normalized: bool,
    is_integer_expected: bool,
    expression_value: str,
    expression_unit: str,
    source_name: str,
    line: int,
    column: int,
    column_name: str,
) -> dict[str, str]:
    return {
        "record_id": make_record_id(build_id, gene_id_raw, sample_id),
        "dataset_id": build_id,
        "source_id": source_asset.source_id,
        "asset_id": source_asset.asset_id,
        "gene_id_raw": gene_id_raw,
        "sample_id": sample_id,
        "measurement_type": measurement_type,
        "value_semantics": value_semantics,
        "value_scale": value_scale,
        "is_normalized": str(is_normalized).lower(),
        "is_integer_expected": str(is_integer_expected).lower(),
        "expression_value": expression_value,
        "expression_unit": expression_unit,
        "source_logical_file": source_name,
        "source_line_number": str(line),
        "source_column_index": str(column),
        "source_column_name": column_name,
        "source_raw_value": expression_value,
    }


class GdcExpressionAdapter(SourceAdapter):
    """Parses GDC gene-expression TSV files (matrix or STAR-counts layout)."""

    adapter_id = "gdc.expression.v1"
    version = "1.0.0"
    source_database = "gdc"

    def _extract(
        self,
        source_handle: TextIO,
        long_writer: csv.DictWriter[str],
        rejected_writer: csv.DictWriter[str],
        *,
        source_asset: SourceAsset,
        build_id: str,
        binding_id: str,
        source_name: str,
        parameters: AdapterParams | None = None,
    ) -> tuple[dict[str, JsonValue], list[str], list[FieldMapping], int]:
        rows = enumerate(csv.reader(source_handle, delimiter="\t"), start=1)
        header_line, header = _next_header(rows)
        if "gene_name" in header and (
            "tpm_unstranded" in header or "unstranded" in header
        ):
            return self._extract_star_counts(
                rows, long_writer, rejected_writer,
                header_line=header_line, header=header,
                source_asset=source_asset, build_id=build_id,
                binding_id=binding_id, source_name=source_name,
            )
        return self._extract_matrix(
            rows, long_writer, rejected_writer,
            header_line=header_line, header=header,
            source_asset=source_asset, build_id=build_id,
            binding_id=binding_id, source_name=source_name,
        )

    def _extract_matrix(
        self,
        rows: enumerate[list[str]],
        long_writer: csv.DictWriter[str],
        rejected_writer: csv.DictWriter[str],
        *,
        header_line: int,
        header: list[str],
        source_asset: SourceAsset,
        build_id: str,
        binding_id: str,
        source_name: str,
    ) -> tuple[dict[str, JsonValue], list[str], list[FieldMapping], int]:
        samples = [c for c in header[1:] if c not in _GDC_ANNOTATION_COLUMNS]
        if not samples or len(set(samples)) != len(samples) or any(not s for s in samples):
            raise AdapterError("GDC expression sample columns must be non-empty and unique")
        mappings = _wide_matrix_mappings(
            binding_id=binding_id,
            samples=samples,
            gene_evidence="GDC files API: gene_id column header",
            sample_evidence="matrix sample column header",
        )
        source_row_count = row_count = rejected_count = 0
        batch_id = f"batch_{binding_id}"
        for line, values in rows:
            if line <= header_line or len(values) != len(header) or not values[0]:
                raise AdapterError(f"invalid GDC expression row at line {line}")
            source_row_count += 1
            emitted, rejected = _emit_matrix_cells(
                long_writer, rejected_writer,
                batch_id=batch_id,
                source_asset=source_asset,
                build_id=build_id,
                source_name=source_name,
                line=line,
                values=values,
                header=header,
                samples=samples,
            )
            row_count += emitted
            rejected_count += rejected
        if source_row_count == 0:
            raise EmptySourceError("GDC expression TSV contains no data rows")
        statistics: dict[str, JsonValue] = {
            "source_database": self.source_database,
            "dataset_type": "gene_expression",
            "format": "expression_matrix",
            "sample_count": len(samples),
            "source_row_count": source_row_count,
            "row_count": row_count,
        }
        return statistics, [], mappings, rejected_count

    def _extract_star_counts(
        self,
        rows: enumerate[list[str]],
        long_writer: csv.DictWriter[str],
        rejected_writer: csv.DictWriter[str],
        *,
        header_line: int,
        header: list[str],
        source_asset: SourceAsset,
        build_id: str,
        binding_id: str,
        source_name: str,
    ) -> tuple[dict[str, JsonValue], list[str], list[FieldMapping], int]:
        if len(set(header)) != len(header):
            raise AdapterError("GDC STAR-counts columns must be unique")
        metric = "tpm_unstranded" if "tpm_unstranded" in header else "unstranded"
        metric_column = header.index(metric)
        sample_id = source_name.split(".", 1)[0]
        mappings = [
            _mapping(
                mapping_id="gene_id_to_raw",
                binding_id=binding_id,
                source_field="gene_id",
                target_field="gene_id_raw",
                transform="identity",
                evidence="GDC STAR-counts gene_id column",
            ),
            _mapping(
                mapping_id="metric_to_value",
                binding_id=binding_id,
                source_field=metric,
                target_field="expression_value",
                transform="column_value",
                evidence="GDC STAR-counts metric column",
            ),
            _mapping(
                mapping_id="filename_to_sample",
                binding_id=binding_id,
                source_field="filename",
                target_field="sample_id",
                transform="filename_sample",
                evidence="GDC STAR-counts file naming (one sample per file)",
            ),
        ]
        is_tpm = metric == "tpm_unstranded"
        semantics = "normalized_expression" if is_tpm else "raw_count"
        source_row_count = row_count = rejected_count = 0
        batch_id = f"batch_{binding_id}"
        for line, values in rows:
            if not values or not any(values):
                continue
            if len(values) != len(header):
                raise AdapterError(f"invalid GDC STAR-counts row at line {line}")
            gene_id_raw = values[0]
            if not gene_id_raw.startswith("ENSG"):
                rejected_writer.writerow(
                    _rejected(
                        batch_id=batch_id,
                        gene_id_raw=gene_id_raw,
                        sample_id=sample_id,
                        reason_code="non_ensg_annotation_row",
                        reason=(
                            "STAR-counts rows outside the ENSG namespace are "
                            "annotation rows, not genes"
                        ),
                        source_name=source_name,
                        line=line,
                        raw_value=gene_id_raw,
                    )
                )
                rejected_count += 1
                continue
            raw = values[metric_column]
            if not _is_finite_number(raw):
                rejected_writer.writerow(
                    _rejected(
                        batch_id=batch_id,
                        gene_id_raw=gene_id_raw,
                        sample_id=sample_id,
                        reason_code="non_finite_value",
                        reason=f"value={raw!r} is not a finite number",
                        source_name=source_name,
                        line=line,
                        raw_value=raw,
                    )
                )
                rejected_count += 1
                continue
            long_writer.writerow(
                _long_row(
                    build_id=build_id,
                    source_asset=source_asset,
                    gene_id_raw=gene_id_raw,
                    sample_id=sample_id,
                    measurement_type="gene_expression",
                    value_semantics=semantics,
                    value_scale="linear",
                    is_normalized=is_tpm,
                    is_integer_expected=not is_tpm,
                    expression_value=raw,
                    expression_unit=metric,
                    source_name=source_name,
                    line=line,
                    column=metric_column,
                    column_name=metric,
                )
            )
            source_row_count += 1
            row_count += 1
        if source_row_count == 0:
            raise EmptySourceError("GDC STAR-counts TSV contains no data rows")
        statistics: dict[str, JsonValue] = {
            "source_database": self.source_database,
            "dataset_type": "gene_expression",
            "format": "star_counts",
            "sample_count": 1,
            "source_row_count": source_row_count,
            "row_count": row_count,
        }
        return statistics, [], mappings, rejected_count


class XenaMatrixAdapter(SourceAdapter):
    """Parses UCSC Xena gene-expression matrices."""

    adapter_id = "xena.matrix.v1"
    version = "1.0.0"
    source_database = "ucsc_xena"

    def _extract(
        self,
        source_handle: TextIO,
        long_writer: csv.DictWriter[str],
        rejected_writer: csv.DictWriter[str],
        *,
        source_asset: SourceAsset,
        build_id: str,
        binding_id: str,
        source_name: str,
        parameters: AdapterParams | None = None,
    ) -> tuple[dict[str, JsonValue], list[str], list[FieldMapping], int]:
        rows = enumerate(csv.reader(source_handle, delimiter="\t"), start=1)
        header_line, header = _next_header(rows)
        samples = header[1:]
        if not samples or any(not s for s in samples):
            raise AdapterError("Xena matrix sample headers must not be blank")
        if len(set(samples)) != len(samples):
            raise AdapterError("Xena matrix sample headers must be unique")
        mappings = _wide_matrix_mappings(
            binding_id=binding_id,
            samples=samples,
            gene_evidence="Xena matrix gene_id column header",
            sample_evidence="matrix sample column header",
        )
        source_row_count = row_count = rejected_count = 0
        batch_id = f"batch_{binding_id}"
        for line, values in rows:
            if not values or all(not v for v in values):
                continue
            if len(values) != len(header):
                raise AdapterError(
                    f"source line {line} has an unexpected field count"
                )
            gene_id_raw = values[0]
            if not gene_id_raw:
                raise AdapterError("Xena matrix gene_id must not be blank")
            source_row_count += 1
            emitted, rejected = _emit_matrix_cells(
                long_writer, rejected_writer,
                batch_id=batch_id,
                source_asset=source_asset,
                build_id=build_id,
                source_name=source_name,
                line=line,
                values=values,
                header=header,
                samples=samples,
            )
            row_count += emitted
            rejected_count += rejected
        if source_row_count == 0:
            raise EmptySourceError("Xena matrix contains no data rows")
        statistics: dict[str, JsonValue] = {
            "source_database": self.source_database,
            "dataset_type": "gene_expression",
            "format": "expression_matrix",
            "sample_count": len(samples),
            "source_row_count": source_row_count,
            "row_count": row_count,
        }
        return statistics, [], mappings, rejected_count


def _next_header(rows: enumerate[list[str]]) -> tuple[int, list[str]]:
    for line_number, values in rows:
        if not values or not any(values):
            continue
        if values[0].startswith("#"):
            continue
        if len(values) < 2 or values[0].lower() not in {
            "gene_id",
            "gene",
            "gene_id_raw",
        }:
            raise AdapterError(
                f"expression table must start with gene_id and value columns (line {line_number})"
            )
        return line_number, values
    raise AdapterError("expression table contains no header")


#: GeoExpressionAdapter lives in a sibling module that imports the shared
#: adapter helpers above; the import is placed after those definitions so the
#: module graph stays acyclic (Phase 5 T2).
from app.datasets.build.geo_adapter import GeoExpressionAdapter  # noqa: E402

ADAPTER_REGISTRY: dict[str, SourceAdapter] = {
    GdcExpressionAdapter.adapter_id: GdcExpressionAdapter(),
    XenaMatrixAdapter.adapter_id: XenaMatrixAdapter(),
    GeoExpressionAdapter.adapter_id: GeoExpressionAdapter(),
}


def get_adapter(adapter_id: str) -> SourceAdapter:
    try:
        return ADAPTER_REGISTRY[adapter_id]
    except KeyError as exc:
        raise AdapterError(f"unknown source adapter: {adapter_id}") from exc
