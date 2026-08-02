"""Reactome-specific validation checks.

When the main data is a Reactome pathway-participants table (``pathway_id``
column present), these 9 checks verify pathway/participant field completeness,
source/asset/dataset foreign-key closure and consistency, source-locator
integrity, and record-id uniqueness. Returns an empty list for non-Reactome
packages so the orchestrator can unconditionally extend the check list.
"""
from __future__ import annotations

import csv
import gzip
from pathlib import Path

from app.pipeline.stages.validation.checks_common import ValidationContext


def _read_reactome_source_lines(source_path: Path) -> list[list[str]]:
    if source_path.suffix.lower() == ".gz":
        with gzip.open(source_path, "rt", encoding="utf-8", newline="") as handle:
            return list(csv.reader(handle, delimiter="\t", quotechar='"'))
    with source_path.open("r", encoding="utf-8", newline="") as handle:
        return list(csv.reader(handle, delimiter="\t", quotechar='"'))


def check_reactome(ctx: ValidationContext) -> list[dict[str, object]]:
    """Return all Reactome checks, or an empty list for non-Reactome packages."""
    if not ctx.reactome_rows:
        return []

    main_rows = ctx.main_rows
    source_ids = ctx.source_ids
    asset_ids = ctx.asset_ids
    assets_by_id = ctx.assets_by_id
    dataset_rows = ctx.dataset_rows
    source_list_rows = ctx.source_list_rows

    reactome_source_lines = _read_reactome_source_lines(ctx.source_path)
    reactome_source_header = (
        reactome_source_lines[0] if reactome_source_lines else []
    )
    reactome_source_file = ctx.reactome_source_file

    pathway_failures = sum(
        not row.get("pathway_id", "").strip()
        or not row.get("pathway_name", "").strip()
        or not row.get("species", "").strip()
        for row in main_rows
    )
    participant_failures = sum(
        not row.get("participant_id", "").strip()
        or not row.get("participant_name", "").strip()
        or not row.get("participant_type", "").strip()
        or not row.get("interaction_type", "").strip()
        for row in main_rows
    )
    source_failures = sum(
        not row.get("source_id", "").strip()
        or row.get("source_id", "") not in source_ids
        for row in main_rows
    )
    asset_failures_for_rows = sum(
        not row.get("asset_id", "").strip()
        or row.get("asset_id", "") not in asset_ids
        for row in main_rows
    )
    asset_source_failures = sum(
        row.get("source_id", "")
        != assets_by_id.get(row.get("asset_id", ""), {}).get(
            "source_id", ""
        )
        for row in main_rows
    )
    dataset_row = dataset_rows[0] if dataset_rows else {}
    dataset_source_failures = sum(
        row.get("source_id", "") != dataset_row.get("source_id", "")
        or dataset_row.get("source_id", "") not in source_ids
        for row in main_rows
    )
    source_list_failures = sum(
        source.get("source_id", "") == dataset_row.get("source_id", "")
        and (
            source.get("database", "") != dataset_row.get("database", "")
            or source.get("accession", "") != dataset_row.get("accession", "")
        )
        for source in source_list_rows
    )
    dataset_accession = dataset_row.get("accession", "").strip()
    pathway_dataset_failures = sum(
        row.get("pathway_id", "").strip() != dataset_accession
        for row in main_rows
    )
    locator_failures = 0
    for row in main_rows:
        try:
            valid_locator = (
                bool(row.get("record_id", "").strip())
                and bool(row.get("source_logical_file", "").strip())
                and bool(row.get("source_column_name", "").strip())
                and bool(row.get("source_raw_value", "").strip())
                and int(row.get("source_line_number", "0")) >= 2
                and int(row.get("source_column_index", "-1")) >= 0
                and row.get("source_logical_file", "") == reactome_source_file
                and int(row["source_column_index"]) < len(reactome_source_header)
                and reactome_source_header[int(row["source_column_index"])]
                == row.get("source_column_name", "")
            )
        except ValueError:
            valid_locator = False
        locator_failures += not valid_locator
    checks: list[dict[str, object]] = []
    for check_id, check_name, failed_count in (
        (
            "reactome_pathway_fields",
            "Reactome pathway fields are complete",
            pathway_failures,
        ),
        (
            "reactome_participant_fields",
            "Reactome participant fields are complete",
            participant_failures,
        ),
        (
            "reactome_source_foreign_keys",
            "Reactome source references close",
            source_failures,
        ),
        (
            "reactome_asset_foreign_keys",
            "Reactome asset references close",
            asset_failures_for_rows,
        ),
        (
            "reactome_asset_source_consistency",
            "Reactome asset source references match main data",
            asset_source_failures,
        ),
        (
            "reactome_dataset_source_consistency",
            "Reactome dataset source matches main data and source list",
            dataset_source_failures + source_list_failures,
        ),
        (
            "reactome_pathway_dataset_consistency",
            "Reactome pathway IDs match dataset accession",
            pathway_dataset_failures,
        ),
        (
            "reactome_source_locator",
            "Reactome source locators are complete",
            locator_failures,
        ),
    ):
        checks.append(
            {
                "check_id": check_id,
                "scope": "pathway_members",
                "check_name": check_name,
                "status": "passed" if failed_count == 0 else "failed",
                "checked_count": len(main_rows),
                "failed_count": failed_count,
                "details": "",
            }
        )
    duplicate_record_ids = len(main_rows) - len(
        {row.get("record_id", "") for row in main_rows}
    )
    checks.append(
        {
            "check_id": "reactome_lineage_contract",
            "scope": "main_data",
            "check_name": "Reactome participant and lineage fields are complete",
            "status": "passed" if duplicate_record_ids == 0 else "failed",
            "checked_count": len(main_rows),
            "failed_count": duplicate_record_ids,
            "details": "",
        }
    )
    return checks
