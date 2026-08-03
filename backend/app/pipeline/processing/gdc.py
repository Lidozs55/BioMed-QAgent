"""Strict first-pass parsers for small GDC TSV fixtures and downloads."""

from __future__ import annotations

import csv
import gzip
import hashlib
from collections.abc import Iterator
from pathlib import Path
from typing import TextIO

from app.domain.contracts import (
    FileAsset,
    ParsedDataset,
    SourceAsset,
    asset_id_from_sha256,
    make_record_id,
)
from app.pipeline.processing.xena_matrix import _OUTPUT_COLUMNS
from app.tools.workdir import TaskWorkDir


def _open_table(path: Path) -> TextIO:
    if path.suffix.lower() == ".gz":
        return gzip.open(path, "rt", encoding="utf-8", newline="")
    return path.open("r", encoding="utf-8", newline="")


def parse_gdc_table(
    source_asset: SourceAsset,
    dataset_id: str,
    workdir: TaskWorkDir,
    data_type: str,
) -> ParsedDataset:
    source_path = workdir.root / source_asset.relative_path
    if not source_path.is_file():
        raise FileNotFoundError(source_path)
    if hashlib.sha256(source_path.read_bytes()).hexdigest() != source_asset.sha256:
        raise ValueError("source asset checksum mismatch before processing")
    normalized = data_type.strip().lower().replace("_", "-")
    source_name = source_path.name
    if normalized in {"gene-expression", "gene expression", "expression"}:
        return _parse_expression(source_asset, dataset_id, workdir, source_path, source_name)
    if normalized == "clinical":
        return _parse_clinical(source_asset, dataset_id, workdir, source_path, source_name)
    raise ValueError(f"unsupported GDC data type: {data_type}")


def _parse_expression(
    source_asset: SourceAsset,
    dataset_id: str,
    workdir: TaskWorkDir,
    source_path: Path,
    source_name: str,
) -> ParsedDataset:
    output_path = workdir.parsed / f"{dataset_id}_gdc_gene_expression_long.csv"
    try:
        with (
            _open_table(source_path) as handle,
            output_path.open("w", encoding="utf-8-sig", newline="") as target,
        ):
            numbered_rows = enumerate(csv.reader(handle, delimiter="\t"), start=1)
            header_line, header = _next_expression_header(numbered_rows)
            writer = csv.DictWriter(target, fieldnames=_OUTPUT_COLUMNS)
            writer.writeheader()
            if "gene_name" in header and (
                "tpm_unstranded" in header or "unstranded" in header
            ):
                source_row_count, row_count = _write_star_counts(
                    numbered_rows,
                    header,
                    writer,
                    source_asset,
                    dataset_id,
                    source_name,
                )
            else:
                source_row_count, row_count = _write_expression_matrix(
                    numbered_rows,
                    header_line,
                    header,
                    writer,
                    source_asset,
                    dataset_id,
                    source_name,
                )
    except Exception:
        output_path.unlink(missing_ok=True)
        raise
    if source_row_count == 0:
        output_path.unlink(missing_ok=True)
        raise ValueError("GDC expression TSV contains no data rows")
    return _parsed(
        output_path,
        source_asset,
        dataset_id,
        "gdc_gene_expression",
        source_row_count,
        row_count,
        "gene_expression",
    )


def _next_expression_header(
    rows: Iterator[tuple[int, list[str]]],
) -> tuple[int, list[str]]:
    for line_number, values in rows:
        if not values or not any(values):
            continue
        if values[0].startswith("#"):
            continue
        if (
            len(values) < 2
            or values[0].lower() not in {"gene_id", "gene", "gene_id_raw"}
        ):
            raise ValueError("GDC expression TSV must start with gene_id and value columns")
        return line_number, values
    raise ValueError("GDC expression TSV contains no header")


def _write_expression_matrix(
    rows: Iterator[tuple[int, list[str]]],
    header_line: int,
    header: list[str],
    writer: csv.DictWriter[str],
    source_asset: SourceAsset,
    dataset_id: str,
    source_name: str,
) -> tuple[int, int]:
    samples = header[1:]
    if not samples or len(set(samples)) != len(samples) or any(not item for item in samples):
        raise ValueError("GDC expression sample columns must be non-empty and unique")
    source_row_count = row_count = 0
    for line, values in rows:
        if line <= header_line or len(values) != len(header) or not values[0]:
            raise ValueError(f"invalid GDC expression row at line {line}")
        source_row_count += 1
        for column, sample_id in enumerate(samples, start=1):
            raw = values[column]
            try:
                float(raw)
            except ValueError as exc:
                raise ValueError(f"non-numeric GDC expression value at line {line}") from exc
            writer.writerow(
                _expression_row(
                    source_asset=source_asset,
                    dataset_id=dataset_id,
                    source_name=source_name,
                    gene_id_raw=values[0],
                    gene_id=values[0],
                    gene_id_namespace="gdc_gene",
                    sample_id=sample_id,
                    raw=raw,
                    semantics="expression_value",
                    normalized=False,
                    unit="expression_value",
                    line=line,
                    column=column,
                    column_name=sample_id,
                )
            )
            row_count += 1
    return source_row_count, row_count


