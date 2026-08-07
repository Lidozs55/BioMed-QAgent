"""Shared helpers and the ``ValidationContext`` carrier for validation checks.

``ValidationContext`` is the key to splitting the former ``_validate_package``
monolith: it carries every loaded CSV and derived lookup that the per-scope
check modules need, so each check function takes a single context argument
instead of ~15 shared local variables.
"""
from __future__ import annotations

import csv
import hashlib
from dataclasses import dataclass
from pathlib import Path

ARTIFACT_COLUMNS_QUALITY = [
    "check_id", "scope", "check_name", "status",
    "checked_count", "failed_count", "details",
]

DEFAULT_MAX_LINEAGE_CHECKS = 100


def read_csv(path: Path) -> list[dict[str, str]]:
    # utf-8-sig strips the BOM that artifact_build.write_csv adds (TODO §1.7).
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def deterministic_sample(
    rows: list[dict[str, str]], max_samples: int | None
) -> list[dict[str, str]]:
    """Select up to ``max_samples`` rows deterministically by record_id hash.

    The sampling is stable across runs: the same input always yields the same
    subset, which makes validation failures reproducible.
    """
    if max_samples is None or len(rows) <= max_samples:
        return rows
    scored = [
        (hashlib.sha256(row["record_id"].encode("utf-8")).digest(), row)
        for row in rows
    ]
    scored.sort(key=lambda item: item[0])
    return [row for _hash, row in scored[:max_samples]]


def compute_source_rel_base(source_path: Path) -> Path:
    """Resolve the task directory used to interpret asset ``relative_path``.

    ``relative_path`` is relative to the task dir (with a ``source_assets/``
    prefix). ``source_path`` may be ``task_dir/source_assets/file`` (tests) or
    ``task_dir/source_assets/asset_dir/file`` (production); this finds the
    ``source_assets`` component to determine the task dir.
    """
    parts = source_path.parts
    try:
        sa_index = parts.index("source_assets")
    except ValueError:
        return source_path.parents[1]
    return source_path.parents[len(parts) - sa_index - 1]


@dataclass
class ValidationContext:
    """Loaded CSV data and derived lookups shared across validation checks.

    Populated once by ``package.load_validation_context`` and passed to every
    per-scope check function. Carrying the shared state here is what lets the
    former 418-line ``_validate_package`` split into focused check modules
    without re-reading CSVs or threading ~15 parameters through each check.
    """

    staging: Path
    source_path: Path
    report_path: Path
    max_lineage_checks: int | None
    main_path: Path
    main_rows: list[dict[str, str]]
    dataset_rows: list[dict[str, str]]
    dataset_ids: set[str]
    datasets_by_id: dict[str, dict[str, str]]
    sample_rows: list[dict[str, str]]
    sample_ids: set[str]
    samples_by_id: dict[str, dict[str, str]]
    source_list_rows: list[dict[str, str]]
    source_ids: set[str]
    sources_by_id: dict[str, dict[str, str]]
    asset_rows: list[dict[str, str]]
    asset_ids: set[str]
    assets_by_id: dict[str, dict[str, str]]
    download_rows: list[dict[str, str]]
    attempts_by_id: dict[str, dict[str, str]]
    described: set[str]
    reactome_rows: bool
    source_rel_base: Path
    # True when the staging package has no primary table (neither
    # ``main_data.csv`` nor ``pathway_members.csv``): phase 4b NO_DATA mode
    # (ADR-011). ``main_rows`` is ``[]`` in that case and ``validate_package``
    # runs the no_primary branch (decision check + supporting checks) instead
    # of the main-table checks. Default False keeps direct ``ValidationContext``
    # construction (tests) backward compatible.
    no_primary: bool = False
    # reactome source header is loaded lazily by the reactome checks; exposed
    # here so the lineage check can reuse the same source-file reader logic
    # without re-deriving the file name.
    reactome_source_file: str = ""


def load_validation_context(
    staging: Path,
    source_path: Path,
    report_path: Path,
    *,
    max_lineage_checks: int | None = DEFAULT_MAX_LINEAGE_CHECKS,
) -> ValidationContext:
    """Load every CSV the validation checks need into a ``ValidationContext``.

    Reads each staging CSV once and derives the lookup sets/maps the checks
    share. ``source_rel_base`` is computed from ``source_path`` so the
    source-asset and lineage checks resolve asset ``relative_path`` values
    consistently.
    """
    main_path = staging / "main_data.csv"
    if not main_path.is_file():
        main_path = staging / "pathway_members.csv"
    if not main_path.is_file():
        # Phase 4b NO_DATA (ADR-011): neither primary file exists — the
        # empty-table package must validate in NO_DATA mode, not crash on a
        # missing file. ``no_primary`` signals the mode and ``main_rows``
        # stays ``[]``; every check that dereferences ``main_rows`` must be
        # safe with an empty list (the main-table checks are skipped entirely
        # by ``validate_package`` in this mode).
        main_rows: list[dict[str, str]] = []
        no_primary = True
        main_path = staging / "main_data.csv"
    else:
        main_rows = read_csv(main_path)
        no_primary = False
    dataset_rows = read_csv(staging / "dataset_catalog.csv")
    dataset_ids = {row["dataset_id"] for row in dataset_rows}
    datasets_by_id = {row["dataset_id"]: row for row in dataset_rows}
    sample_rows = read_csv(staging / "sample_metadata.csv")
    sample_ids = {row["sample_id"] for row in sample_rows}
    samples_by_id = {row["sample_id"]: row for row in sample_rows}
    source_list_rows = read_csv(staging / "source_list.csv")
    source_ids = {row["source_id"] for row in source_list_rows}
    sources_by_id = {row["source_id"]: row for row in source_list_rows}
    reactome_rows = bool(main_rows) and "pathway_id" in main_rows[0]
    asset_rows = read_csv(staging / "source_assets.csv")
    asset_ids = {row["asset_id"] for row in asset_rows}
    assets_by_id = {row["asset_id"]: row for row in asset_rows}
    download_rows = read_csv(staging / "download_log.csv")
    attempts_by_id = {row["attempt_id"]: row for row in download_rows}
    described = {
        row["field_name"] for row in read_csv(staging / "field_descriptions.csv")
    }
    source_rel_base = compute_source_rel_base(source_path)
    reactome_source_file = (
        source_path.name[:-3]
        if source_path.suffix.lower() == ".gz"
        else source_path.name
    )
    return ValidationContext(
        staging=staging,
        source_path=source_path,
        report_path=report_path,
        max_lineage_checks=max_lineage_checks,
        main_path=main_path,
        main_rows=main_rows,
        dataset_rows=dataset_rows,
        dataset_ids=dataset_ids,
        datasets_by_id=datasets_by_id,
        sample_rows=sample_rows,
        sample_ids=sample_ids,
        samples_by_id=samples_by_id,
        source_list_rows=source_list_rows,
        source_ids=source_ids,
        sources_by_id=sources_by_id,
        asset_rows=asset_rows,
        asset_ids=asset_ids,
        assets_by_id=assets_by_id,
        download_rows=download_rows,
        attempts_by_id=attempts_by_id,
        described=described,
        reactome_rows=reactome_rows,
        source_rel_base=source_rel_base,
        no_primary=no_primary,
        reactome_source_file=reactome_source_file,
    )
