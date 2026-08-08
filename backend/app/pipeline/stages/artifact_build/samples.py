"""Sample metadata CSV building helpers.

Builds ``sample_metadata.csv`` rows from GEO sample metadata, with a fallback
that derives one row per distinct ``sample_id`` from the parsed long-form
dataset when no GEO metadata was recovered (TODO §1.5.4).
"""
from __future__ import annotations

import csv
from pathlib import Path

from app.pipeline.processing.geo_tximport import GeoSampleMetadata

# Phase 5 T8: tumor/normal grouping + pairing columns appended to
# sample_metadata.csv only when the extractor produced evidence (a non-empty
# sample_group_raw or a pairing_id), so cell-line/treatment-only metadata
# keeps the historic base columns (fixture regression).
_SAMPLE_GROUP_EXTENDED_COLUMNS = [
    "sample_group", "sample_group_raw", "pairing_id", "group_rule_id",
]


def samples_have_group_evidence(samples: list[GeoSampleMetadata]) -> bool:
    """True when any sample carries extracted tumor/normal or pairing evidence.

    Cell-line/treatment-only metadata (no classification field, no pairing
    key) yields no evidence, so the extended ``sample_metadata.csv`` columns
    are omitted and historic outputs stay unchanged (T8 fixture regression).
    """
    return any(sample.sample_group_raw or sample.pairing_id for sample in samples)


def _read_parsed_rows(parsed_path: Path) -> list[dict[str, str]]:
    with parsed_path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def _build_xena_samples(
    parsed_path: Path, dataset_id: str, source_id: str, source_url: str
) -> list[dict[str, object]]:
    sample_ids = sorted({row["sample_id"] for row in _read_parsed_rows(parsed_path)})
    return [{
        "sample_id": sample_id, "dataset_id": dataset_id, "source_id": source_id,
        "source_sample_alias": sample_id, "cell_line_raw": "",
        "cell_line_canonical": "", "normalization_rule": "", "treatment": "",
        "replicate": "", "organism": "", "source_url": source_url,
    } for sample_id in sample_ids]


def _build_sample_metadata_rows(
    *,
    samples: list[GeoSampleMetadata],
    dataset_id: str,
    primary_source_id: str,
    geo_url: str,
    is_reactome: bool,
    parsed_path: Path | None = None,
    dataset_url_value: str,
) -> list[dict[str, object]]:
    """Build ``sample_metadata.csv`` rows.

    Reactome packages emit no sample rows. When GEO sample metadata is
    available each sample yields one row. When no metadata was recovered the
    fallback derives one row per distinct ``sample_id`` from the parsed
    long-form dataset; for a merged package the sample belongs to the
    dataset/source of its originating rows (TODO §1.5.4), keeping
    sample_metadata's dataset/source closure. When no parsed long-form file
    exists (phase 4b NO_DATA — ``parsed_path`` is None) the fallback is
    skipped entirely: the rows can only come from the recovered samples list.
    """
    include_group_columns = samples_have_group_evidence(samples)
    sample_rows: list[dict[str, object]] = []
    for sample in samples:
        row: dict[str, object] = {
            "sample_id": sample.sample_id,
            "dataset_id": dataset_id,
            "source_id": primary_source_id,
            "source_sample_alias": sample.source_alias,
            "cell_line_raw": sample.cell_line_raw,
            "cell_line_canonical": sample.cell_line_canonical,
            "normalization_rule": sample.normalization_rule,
            "treatment": sample.treatment,
            "replicate": sample.replicate,
            "organism": sample.organism,
            "source_url": geo_url,
        }
        if include_group_columns:
            row.update({
                "sample_group": sample.sample_group,
                "sample_group_raw": sample.sample_group_raw,
                "pairing_id": sample.pairing_id or "",
                "group_rule_id": sample.group_rule_id,
            })
        sample_rows.append(row)
    if not is_reactome and not sample_rows and parsed_path is not None:
        if not parsed_path.is_file():
            return sample_rows
        sample_rows = []
        seen_samples: set[tuple[str, str, str]] = set()
        for row in _read_parsed_rows(parsed_path):
            sample_id = row.get("sample_id")
            if not sample_id:
                continue
            row_dataset_id = row.get("dataset_id") or dataset_id
            row_source_id = row.get("source_id") or primary_source_id
            if (sample_id, row_dataset_id, row_source_id) in seen_samples:
                continue
            seen_samples.add((sample_id, row_dataset_id, row_source_id))
            sample_rows.append(
                {
                    "sample_id": sample_id,
                    "dataset_id": row_dataset_id,
                    "source_id": row_source_id,
                    "source_sample_alias": sample_id,
                    "cell_line_raw": "",
                    "cell_line_canonical": "",
                    "normalization_rule": "",
                    "treatment": "",
                    "replicate": "",
                    "organism": "",
                    "source_url": dataset_url_value,
                }
            )
    return sample_rows
