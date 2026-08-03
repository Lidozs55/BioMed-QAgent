"""Regression test: validation check list is identical before/after the split.

The former monolithic ``validation.py`` was split into a ``validation/``
package (checks_common, checks/, package, publish, runner). This test pins
the exact ``check_id`` sequence and per-check fields that ``_validate_package``
emits for both a GEO single-source package and a Reactome pathway package, so
any future reordering or accidental drop is caught immediately.

The golden lists below were captured from the original monolithic
``_validate_package`` before the split (see the task spec in AGENTS.md).
"""
from __future__ import annotations

import asyncio
from pathlib import Path

from app.domain.contracts import (
    Database,
    DatasetSelection,
    TaskSpecification,
)
from app.pipeline.runner import PipelineRunner
from app.pipeline.stages.validation import _validate_package
from app.pipeline.stages.validation.checks_common import ValidationContext

_GEO_FIXTURE = Path(__file__).parents[1] / "fixtures" / "ncbi" / "gse178352"
_REACTOME_FIXTURE = Path(__file__).parents[1] / "fixtures" / "reactome"

# Golden check_id sequence emitted by the original monolithic _validate_package.
_GEO_CHECK_IDS = [
    "source_relation_evidence",
    "main_data_nonempty",
    "core_data_existence",
    "foreign_keys",
    "sample_foreign_keys",
    "source_asset_integrity",
    "field_descriptions",
    "source_value_lineage",
    "warnings_metrics_consistency",
    "cleaning_report_consistency",
]

_REACTOME_CHECK_IDS = [
    "source_relation_evidence",
    "main_data_nonempty",
    "core_data_existence",
    "foreign_keys",
    "reactome_pathway_fields",
    "reactome_participant_fields",
    "reactome_source_foreign_keys",
    "reactome_asset_foreign_keys",
    "reactome_asset_source_consistency",
    "reactome_dataset_source_consistency",
    "reactome_pathway_dataset_consistency",
    "reactome_source_locator",
    "reactome_lineage_contract",
    "sample_foreign_keys",
    "source_asset_integrity",
    "field_descriptions",
    "source_value_lineage",
    "warnings_metrics_consistency",
    "cleaning_report_consistency",
]


def _geo_specification() -> TaskSpecification:
    return TaskSpecification(
        topic="GSE178352",
        datasets=[
            DatasetSelection(
                dataset_id="ds_gse178352",
                database=Database.GEO,
                accession="GSE178352",
                reason="explicit",
                source_id="src_geo_gse178352",
            )
        ],
    )


def _reactome_specification() -> TaskSpecification:
    return TaskSpecification(
        topic="Reactome apoptosis",
        datasets=[
            DatasetSelection(
                dataset_id="ds_reactome_r-hsa-199420",
                database=Database.REACTOME,
                accession="R-HSA-199420",
                reason="explicit pathway",
                data_type="pathway-participants",
            )
        ],
    )


def _build_staging(
    tmp_path: Path,
    task_id: str,
    fixture_dir: Path,
    specification: TaskSpecification,
    databases: list[str],
) -> tuple[Path, Path]:
    """Run the pipeline with deferred publication and return (staging, source_path)."""
    runner = PipelineRunner(
        task_id=task_id,
        base_dir=tmp_path / "tasks",
        fixture_dir=fixture_dir,
        topic=specification.topic,
        databases=databases,
        specification=specification,
        defer_publication=True,
    )
    manifest = asyncio.run(runner.run())
    assert manifest.task_state.value == "completed", manifest.model_dump_json()
    root = tmp_path / "tasks" / task_id
    staging = root / "staging" / runner.ctx.run_id
    source_path = next((root / "source_assets").glob("*"))
    return staging, source_path


