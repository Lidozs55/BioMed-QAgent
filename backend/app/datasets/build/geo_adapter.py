"""GeoExpressionAdapter: GEO expression formats -> source-long DataBatch.

Phase 5 T2: the ``geo.expression.v1`` adapter parses three explicit GEO
expression formats selected through typed ``AdapterParams`` (tximport_counts
/ series_matrix / supplementary_matrix).  The value scale, semantics, unit
and normalization flag come ONLY from the parameters — never inferred from a
file name.  It declares the per-row namespace
(``gene_id_namespace_declared``) and the batch-level
``source_gene_id_namespace`` statistic: tximport rows are ``ensembl_gene``;
series/supplementary ID_REF rows are ``ensembl_gene`` only when they match
the ENSG shape, otherwise ``geo_probe``.  The adapter does NOT map
probes to genes — that is the canonicalizer/mapping layer's job.

Fail-closed contract (mirrors the shared adapter policy): structural
malformation (missing table block, bad header, column-width mismatch,
duplicate/blank sample headers) is fatal; a value cell that is not a finite
number is rejected row-level into the audit file; zero valid expression rows
raise a typed ``EmptySourceError``.
"""

from __future__ import annotations

import csv
import re
from pathlib import Path
from typing import TextIO

from app.datasets.build.adapters import (
    SourceAdapter,
    _is_finite_number,
    _long_row,
    _rejected,
    _wide_matrix_mappings,
)
from app.datasets.build.errors import AdapterError, EmptySourceError
from app.datasets.build.geo_sample_metadata import (
    parse_geo_series_matrix_samples,
    parse_geo_soft_samples,
    write_sample_metadata,
)
from app.datasets.contracts import AdapterParams, FieldMapping, JsonValue
from app.domain.contracts import SourceAsset
from app.tools.io import open_text

#: Ensembl gene IDs (tximport output, or ENSG-shaped series/supplementary
#: ID_REF values).  Version suffixes are tolerated exactly like the
#: canonicalizer's ENSG pattern.
_ENSEMBL_PATTERN = re.compile(r"^ENSG\d{11}(?:\.\d+)?$")

#: Informational measurement-type labels mirror the V1 GEO parsers.
_MEASUREMENT_TYPE_BY_FORMAT = {
    "tximport_counts": "tximport_estimated_count",
    "series_matrix": "series_matrix_expression",
    "supplementary_matrix": "supplementary_expression",
}


def _declared_namespace(gene_id_raw: str) -> str:
    """Declare the per-row namespace (Phase 5 D1).

    Only an ENSG-shaped ID_REF is a gene; everything else in a
    series/supplementary matrix is a probe (``geo_probe``).  tximport rows
    are always ``ensembl_gene`` (tximport is a gene-level quantifier).
    """
    return "ensembl_gene" if _ENSEMBL_PATTERN.fullmatch(gene_id_raw) else "geo_probe"


def _namespace_summary(declared: set[str]) -> str:
    """Summarize the batch's declared namespaces for statistics."""
    if len(declared) == 1:
        return next(iter(declared))
    return "mixed_" + "_".join(sorted(declared))


def _sniff_delimiter(line: str) -> str:
    """Auto-detect CSV vs TSV only (Phase 5 D1: never infers scale/semantics)."""
    return "\t" if "\t" in line else ","


def _split_line(line: str, delimiter: str) -> list[str]:
    return next(csv.reader([line], delimiter=delimiter, quotechar='"'))


