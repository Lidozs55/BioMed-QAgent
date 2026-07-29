"""Parser for UCSC Xena gene-expression matrices."""

from __future__ import annotations

import csv
import gzip
import hashlib
from pathlib import Path

from app.domain.contracts import (
    FileAsset,
    ParsedDataset,
    SourceAsset,
    asset_id_from_sha256,
    make_record_id,
)
from app.tools.workdir import TaskWorkDir

_OUTPUT_COLUMNS = [
    "record_id",
    "dataset_id",
    "source_id",
    "asset_id",
    "gene_id_raw",
    "gene_id",
    "gene_id_namespace",
    "sample_id",
    "measurement_type",
    "value_semantics",
    "value_scale",
    "is_normalized",
    "expression_value",
    "expression_unit",
    "source_logical_file",
    "source_line_number",
    "source_column_index",
    "source_column_name",
    "source_raw_value",
]


def parse_xena_matrix(
    source_asset: SourceAsset, dataset_id: str, workdir: TaskWorkDir
) -> ParsedDataset:
    source_path = workdir.root / source_asset.relative_path
    if not source_path.is_file():
        raise FileNotFoundError(source_path)
    source_bytes = source_path.read_bytes()
    if hashlib.sha256(source_bytes).hexdigest() != source_asset.sha256:
        raise ValueError("source asset checksum mismatch before processing")

    source_file = source_asset.relative_path.split("/", 1)[-1]
    output_path = workdir.parsed / f"{dataset_id}_gene_expression_long.csv"
    row_count = 0
    source_row_count = 0
    with _open_matrix(source_path) as source:
        rows = csv.reader(source, delimiter="\t")
        try:
            header = next(rows)
        except StopIteration as exc:
            raise ValueError("Xena matrix is empty") from exc
        if len(header) < 2 or header[0] != "gene_id":
            raise ValueError("Xena matrix must have gene_id and sample columns")
        sample_headers = header[1:]
        if any(not sample for sample in sample_headers):
            raise ValueError("Xena matrix sample headers must not be blank")
        if len(set(sample_headers)) != len(sample_headers):
            raise ValueError("Xena matrix sample headers must be unique")

        with output_path.open("w", encoding="utf-8-sig", newline="") as target:
            writer = csv.DictWriter(target, fieldnames=_OUTPUT_COLUMNS)
            writer.writeheader()
            for source_line_number, values in enumerate(rows, start=2):
                if not values or all(not value for value in values):
                    continue
                if len(values) != len(header):
                    raise ValueError(
                        f"source line {source_line_number} has an unexpected field count"
                    )
                gene_id = values[0]
                if not gene_id:
                    raise ValueError("Xena matrix gene_id must not be blank")
                source_row_count += 1
                for column_index, sample_id in enumerate(sample_headers, start=1):
                    raw_value = values[column_index]
                    try:
                        float(raw_value)
                    except ValueError as exc:
                        raise ValueError(
                            f"non-numeric expression value at source line {source_line_number}"
                        ) from exc
                    writer.writerow(
                        {
                            "record_id": make_record_id(dataset_id, gene_id, sample_id),
                            "dataset_id": dataset_id,
                            "source_id": source_asset.source_id,
                            "asset_id": source_asset.asset_id,
                            "gene_id_raw": gene_id,
                            "gene_id": gene_id,
                            "gene_id_namespace": "xena_gene",
                            "sample_id": sample_id,
                            "measurement_type": "gene_expression",
                            "value_semantics": "expression_value",
                            "value_scale": "linear",
                            "is_normalized": "false",
                            "expression_value": raw_value,
                            "expression_unit": "expression_value",
                            "source_logical_file": source_file,
                            "source_line_number": source_line_number,
                            "source_column_index": column_index,
                            "source_column_name": sample_id,
                            "source_raw_value": raw_value,
                        }
                    )
                    row_count += 1

    if source_row_count == 0:
        output_path.unlink()
        raise ValueError("Xena matrix contains no data rows")

    file_bytes = output_path.read_bytes()
    checksum = hashlib.sha256(file_bytes).hexdigest()
    file_asset = FileAsset(
        asset_id=asset_id_from_sha256(checksum),
        kind="parsed",
        relative_path=output_path.relative_to(workdir.root).as_posix(),
        sha256=checksum,
        size_bytes=len(file_bytes),
        media_type="text/csv",
        generated_by_step_id="step_xena_gene_expression_v1",
    )
    return ParsedDataset(
        dataset_id=dataset_id,
        source_id=source_asset.source_id,
        source_asset_id=source_asset.asset_id,
        file_asset=file_asset,
        columns=_OUTPUT_COLUMNS,
        row_count=row_count,
        parser_name="xena_gene_expression",
        parser_version="1.0.0",
        source_row_count=source_row_count,
        processing_parameters={
            "source_database": "ucsc_xena",
            "dataset_type": "gene_expression",
        },
    )


def _open_matrix(path: Path):
    if path.suffix.lower() == ".gz":
        return gzip.open(path, "rt", encoding="utf-8", newline="")
    return path.open("r", encoding="utf-8", newline="")
