"""Integrator: explicit append + dedup of canonical sources (Design §8.8).

Only the server-side ``append_by_canonical_row`` strategy is accepted; an
Agent cannot inject arbitrary merge logic.  Canonical row identity is
``(gene_id, sample_id, measurement_type, value_semantics)``.  Mirror rows
(identical identity and numerically equal value) are deduplicated; rows with
the same identity but conflicting values keep the first source deterministically
and are recorded in a conflicts audit file.
"""

from __future__ import annotations

import csv
import hashlib
from dataclasses import dataclass
from pathlib import Path

from app.datasets.build.canonicalizer import CanonicalizationResult
from app.datasets.build.errors import IntegratorError
from app.datasets.contracts import DataBatch, DatasetSchema, FileAsset, JsonValue
from app.domain.contracts import asset_id_from_sha256

MERGE_STRATEGY_APPEND = "append_by_canonical_row"

CONFLICT_COLUMNS = (
    "conflict_id",
    "gene_id",
    "sample_id",
    "measurement_type",
    "value_semantics",
    "first_source_asset_id",
    "first_value",
    "second_source_asset_id",
    "second_value",
    "action",
)


@dataclass(frozen=True)
class IntegrationResult:
    """Merged primary dataset batch plus merge audit counts."""

    batch: DataBatch
    merged_path: Path
    row_count: int
    dedup_count: int
    conflict_count: int
    conflicts_path: Path | None


def integrate(
    *,
    results: list[CanonicalizationResult],
    merge_strategy: str,
    schema: DatasetSchema,
    build_id: str,
    output_dir: Path,
) -> IntegrationResult:
    """Append canonical sources into one primary dataset, dedup by row identity."""
    if merge_strategy != MERGE_STRATEGY_APPEND:
        raise IntegratorError(
            f"unsupported merge strategy {merge_strategy!r}; "
            f"server allows only {MERGE_STRATEGY_APPEND!r}"
        )
    if not results:
        raise IntegratorError("cannot integrate zero sources")
    merged_dir = output_dir / "merged"
    merged_dir.mkdir(parents=True, exist_ok=True)
    merged_path = merged_dir / "primary.csv"
    conflicts_path = merged_dir / "conflicts.csv"

    columns = [field.name for field in schema.fields]
    seen: dict[tuple[str, str, str, str], tuple[str, str, str]] = {}
    row_count = 0
    dedup_count = 0
    conflict_count = 0
    with (
        merged_path.open("w", encoding="utf-8", newline="") as merged,
        conflicts_path.open("w", encoding="utf-8", newline="") as conflicts,
    ):
        writer = csv.DictWriter(merged, fieldnames=columns)
        writer.writeheader()
        conflict_writer = csv.DictWriter(conflicts, fieldnames=CONFLICT_COLUMNS)
        conflict_writer.writeheader()
        for result in results:
            with result.canonical_path.open("r", encoding="utf-8", newline="") as handle:
                for row in csv.DictReader(handle):
                    key = _row_identity(row)
                    value = row.get("expression_value", "")
                    previous = seen.get(key)
                    if previous is None:
                        seen[key] = (value, row.get("asset_id", ""), result.batch.binding_id)
                        writer.writerow(row)
                        row_count += 1
                        continue
                    previous_value, previous_asset, previous_binding = previous
                    if _numerically_equal(previous_value, value):
                        dedup_count += 1
                        continue
                    conflict_writer.writerow(
                        {
                            "conflict_id": f"conflict_{key[0]}_{key[1]}_{row_count}",
                            "gene_id": key[0],
                            "sample_id": key[1],
                            "measurement_type": key[2],
                            "value_semantics": key[3],
                            "first_source_asset_id": previous_asset,
                            "first_value": previous_value,
                            "second_source_asset_id": row.get("asset_id", ""),
                            "second_value": value,
                            "action": "kept_first_source",
                        }
                    )
                    conflict_count += 1

    payload = merged_path.read_bytes()
    checksum = hashlib.sha256(payload).hexdigest()
    file_asset = FileAsset(
        asset_id=asset_id_from_sha256(checksum),
        kind="artifact",
        relative_path=merged_path.relative_to(output_dir).as_posix(),
        sha256=checksum,
        size_bytes=len(payload),
        media_type="text/csv",
        generated_by_step_id="step_integrator_v1",
    )
    statistics: dict[str, JsonValue] = {
        "row_count": row_count,
        "dedup_count": dedup_count,
        "conflict_count": conflict_count,
        "source_batches": [result.batch.binding_id for result in results],
        "merge_strategy": MERGE_STRATEGY_APPEND,
        "dataset_id": build_id,
    }
    merged_batch = DataBatch(
        batch_id="merged_primary",
        binding_id="merged",
        dataset_family=results[0].batch.dataset_family,
        row_granularity=results[0].batch.row_granularity,
        schema_ref=schema.schema_id,
        file_asset=file_asset,
        row_count=row_count,
        column_count=len(columns),
        parser_id="expression.integrator.v1",
        parser_version="1.0.0",
        statistics=statistics,
    )
    return IntegrationResult(
        batch=merged_batch,
        merged_path=merged_path,
        row_count=row_count,
        dedup_count=dedup_count,
        conflict_count=conflict_count,
        conflicts_path=conflicts_path,
    )


def _row_identity(row: dict[str, str]) -> tuple[str, str, str, str]:
    return (
        row.get("gene_id", ""),
        row.get("sample_id", ""),
        row.get("measurement_type", ""),
        row.get("value_semantics", ""),
    )


def _numerically_equal(left: str, right: str) -> bool:
    try:
        return float(left) == float(right)
    except ValueError:
        return left == right
