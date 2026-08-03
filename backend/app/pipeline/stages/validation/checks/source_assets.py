"""Source-asset integrity validation checks.

Verifies each source asset's file exists on disk, matches its recorded
checksum and size, and references a successful download attempt.
"""
from __future__ import annotations

from app.pipeline.stages.validation.checks_common import ValidationContext, sha256


def check_source_asset_integrity(ctx: ValidationContext) -> dict[str, object]:
    """Source asset file, checksum, and successful attempt are all valid."""
    asset_rows = ctx.asset_rows
    source_ids = ctx.source_ids
    successful_attempt_ids = {
        row["attempt_id"] for row in ctx.download_rows if row["status"] == "succeeded"
    }
    asset_failures = 0
    # row["relative_path"] 是相对于 task_dir 的路径（含 source_assets/ 前缀）。
    # source_path 可能是 task_dir/source_assets/file（测试场景）或
    # task_dir/source_assets/asset_dir/file（生产场景），需要动态查找
    # "source_assets" 组件来确定 task_dir。
    source_rel_base = ctx.source_rel_base
    for row in asset_rows:
        asset_path = source_rel_base / row["relative_path"]
        attempt_id = row.get("successful_attempt_id", "")
        derived_from_asset_id = row.get("derived_from_asset_id", "")
        has_exactly_one_lineage = bool(attempt_id) != bool(derived_from_asset_id)
        if attempt_id:
            lineage_valid = (
                attempt_id in successful_attempt_ids
                and ctx.attempts_by_id.get(attempt_id, {}).get("source_id")
                == row["source_id"]
            )
        else:
            parent_asset = ctx.assets_by_id.get(derived_from_asset_id, {})
            lineage_valid = bool(parent_asset) and (
                parent_asset.get("source_id") == row["source_id"]
            )
        asset_failures += (
            not has_exactly_one_lineage
            or not lineage_valid
            or row["source_id"] not in source_ids
            or not asset_path.is_file()
            or int(row["size_bytes"]) != asset_path.stat().st_size
            or row["sha256"] != sha256(asset_path)
        )
    return {
        "check_id": "source_asset_integrity",
        "scope": "source_assets",
        "check_name": "source asset file, checksum, and successful attempt",
        "status": "passed" if asset_failures == 0 else "failed",
        "checked_count": len(asset_rows),
        "failed_count": asset_failures,
        "details": "",
    }
