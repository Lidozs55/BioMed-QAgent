"""Parser for Reactome pathway participant TSV exports."""

from __future__ import annotations

import csv
import gzip
import hashlib
import io
import json
from pathlib import Path
from typing import TextIO

from app.domain.contracts import (
    FileAsset,
    ParsedDataset,
    SourceAsset,
    asset_id_from_sha256,
    make_record_id,
)
from app.tools.workdir import TaskWorkDir

_REQUIRED_COLUMNS = [
    "pathway_id",
    "pathway_name",
    "participant_id",
    "participant_name",
    "participant_type",
    "species",
    "interaction_type",
]
_REACTOME_EXPORT_COLUMNS = {
    "physical_entity": "pathway_id",
    "name": "pathway_name",
    "database_id": "participant_id",
    "stId": "participant_id",
}
_OUTPUT_COLUMNS = [
    "record_id",
    "dataset_id",
    "source_id",
    "asset_id",
    *_REQUIRED_COLUMNS,
    "source_logical_file",
    "source_line_number",
    "source_column_index",
    "source_column_name",
    "source_raw_value",
]


def parse_reactome_table(
    source_asset: SourceAsset,
    dataset_id: str,
    workdir: TaskWorkDir,
    pathway_id: str | None = None,
) -> ParsedDataset:
    source_path = workdir.root / source_asset.relative_path
    if not source_path.is_file():
        raise FileNotFoundError(source_path)
    source_bytes = source_path.read_bytes()
    if hashlib.sha256(source_bytes).hexdigest() != source_asset.sha256:
        raise ValueError("source asset checksum mismatch before processing")

    output_path = workdir.parsed / f"{dataset_id}_pathway_members.csv"
    source_file = source_asset.relative_path.rsplit("/", 1)[-1]
    if source_file.lower().endswith(".gz"):
        source_file = source_file[:-3]
    source_row_count = 0
    source_handle = (
        _open_reactome_json(source_path, pathway_id or dataset_id)
        if source_path.suffix.lower() == ".json"
        else _open_table(source_path)
    )
    with (
        source_handle as source,
        output_path.open("w", encoding="utf-8-sig", newline="") as target,
    ):
        reader = csv.DictReader(source, delimiter="\t")
        header = reader.fieldnames
        if header is None:
            raise ValueError("Reactome TSV is empty")
        if set(_REQUIRED_COLUMNS).issubset(header):
            column_map = {column: column for column in _REQUIRED_COLUMNS}
        elif {"physical_entity", "name", "database_id"}.issubset(header):
            column_map = {
                "pathway_id": "physical_entity",
                "pathway_name": "name",
                "participant_id": "stId" if "stId" in header else "database_id",
                "participant_name": "name",
                "participant_type": "participant_type",
                "species": "species",
                "interaction_type": "interaction_type",
            }
        else:
            raise ValueError("Reactome TSV missing required columns")
        writer = csv.DictWriter(target, fieldnames=_OUTPUT_COLUMNS)
        writer.writeheader()
        for source_line_number, row in enumerate(reader, start=2):
            if not any((value or "").strip() for value in row.values()):
                continue
            values = {
                column: (row.get(source_column) or "").strip()
                for column, source_column in column_map.items()
            }
            if any(row.get(column) is None for column in header):
                raise ValueError(f"Reactome TSV truncated row at line {source_line_number}")
            pathway_id = values["pathway_id"]
            participant_id = values["participant_id"]
            if not pathway_id or not participant_id:
                raise ValueError(
                    "Reactome TSV pathway_id and participant_id must not be blank "
                    f"at line {source_line_number}"
                )
            source_row_count += 1
            writer.writerow(
                {
                    "record_id": make_record_id(dataset_id, pathway_id, participant_id),
                    "dataset_id": dataset_id,
                    "source_id": source_asset.source_id,
                    "asset_id": source_asset.asset_id,
                    **values,
                    "source_logical_file": source_file,
                    "source_line_number": source_line_number,
                    "source_column_index": header.index(column_map["participant_id"]),
                    "source_column_name": column_map["participant_id"],
                    "source_raw_value": row[column_map["participant_id"]],
                }
            )

    if source_row_count == 0:
        output_path.unlink(missing_ok=True)
        raise ValueError("Reactome TSV contains no data rows")

    file_bytes = output_path.read_bytes()
    checksum = hashlib.sha256(file_bytes).hexdigest()
    file_asset = FileAsset(
        asset_id=asset_id_from_sha256(checksum),
        kind="parsed",
        relative_path=output_path.relative_to(workdir.root).as_posix(),
        sha256=checksum,
        size_bytes=len(file_bytes),
        media_type="text/csv",
        generated_by_step_id="step_reactome_pathway_participants_v1",
    )
    return ParsedDataset(
        dataset_id=dataset_id,
        source_id=source_asset.source_id,
        source_asset_id=source_asset.asset_id,
        file_asset=file_asset,
        columns=_OUTPUT_COLUMNS,
        row_count=source_row_count,
        parser_name="reactome_pathway_participants",
        parser_version="1.0.0",
        source_row_count=source_row_count,
        processing_parameters={
            "source_database": "reactome",
            "dataset_type": "pathway_participants",
        },
    )


def _open_reactome_json(path: Path, pathway_id: str) -> TextIO:
    try:
        payload = json.loads(path.read_text("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("Reactome ContentService response is not valid JSON") from exc
    if not isinstance(payload, list) or not payload:
        raise ValueError("Reactome ContentService response must be a non-empty JSON list")

    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=_REQUIRED_COLUMNS, delimiter="\t")
    writer.writeheader()
    for index, item in enumerate(payload):
        if not isinstance(item, dict):
            raise ValueError(f"Reactome participant at index {index} is not an object")
        participant_id = item.get("stId") or item.get("databaseName") or item.get("dbId")
        if not isinstance(participant_id, (str, int)) or not str(participant_id).strip():
            raise ValueError(
                f"Reactome participant at index {index} is missing a participant identifier"
            )
        participant_name = item.get("displayName") or item.get("name") or ""
        species = item.get("speciesName") or item.get("species") or ""
        writer.writerow(
            {
                "pathway_id": pathway_id,
                "pathway_name": pathway_id,
                "participant_id": str(participant_id).strip(),
                "participant_name": str(participant_name).strip(),
                "participant_type": item.get("schemaClass") or item.get("participant_type") or "",
                "species": species,
                "interaction_type": item.get("interaction_type") or "participant",
            }
        )
    output.seek(0)
    return output


def _open_table(path: Path) -> TextIO:
    if path.suffix.lower() == ".gz":
        return gzip.open(path, "rt", encoding="utf-8", newline="")
    return path.open("r", encoding="utf-8", newline="")
