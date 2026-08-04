"""Sample-metadata validation checks."""
from __future__ import annotations

from app.pipeline.stages.validation.checks_common import ValidationContext


def check_sample_foreign_keys(ctx: ValidationContext) -> dict[str, object]:
    """Sample dataset and source closure against the catalog/source list."""
    sample_rows = ctx.sample_rows
    sample_reference_failures = sum(
        row["dataset_id"] not in ctx.dataset_ids
        or row["source_id"] not in ctx.source_ids
        or ctx.datasets_by_id.get(row["dataset_id"], {}).get("source_id")
        != row["source_id"]
        for row in sample_rows
    )
    return {
        "check_id": "sample_foreign_keys",
        "scope": "sample_metadata",
        "check_name": "sample dataset and source closure",
        "status": "passed" if sample_reference_failures == 0 else "failed",
        "checked_count": len(sample_rows),
        "failed_count": sample_reference_failures,
        "details": "",
    }