class GeoExpressionAdapter(SourceAdapter):
    """Parses GEO expression files selected by typed AdapterParams."""

    adapter_id = "geo.expression.v1"
    version = "1.1.0"
    source_database = "geo"

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
        if parameters is None:
            return [], []
        if metadata_path is not None:
            with open_text(metadata_path, encoding="utf-8", newline="") as source:
                samples, warnings = parse_geo_soft_samples(source)
        elif parameters.format == "series_matrix":
            with open_text(source_path, encoding="utf-8", newline="") as source:
                samples, warnings = parse_geo_series_matrix_samples(source)
        else:
            return [], []
        if not samples:
            if metadata_path is not None:
                raise AdapterError("GEO metadata contains no SAMPLE records")
            return [], warnings
        expected_samples = {
            str(sample_id) for sample_id in statistics.get("sample_ids", [])
        }
        observed_samples = {
            sample.source_sample_alias or sample.sample_id for sample in samples
        }
        if observed_samples != expected_samples:
            raise AdapterError(
                "GEO metadata sample IDs do not match expression sample IDs: "
                f"metadata={sorted(observed_samples)}, "
                f"expression={sorted(expected_samples)}"
            )
        path = output_dir / "supporting" / f"{binding_id}_sample_metadata.csv"
        try:
            write_sample_metadata(path, samples)
        except Exception:
            path.unlink(missing_ok=True)
            raise
        return [path], warnings

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
        if parameters is None:
            raise AdapterError(
                "geo.expression.v1 requires AdapterParams "
                "(format/value_semantics/value_scale/expression_unit)"
            )
        try:
            extractor = {
                "tximport_counts": self._extract_tximport,
                "series_matrix": self._extract_series_matrix,
                "supplementary_matrix": self._extract_supplementary,
            }[parameters.format]
            return extractor(
                source_handle,
                long_writer,
                rejected_writer,
                source_asset=source_asset,
                build_id=build_id,
                binding_id=binding_id,
                source_name=source_name,
                parameters=parameters,
            )
        except (OSError, EOFError, UnicodeDecodeError) as exc:
            # A truncated gzip stream (or otherwise unreadable input) fails
            # closed as an AdapterError; the base parse removes any partial
            # batch files so the chain never consumes a truncated batch.
            raise AdapterError(
                f"could not read {source_name!r}: truncated or unreadable "
                f"input: {exc}"
            ) from exc

    # ------------------------------------------------------------ shared

    def _emit_geo_cells(
        self,
        long_writer: csv.DictWriter[str],
        rejected_writer: csv.DictWriter[str],
        *,
        batch_id: str,
        source_asset: SourceAsset,
        build_id: str,
        source_name: str,
        line: int,
        values: list[str],
        samples: list[str],
        sample_columns: dict[str, int],
        parameters: AdapterParams,
        measurement_type: str,
        declared_namespace: str,
    ) -> tuple[int, int]:
        """Emit long rows for one wide-matrix row; returns (emitted, rejected)."""
        emitted = rejected = 0
        gene_id_raw = values[0]
        for sample_id in samples:
            column = sample_columns[sample_id]
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
            row = _long_row(
                build_id=build_id,
                source_asset=source_asset,
                gene_id_raw=gene_id_raw,
                sample_id=sample_id,
                measurement_type=measurement_type,
                value_semantics=parameters.value_semantics,
                value_scale=parameters.value_scale.value,
                is_normalized=parameters.is_normalized,
                is_integer_expected=not parameters.is_normalized,
                expression_value=raw,
                expression_unit=parameters.expression_unit,
                source_name=source_name,
                line=line,
                column=column,
                column_name=sample_id,
            )
            row["gene_id_namespace_declared"] = declared_namespace
            long_writer.writerow(row)
            emitted += 1
        return emitted, rejected

    def _statistics(
        self,
        *,
        parameters: AdapterParams,
        sample_count: int,
        source_row_count: int,
        row_count: int,
        declared: set[str],
        sample_ids: list[str],
    ) -> dict[str, JsonValue]:
        return {
            "source_database": self.source_database,
            "dataset_type": "gene_expression",
            "format": parameters.format,
            "sample_count": sample_count,
            "sample_ids": sample_ids,
            "source_row_count": source_row_count,
            "row_count": row_count,
            "source_gene_id_namespace": _namespace_summary(declared),
            "value_semantics": parameters.value_semantics,
            "value_scale": parameters.value_scale.value,
            "expression_unit": parameters.expression_unit,
            "is_normalized": parameters.is_normalized,
            "platform_ids": list(parameters.platform_ids),
        }

    # ---------------------------------------------------------- tximport

    def _extract_tximport(
        self,
        source_handle: TextIO,
        long_writer: csv.DictWriter[str],
        rejected_writer: csv.DictWriter[str],
        *,
        source_asset: SourceAsset,
        build_id: str,
        binding_id: str,
        source_name: str,
        parameters: AdapterParams,
    ) -> tuple[dict[str, JsonValue], list[str], list[FieldMapping], int]:
        rows = enumerate(
            csv.reader(source_handle, delimiter="\t", quotechar='"'), start=1
        )
        header: list[str] | None = None
        for _, values in rows:
            if not values or not any(values):
                continue
            header = values
            break
        if header is None:
            raise EmptySourceError("tximport counts file contains no header")
        count_fields = [
            (index, name, name.split(".", 1)[1])
            for index, name in enumerate(header)
            if name.startswith("counts.")
        ]
        if not count_fields:
            raise AdapterError(
                "tximport counts file must contain counts.<sample> columns"
            )
        samples = [alias for _, _, alias in count_fields]
        if any(not sample for sample in samples) or len(set(samples)) != len(
            samples
        ):
            raise AdapterError(
                "tximport counts sample aliases must be non-blank and unique"
            )
        mappings = _wide_matrix_mappings(
            binding_id=binding_id,
            samples=samples,
            gene_evidence="tximport counts gene column (first data column)",
            sample_evidence="tximport counts.<sample> column header",
        )
        # tximport data rows carry the gene id in column 0, so a counts column
        # at header index ``i`` lives at physical index ``i + 1``.
        sample_columns = {
            alias: index + 1 for index, _, alias in count_fields
        }
        source_row_count = row_count = rejected_count = 0
        batch_id = f"batch_{binding_id}"
        declared: set[str] = set()
        for line, values in rows:
            if len(values) != len(header) + 1:
                raise AdapterError(
                    f"source line {line} has an unexpected field count"
                )
            gene_id_raw = values[0]
            if not gene_id_raw:
                raise AdapterError(
                    f"tximport gene id must not be blank (line {line})"
                )
            source_row_count += 1
            declared.add("ensembl_gene")
            emitted, rejected = self._emit_geo_cells(
                long_writer,
                rejected_writer,
                batch_id=batch_id,
                source_asset=source_asset,
                build_id=build_id,
                source_name=source_name,
                line=line,
                values=values,
                samples=samples,
                sample_columns=sample_columns,
                parameters=parameters,
                measurement_type=_MEASUREMENT_TYPE_BY_FORMAT["tximport_counts"],
                declared_namespace="ensembl_gene",
            )
            row_count += emitted
            rejected_count += rejected
        if source_row_count == 0:
            raise EmptySourceError("tximport counts file contains no data rows")
        statistics = self._statistics(
            parameters=parameters,
            sample_count=len(samples),
            source_row_count=source_row_count,
            row_count=row_count,
            declared=declared,
            sample_ids=samples,
        )
        return statistics, [], mappings, rejected_count

    # ------------------------------------------------------- series matrix

    def _extract_series_matrix(
        self,
        source_handle: TextIO,
        long_writer: csv.DictWriter[str],
        rejected_writer: csv.DictWriter[str],
        *,
        source_asset: SourceAsset,
        build_id: str,
        binding_id: str,
        source_name: str,
        parameters: AdapterParams,
    ) -> tuple[dict[str, JsonValue], list[str], list[FieldMapping], int]:
        reader = csv.reader(source_handle, delimiter="\t", quotechar='"')
        in_block = False
        header: list[str] | None = None
        samples: list[str] = []
        sample_columns: dict[str, int] = {}
        source_row_count = row_count = rejected_count = 0
        batch_id = f"batch_{binding_id}"
        declared: set[str] = set()
        sample_platforms: list[str] = []
        for line, values in enumerate(reader, start=1):
            if not in_block:
                if values and values[0].startswith("!Sample_platform_id"):
                    sample_platforms = [value.strip() for value in values[1:]]
                if values and values[0].startswith("!series_matrix_table_begin"):
                    in_block = True
                continue
            if values and values[0].startswith("!series_matrix_table_end"):
                break
            if header is None:
                if not values or not any(values):
                    continue
                header = values
                samples = [cell for cell in header[1:]]
                if not header[0]:
                    raise AdapterError(
                        "series matrix probe column header must be non-blank"
                    )
                if not samples or any(not sample for sample in samples):
                    raise AdapterError(
                        "series matrix sample columns must be non-blank"
                    )
                if len(set(samples)) != len(samples):
                    raise AdapterError(
                        "series matrix sample columns must be unique"
                    )
                sample_columns = {sample: i + 1 for i, sample in enumerate(samples)}
                continue
            if not values or all(not v for v in values):
                continue
            if len(values) != len(header):
                raise AdapterError(
                    f"source line {line} has an unexpected field count"
                )
            gene_id_raw = values[0]
            if not gene_id_raw:
                raise AdapterError(
                    f"series matrix probe id must not be blank (line {line})"
                )
            source_row_count += 1
            declared_namespace = _declared_namespace(gene_id_raw)
            declared.add(declared_namespace)
            emitted, rejected = self._emit_geo_cells(
                long_writer,
                rejected_writer,
                batch_id=batch_id,
                source_asset=source_asset,
                build_id=build_id,
                source_name=source_name,
                line=line,
                values=values,
                samples=samples,
                sample_columns=sample_columns,
                parameters=parameters,
                measurement_type=_MEASUREMENT_TYPE_BY_FORMAT["series_matrix"],
                declared_namespace=declared_namespace,
            )
            row_count += emitted
            rejected_count += rejected
        if not in_block:
            raise AdapterError(
                "series matrix file has no !series_matrix_table_begin block"
            )
        if header is None:
            raise EmptySourceError(
                "series matrix expression block is empty (header-only)"
            )
        if source_row_count == 0:
            raise EmptySourceError("series matrix contains no data rows")
        if row_count == 0:
            raise EmptySourceError(
                "series matrix contains no valid expression rows"
            )
        mappings = _wide_matrix_mappings(
            binding_id=binding_id,
            samples=samples,
            gene_evidence="GEO series matrix ID_REF column header",
            sample_evidence="series matrix sample column header",
        )
        statistics = self._statistics(
            parameters=parameters,
            sample_count=len(samples),
            source_row_count=source_row_count,
            row_count=row_count,
            declared=declared,
            sample_ids=samples,
        )
        if sample_platforms and (
            len(sample_platforms) != len(samples) or not all(sample_platforms)
        ):
            raise AdapterError(
                "series matrix sample platform metadata must cover every sample"
            )
        if sample_platforms:
            evidenced_platforms = sorted(set(sample_platforms))
            declared_platforms = sorted(set(parameters.platform_ids))
            if declared_platforms and declared_platforms != evidenced_platforms:
                raise AdapterError(
                    "declared platform_ids do not match !Sample_platform_id "
                    f"evidence: declared={declared_platforms}, "
                    f"evidenced={evidenced_platforms}"
                )
            statistics["platform_ids"] = evidenced_platforms
            statistics["sample_platform_ids"] = {
                sample_id: platform_id
                for sample_id, platform_id in zip(
                    samples, sample_platforms, strict=True
                )
            }
        return statistics, [], mappings, rejected_count

    # ------------------------------------------------- supplementary matrix

    def _extract_supplementary(
        self,
        source_handle: TextIO,
        long_writer: csv.DictWriter[str],
        rejected_writer: csv.DictWriter[str],
        *,
        source_asset: SourceAsset,
        build_id: str,
        binding_id: str,
        source_name: str,
        parameters: AdapterParams,
    ) -> tuple[dict[str, JsonValue], list[str], list[FieldMapping], int]:
        delimiter = parameters.delimiter
        header: list[str] | None = None
        samples: list[str] = []
        sample_columns: dict[str, int] = {}
        source_row_count = row_count = rejected_count = 0
        batch_id = f"batch_{binding_id}"
        declared: set[str] = set()
        for line, raw_line in enumerate(source_handle, start=1):
            text = raw_line.rstrip("\r\n")
            if not text.strip():
                continue
            if header is None and delimiter == "auto":
                delimiter = _sniff_delimiter(text)
            values = _split_line(text, delimiter)
            if header is None:
                header = values
                samples = [cell for cell in header[1:]]
                if not header[0]:
                    raise AdapterError(
                        "supplementary probe column header must be non-blank"
                    )
                if not samples or any(not sample for sample in samples):
                    raise AdapterError(
                        "supplementary sample columns must be non-blank"
                    )
                if len(set(samples)) != len(samples):
                    raise AdapterError(
                        "supplementary sample columns must be unique"
                    )
                sample_columns = {sample: i + 1 for i, sample in enumerate(samples)}
                continue
            if len(values) != len(header):
                raise AdapterError(
                    f"source line {line} has an unexpected field count"
                )
            gene_id_raw = values[0]
            if not gene_id_raw:
                raise AdapterError(
                    f"supplementary probe id must not be blank (line {line})"
                )
            source_row_count += 1
            declared_namespace = _declared_namespace(gene_id_raw)
            declared.add(declared_namespace)
            emitted, rejected = self._emit_geo_cells(
                long_writer,
                rejected_writer,
                batch_id=batch_id,
                source_asset=source_asset,
                build_id=build_id,
                source_name=source_name,
                line=line,
                values=values,
                samples=samples,
                sample_columns=sample_columns,
                parameters=parameters,
                measurement_type=_MEASUREMENT_TYPE_BY_FORMAT[
                    "supplementary_matrix"
                ],
                declared_namespace=declared_namespace,
            )
            row_count += emitted
            rejected_count += rejected
        if header is None:
            raise EmptySourceError("supplementary matrix file contains no header")
        if source_row_count == 0:
            raise EmptySourceError("supplementary matrix contains no data rows")
        if row_count == 0:
            raise EmptySourceError(
                "supplementary matrix contains no valid expression rows"
            )
        mappings = _wide_matrix_mappings(
            binding_id=binding_id,
            samples=samples,
            gene_evidence="supplementary expression matrix first column header",
            sample_evidence="supplementary matrix sample column header",
        )
        statistics = self._statistics(
            parameters=parameters,
            sample_count=len(samples),
            source_row_count=source_row_count,
            row_count=row_count,
            declared=declared,
            sample_ids=samples,
        )
        return statistics, [], mappings, rejected_count
