"""Source-value lineage validation checks.

Verifies that a deterministic sample of main_data rows reproduce their
recorded ``source_raw_value``/``expression_value`` from the originating
source file at the recorded line/column locator. Multi-source merged
packages route each row to the file of its own asset (TODO §1.5.4).
"""
from __future__ import annotations

import csv
import gzip
import json
from pathlib import Path

from app.pipeline.stages.validation.checks_common import (
    ValidationContext,
    deterministic_sample,
)


def _read_source_lines(path: Path) -> list[list[str]]:
    if path.suffix.lower() == ".gz":
        with gzip.open(path, "rt", encoding="utf-8", newline="") as handle:
            return list(csv.reader(handle, delimiter="\t", quotechar='"'))
    with path.open("r", encoding="utf-8", newline="") as handle:
        return list(csv.reader(handle, delimiter="\t", quotechar='"'))


def check_source_value_lineage(ctx: ValidationContext) -> dict[str, object]:
    """Sampled main_data values must match the source file locator.

    Rows carrying an expression value are verified fully (source raw value AND
    numeric expression value). Rows without one — e.g. GDC clinical variables,
    whose cells are clinical strings — are verified locator-only: the recorded
    ``source_raw_value`` must reproduce from the source file, but there is no
    expression value to compare. The placeholder-era
    ``measurement_type="sample_metadata"`` skip was deleted in phase 4b T6
    (T1 removed the placeholder producer; the row-level guard keeps the check
    safe for the still-produced GDC clinical rows).
    """
    main_rows = ctx.main_rows
    source_path = ctx.source_path
    source_rel_base = ctx.source_rel_base
    assets_by_id = ctx.assets_by_id
    reactome_rows = ctx.reactome_rows
    max_lineage_checks = ctx.max_lineage_checks

    lines_cache: dict[str, list[list[str]]] = {}

    def _lines_for(asset_id: str) -> list[list[str]]:
        key = asset_id or "source"
        if key in lines_cache:
            return lines_cache[key]
        path = source_path
        if asset_id:
            asset_row = assets_by_id.get(asset_id)
            if asset_row and asset_row.get("relative_path"):
                candidate = source_rel_base / asset_row["relative_path"]
                if candidate.is_file():
                    path = candidate
        lines = _read_source_lines(path)
        lines_cache[key] = lines
        return lines

    sampled_rows = deterministic_sample(main_rows, max_lineage_checks)
    lineage_failures = 0
    for row in sampled_rows:
        lines = _lines_for(row.get("asset_id", ""))
        if reactome_rows:
            line_index = int(row["source_line_number"]) - 1
            column_index = int(row["source_column_index"])
            try:
                raw = lines[line_index][column_index]
            except (IndexError, ValueError):
                lineage_failures += 1
                continue
            if raw != row["source_raw_value"] or raw != row["participant_id"]:
                lineage_failures += 1
            continue
        line_index = int(row["source_line_number"]) - 1
        column_index = int(row["source_column_index"])
        try:
            raw = lines[line_index][column_index]
        except (IndexError, ValueError):
            lineage_failures += 1
            continue
        # Rows without an expression value (e.g. GDC clinical variables —
        # phase 4b T6) are verified locator-only: the source raw value must
        # reproduce, but there is no numeric expression value to compare.
        # The placeholder-era measurement_type="sample_metadata" skip was
        # deleted (T1 removed the placeholder producer); this row-level guard
        # keeps the check safe for the still-produced GDC clinical rows.
        if not str(row.get("expression_value", "")).strip():
            if raw != row["source_raw_value"]:
                lineage_failures += 1
            continue
        if raw != row["source_raw_value"] or float(raw) != float(
            row["expression_value"]
        ):
            lineage_failures += 1
    total_sampled = len(sampled_rows)
    checked_count = total_sampled
    return {
        "check_id": "source_value_lineage",
        "scope": "main_data",
        "check_name": "sampled values match source locator",
        "status": "passed" if lineage_failures == 0 else "failed",
        "checked_count": checked_count,
        "failed_count": lineage_failures,
        "details": json.dumps(
            {
                "total_rows": len(main_rows),
                "sampled": total_sampled,
            }
        ),
    }
