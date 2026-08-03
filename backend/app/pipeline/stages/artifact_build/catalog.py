"""Dataset catalog and multi-source manifest CSV building helpers.

Builds ``dataset_catalog.csv`` and ``multi_source_manifest.csv`` rows (TODO §1.5.4).
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from app.domain.contracts import ParsedDataset, SourceRecord, TaskSpecification
from app.domain.contracts.discovery import GeoSeriesRecord
from app.pipeline.stages.artifact_build.samples import _read_parsed_rows


def _build_dataset_catalog_rows(
    *,
    is_merged: bool,
    all_parsed: list[ParsedDataset],
    specification: TaskSpecification,
    dataset_id: str,
    primary_source_id: str,
    dataset_accession: str,
    dataset_title: str,
    geo: GeoSeriesRecord | None,
    is_reactome: bool,
    dataset_url_value: str,
    retrieved_at: datetime,
    workdir_root: Path,
    parsed_path: Path,
    sources: list[SourceRecord],
) -> list[dict[str, object]]:
    """Build ``dataset_catalog.csv`` rows.

    The single-dataset path keeps the historic one-row GEO-oriented catalog
    entry. When a deterministic multi-source merge exists (TODO §1.2), one
    row per input dataset is emitted so every ``dataset_id`` referenced by
    the merged ``main_data.csv`` closes against the catalog (TODO §1.5.4).
    """
    if not is_merged:
        # Derive the dataset's own database rather than sources[0].database.
        # The sources list orders PubMed first then GEO (see discovery
        # ``_build_output``), so sources[0].database is PubMed even for a GEO
        # dataset — which produced the bug where dataset_catalog.csv reported
        # ``database=pubmed`` for a GSE accession (see ARTIFACT_ANALYSIS
        # §缺陷 4).
        if is_reactome:
            dataset_database = "reactome"
        elif geo is not None:
            dataset_database = "geo"
        else:
            dataset_database = sources[0].database.value if sources else ""
        return [
            {
                "dataset_id": dataset_id,
                "source_id": primary_source_id,
                "database": dataset_database,
                "accession": dataset_accession,
                "title": geo.title if geo else dataset_title,
                "organism": geo.organism if geo else "",
                "experiment_type": (
                    "pathway_participants"
                    if is_reactome
                    else (geo.experiment_type if geo else "gene_expression")
                ),
                "sample_count": (
                    len(_read_parsed_rows(parsed_path))
                    if is_reactome
                    else (geo.sample_count if geo else 2)
                ),
                "platform_ids": (
                    "[]"
                    if is_reactome
                    else (json.dumps(sorted(geo.platform_ids)) if geo else "[]")
                ),
                "related_pmids": (
                    "[]"
                    if is_reactome
                    else (json.dumps(sorted(geo.pubmed_ids)) if geo else "[]")
                ),
                "source_url": dataset_url_value,
                "retrieved_at": retrieved_at.isoformat(),
            }
        ]

    selections = {d.dataset_id: d for d in specification.datasets}
    rows: list[dict[str, object]] = []
    for dataset in all_parsed:
        selection = selections.get(dataset.dataset_id)
        dataset_path = workdir_root / dataset.file_asset.relative_path
        try:
            sample_count = len(
                {
                    row["sample_id"]
                    for row in _read_parsed_rows(dataset_path)
                    if row.get("sample_id")
                }
            )
        except (OSError, KeyError):
            sample_count = dataset.row_count
        rows.append(
            {
                "dataset_id": dataset.dataset_id,
                "source_id": dataset.source_id,
                "database": (
                    selection.database.value if selection else ""
                ),
                "accession": (
                    selection.accession if selection else dataset.dataset_id
                ),
                "title": dataset.dataset_id,
                "organism": "",
                "experiment_type": (
                    selection.data_type if selection and selection.data_type
                    else "gene_expression"
                ),
                "sample_count": sample_count,
                "platform_ids": "[]",
                "related_pmids": "[]",
                "source_url": dataset_url_value,
                "retrieved_at": retrieved_at.isoformat(),
            }
        )
    return rows


def _build_multi_source_manifest_rows(
    all_parsed: list[ParsedDataset],
    specification: TaskSpecification,
) -> list[dict[str, object]]:
    """Build ``multi_source_manifest.csv`` rows (TODO §1.5.4).

    One row per input dataset: ``dataset_id`` → source ``database`` →
    parsed ``row_count``. Only produced when a deterministic multi-source
    merge exists so single-source runs keep the historic artifact set.
    """
    selections = {d.dataset_id: d for d in specification.datasets}
    return [
        {
            "dataset_id": dataset.dataset_id,
            "database": (
                selections[dataset.dataset_id].database.value
                if dataset.dataset_id in selections
                else ""
            ),
            "accession": (
                selections[dataset.dataset_id].accession
                if dataset.dataset_id in selections
                else dataset.dataset_id
            ),
            "source_id": dataset.source_id,
            "row_count": dataset.row_count,
        }
        for dataset in all_parsed
    ]