def _write_star_counts(
    rows: Iterator[tuple[int, list[str]]],
    header: list[str],
    writer: csv.DictWriter[str],
    source_asset: SourceAsset,
    dataset_id: str,
    source_name: str,
) -> tuple[int, int]:
    if len(set(header)) != len(header):
        raise ValueError("GDC STAR-counts columns must be unique")
    metric = "tpm_unstranded" if "tpm_unstranded" in header else "unstranded"
    metric_column = header.index(metric)
    sample_id = source_name.split(".", 1)[0]
    source_row_count = row_count = 0
    for line, values in rows:
        if not values or not any(values):
            continue
        if len(values) != len(header):
            raise ValueError(f"invalid GDC STAR-counts row at line {line}")
        gene_id_raw = values[0]
        if not gene_id_raw.startswith("ENSG"):
            continue
        raw = values[metric_column]
        try:
            float(raw)
        except ValueError as exc:
            raise ValueError(f"non-numeric GDC {metric} value at line {line}") from exc
        gene_id, separator, version = gene_id_raw.rpartition(".")
        if not separator or not version.isdigit():
            gene_id = gene_id_raw
        writer.writerow(
            _expression_row(
                source_asset=source_asset,
                dataset_id=dataset_id,
                source_name=source_name,
                gene_id_raw=gene_id_raw,
                gene_id=gene_id,
                gene_id_namespace="ensembl_gene",
                sample_id=sample_id,
                raw=raw,
                semantics=(
                    "normalized_expression" if metric == "tpm_unstranded" else "raw_count"
                ),
                normalized=metric == "tpm_unstranded",
                unit=metric,
                line=line,
                column=metric_column,
                column_name=metric,
            )
        )
        source_row_count += 1
        row_count += 1
    return source_row_count, row_count


def _expression_row(
    *,
    source_asset: SourceAsset,
    dataset_id: str,
    source_name: str,
    gene_id_raw: str,
    gene_id: str,
    gene_id_namespace: str,
    sample_id: str,
    raw: str,
    semantics: str,
    normalized: bool,
    unit: str,
    line: int,
    column: int,
    column_name: str,
) -> dict[str, str | int]:
    return {
        "record_id": make_record_id(dataset_id, gene_id_raw, sample_id),
        "dataset_id": dataset_id,
        "source_id": source_asset.source_id,
        "asset_id": source_asset.asset_id,
        "gene_id_raw": gene_id_raw,
        "gene_id": gene_id,
        "gene_id_namespace": gene_id_namespace,
        "sample_id": sample_id,
        "measurement_type": "gene_expression",
        "value_semantics": semantics,
        "value_scale": "linear",
        "is_normalized": str(normalized).lower(),
        "expression_value": raw,
        "expression_unit": unit,
        "source_logical_file": source_name,
        "source_line_number": line,
        "source_column_index": column,
        "source_column_name": column_name,
        "source_raw_value": raw,
    }


def _parse_clinical(
    source_asset: SourceAsset,
    dataset_id: str,
    workdir: TaskWorkDir,
    source_path: Path,
    source_name: str,
) -> ParsedDataset:
    output_path = workdir.parsed / f"{dataset_id}_gdc_clinical.csv"
    with _open_table(source_path) as handle:
        reader = csv.DictReader(handle, delimiter="\t")
        if not reader.fieldnames or "sample_id" not in reader.fieldnames:
            raise ValueError("GDC clinical TSV must contain sample_id")
        rows = list(reader)
    if not rows:
        raise ValueError("GDC clinical TSV contains no rows")
    source_columns = list(reader.fieldnames)
    columns = [
        "record_id", "dataset_id", "source_id", "asset_id", "sample_id",
        "measurement_type", *[column for column in source_columns if column != "sample_id"],
        "source_logical_file", "source_line_number", "source_column_index",
        "source_column_name", "source_raw_value",
    ]
    with output_path.open("w", encoding="utf-8-sig", newline="") as target:
        writer = csv.DictWriter(target, fieldnames=columns)
        writer.writeheader()
        for line_number, row in enumerate(rows, start=2):
            sample_id = row["sample_id"]
            writer.writerow({
                "record_id": make_record_id(dataset_id, "clinical", sample_id),
                "dataset_id": dataset_id,
                "source_id": source_asset.source_id,
                "asset_id": source_asset.asset_id,
                "sample_id": sample_id,
                "measurement_type": "sample_metadata",
                **{column: row[column] for column in source_columns if column != "sample_id"},
                "source_logical_file": source_name,
                "source_line_number": line_number,
                "source_column_index": 0,
                "source_column_name": "sample_id",
                "source_raw_value": sample_id,
            })
    return _parsed(
        output_path,
        source_asset,
        dataset_id,
        "gdc_clinical",
        len(rows),
        len(rows),
        "clinical",
        columns,
    )


def _parsed(
    output_path: Path,
    source_asset: SourceAsset,
    dataset_id: str,
    parser_name: str,
    source_rows: int,
    rows: int,
    kind: str,
    columns: list[str] | None = None,
) -> ParsedDataset:
    payload = output_path.read_bytes()
    checksum = hashlib.sha256(payload).hexdigest()
    file_asset = FileAsset(
        asset_id=asset_id_from_sha256(checksum),
        kind="parsed",
        relative_path=output_path.relative_to(output_path.parents[1]).as_posix(),
        sha256=checksum,
        size_bytes=len(payload),
        media_type="text/csv",
        generated_by_step_id=f"step_{parser_name}_v1",
    )
    return ParsedDataset(
        dataset_id=dataset_id,
        source_id=source_asset.source_id,
        source_asset_id=source_asset.asset_id,
        file_asset=file_asset,
        columns=columns or _OUTPUT_COLUMNS,
        row_count=rows,
        parser_name=parser_name,
        parser_version="1.0.0",
        source_row_count=source_rows,
        processing_parameters={"source_database": "gdc", "dataset_type": kind},
    )