def _assert_check_sequence(
    checks: list[dict[str, object]], expected_ids: list[str]
) -> None:
    """Assert the check_id sequence and required fields match exactly."""
    actual_ids = [str(check["check_id"]) for check in checks]
    assert actual_ids == expected_ids, (
        f"check_id sequence changed:\n"
        f"  expected: {expected_ids}\n"
        f"  actual:   {actual_ids}"
    )
    # Every check must carry the full quality_report schema.
    required_keys = {
        "check_id", "scope", "check_name", "status",
        "checked_count", "failed_count", "details",
    }
    for check in checks:
        assert required_keys <= set(check), (
            f"check {check['check_id']} missing keys: "
            f"{required_keys - set(check)}"
        )


def test_geo_package_check_list_matches_golden(tmp_path: Path) -> None:
    """GEO single-source package emits the exact golden check_id sequence."""
    staging, source_path = _build_staging(
        tmp_path,
        "task_geo_split_regression",
        _GEO_FIXTURE,
        _geo_specification(),
        ["pubmed", "geo"],
    )
    summary, checks = _validate_package(
        staging, source_path, tmp_path / "logs" / "validation_geo.json"
    )

    assert summary.status == "valid"
    assert summary.failed_count == 0
    _assert_check_sequence(checks, _GEO_CHECK_IDS)
    # Every check passed for a valid fixture package.
    for check in checks:
        assert check["status"] == "passed", (
            f"{check['check_id']} unexpectedly failed"
        )


def test_reactome_package_check_list_matches_golden(tmp_path: Path) -> None:
    """Reactome pathway package emits the exact golden check_id sequence."""
    staging, source_path = _build_staging(
        tmp_path,
        "task_reactome_split_regression",
        _REACTOME_FIXTURE,
        _reactome_specification(),
        ["reactome"],
    )
    summary, checks = _validate_package(
        staging, source_path, tmp_path / "logs" / "validation_reactome.json"
    )

    assert summary.status == "valid"
    assert summary.failed_count == 0
    _assert_check_sequence(checks, _REACTOME_CHECK_IDS)
    for check in checks:
        assert check["status"] == "passed", (
            f"{check['check_id']} unexpectedly failed"
        )


def test_validation_context_carries_shared_state(tmp_path: Path) -> None:
    """ValidationContext loads every CSV and derived lookup the checks share."""
    from app.pipeline.stages.validation.checks_common import load_validation_context

    staging, source_path = _build_staging(
        tmp_path,
        "task_context_regression",
        _GEO_FIXTURE,
        _geo_specification(),
        ["pubmed", "geo"],
    )
    ctx = load_validation_context(
        staging, source_path, tmp_path / "logs" / "ctx.json"
    )

    assert isinstance(ctx, ValidationContext)
    # Upfront-loaded CSV rows.
    assert ctx.main_rows, "main_rows must be loaded"
    assert ctx.dataset_rows, "dataset_rows must be loaded"
    assert ctx.sample_rows, "sample_rows must be loaded"
    assert ctx.source_list_rows, "source_list_rows must be loaded"
    assert ctx.asset_rows, "asset_rows must be loaded"
    assert ctx.download_rows, "download_rows must be loaded"
    # Derived lookups.
    assert ctx.dataset_ids, "dataset_ids must be derived"
    assert ctx.datasets_by_id, "datasets_by_id must be derived"
    assert ctx.sample_ids, "sample_ids must be derived"
    assert ctx.samples_by_id, "samples_by_id must be derived"
    assert ctx.source_ids, "source_ids must be derived"
    assert ctx.sources_by_id, "sources_by_id must be derived"
    assert ctx.asset_ids, "asset_ids must be derived"
    assert ctx.assets_by_id, "assets_by_id must be derived"
    assert ctx.attempts_by_id, "attempts_by_id must be derived"
    assert ctx.described, "described fields must be derived"
    # Reactome flag is False for a GEO package.
    assert ctx.reactome_rows is False
    # source_rel_base resolves to the task root (parent of source_assets/).
    assert ctx.source_rel_base == source_path.parents[1]
    # reactome_source_file is derived from source_path name.
    assert ctx.reactome_source_file


def test_validate_package_alias_matches_validate_package() -> None:
    """The backward-compat alias _validate_package is the same callable."""
    from app.pipeline.stages.validation import _validate_package as alias
    from app.pipeline.stages.validation.package import validate_package

    assert alias is validate_package
