"""Offline end-to-end pipeline for the approved PMID/GSE fixture."""

from __future__ import annotations

import csv
import gzip
import hashlib
import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol

from app.domain.contracts import (
    ArtifactManifestEntry,
    DataLevel,
    Database,
    DatasetSelection,
    QuerySpecification,
    RequestedOutput,
    RunManifest,
    StageAttempt,
    StageCompletedPayload,
    StageName,
    StageStartedPayload,
    AttemptStatus,
    ArtifactProducedPayload,
    PlanReadyPayload,
    TaskCompletedPayload,
    TaskCreatedPayload,
    SourceAsset,
    SourceRecord,
    TaskRequest,
    TaskSpecification,
    TaskState,
    ValidationSummary,
    asset_id_from_sha256,
    make_dataset_id,
    make_source_id,
    build_event,
)
from app.integrations.ncbi.parsers import parse_geo_esummary, parse_pubmed_xml
from app.pipeline.processing.geo_tximport import (
    _OUTPUT_COLUMNS,
    parse_geo_soft_samples,
    process_geo_tximport_counts,
)
from app.tools.workdir import create_task_workdir


_ARTIFACT_COLUMNS = {
    "literature.csv": [
        "source_id",
        "pmid",
        "pmcid",
        "doi",
        "title",
        "authors",
        "journal",
        "published_at",
        "source_url",
        "retrieved_at",
    ],
    "dataset_catalog.csv": [
        "dataset_id",
        "source_id",
        "database",
        "accession",
        "title",
        "organism",
        "experiment_type",
        "sample_count",
        "platform_ids",
        "related_pmids",
        "source_url",
        "retrieved_at",
    ],
    "sample_metadata.csv": [
        "sample_id",
        "dataset_id",
        "source_id",
        "source_sample_alias",
        "cell_line_raw",
        "cell_line_canonical",
        "normalization_rule",
        "treatment",
        "replicate",
        "organism",
        "source_url",
    ],
    "field_descriptions.csv": [
        "field_name",
        "data_type",
        "description",
        "unit",
        "nullable",
        "source",
        "example",
    ],
    "field_mapping.csv": [
        "dataset_id",
        "raw_field",
        "canonical_field",
        "conversion",
        "confidence",
        "notes",
    ],
    "source_list.csv": [
        "source_id",
        "database",
        "accession",
        "url",
        "title",
        "retrieved_at",
    ],
    "source_relations.csv": [
        "relation_id",
        "from_source_id",
        "to_source_id",
        "relation_type",
        "evidence_type",
        "evidence_value",
        "evidence_url",
    ],
    "source_assets.csv": [
        "asset_id",
        "source_id",
        "successful_attempt_id",
        "data_level",
        "relative_path",
        "size_bytes",
        "sha256",
        "media_type",
        "schema_version",
    ],
    "download_log.csv": [
        "attempt_id",
        "source_id",
        "url",
        "status",
        "bytes_received",
        "error_code",
        "error_message",
        "started_at",
        "finished_at",
    ],
    "processing_log.csv": [
        "step_id",
        "stage_attempt_id",
        "stage",
        "operation",
        "input_refs",
        "output_refs",
        "tool_version",
        "rows_before",
        "rows_after",
        "parameters",
        "status",
        "started_at",
        "finished_at",
        "warnings",
    ],
    "quality_report.csv": [
        "check_id",
        "scope",
        "check_name",
        "status",
        "checked_count",
        "failed_count",
        "details",
    ],
    "warnings.csv": [
        "warning_id",
        "severity",
        "stage",
        "code",
        "message",
        "source_id",
        "asset_id",
        "record_id",
        "created_at",
    ],
}


class CancellationToken(Protocol):
    def is_set(self) -> bool: ...


class PipelineCancelledError(RuntimeError):
    """Raised at a fixture stage boundary after cooperative cancellation."""


def _check_cancelled(cancellation_requested: CancellationToken | None) -> None:
    if cancellation_requested is not None and cancellation_requested.is_set():
        raise PipelineCancelledError("fixture pipeline was cancelled")


def _write_csv(path: Path, columns: list[str], rows: list[dict[str, object]]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def _read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _digest_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _write_jsonl(path: Path, models: list[object]) -> None:
    path.write_text(
        "".join(model.model_dump_json() + "\n" for model in models),
        encoding="utf-8",
    )


def _validate_package(
    staging: Path,
    source_path: Path,
    report_path: Path,
) -> tuple[ValidationSummary, list[dict[str, object]]]:
    main_rows = _read_csv(staging / "main_data.csv")
    dataset_ids = {
        row["dataset_id"] for row in _read_csv(staging / "dataset_catalog.csv")
    }
    sample_rows = _read_csv(staging / "sample_metadata.csv")
    sample_ids = {row["sample_id"] for row in sample_rows}
    source_ids = {row["source_id"] for row in _read_csv(staging / "source_list.csv")}
    asset_rows = _read_csv(staging / "source_assets.csv")
    asset_ids = {row["asset_id"] for row in asset_rows}
    download_rows = _read_csv(staging / "download_log.csv")
    described = {
        row["field_name"] for row in _read_csv(staging / "field_descriptions.csv")
    }

    checks: list[dict[str, object]] = []
    reference_failures = sum(
        row["dataset_id"] not in dataset_ids
        or row["sample_id"] not in sample_ids
        or row["source_id"] not in source_ids
        or row["asset_id"] not in asset_ids
        for row in main_rows
    )
    checks.append(
        {
            "check_id": "foreign_keys",
            "scope": "main_data",
            "check_name": "foreign key closure",
            "status": "passed" if reference_failures == 0 else "failed",
            "checked_count": len(main_rows),
            "failed_count": reference_failures,
            "details": "",
        }
    )
    sample_reference_failures = sum(
        row["dataset_id"] not in dataset_ids or row["source_id"] not in source_ids
        for row in sample_rows
    )
    checks.append(
        {
            "check_id": "sample_foreign_keys",
            "scope": "sample_metadata",
            "check_name": "sample dataset and source closure",
            "status": "passed" if sample_reference_failures == 0 else "failed",
            "checked_count": len(sample_rows),
            "failed_count": sample_reference_failures,
            "details": "",
        }
    )
    successful_attempt_ids = {
        row["attempt_id"] for row in download_rows if row["status"] == "succeeded"
    }
    asset_failures = 0
    for row in asset_rows:
        asset_failures += (
            row["successful_attempt_id"] not in successful_attempt_ids
            or row["source_id"] not in source_ids
            or row["relative_path"]
            != source_path.relative_to(source_path.parents[1]).as_posix()
            or int(row["size_bytes"]) != source_path.stat().st_size
            or row["sha256"] != _sha256(source_path)
        )
    checks.append(
        {
            "check_id": "source_asset_integrity",
            "scope": "source_assets",
            "check_name": "source asset file, checksum, and successful attempt",
            "status": "passed" if asset_failures == 0 else "failed",
            "checked_count": len(asset_rows),
            "failed_count": asset_failures,
            "details": "",
        }
    )
    missing_fields = set(main_rows[0]) - described if main_rows else set()
    checks.append(
        {
            "check_id": "field_descriptions",
            "scope": "main_data",
            "check_name": "every field is described",
            "status": "passed" if not missing_fields else "failed",
            "checked_count": len(main_rows[0]) if main_rows else 0,
            "failed_count": len(missing_fields),
            "details": json.dumps(sorted(missing_fields)),
        }
    )

    with gzip.open(source_path, "rt", encoding="utf-8", newline="") as handle:
        source_lines = list(csv.reader(handle, delimiter="\t", quotechar='"'))
    lineage_failures = 0
    for row in main_rows:
        line_index = int(row["source_line_number"]) - 1
        column_index = int(row["source_column_index"])
        try:
            raw = source_lines[line_index][column_index]
        except (IndexError, ValueError):
            lineage_failures += 1
            continue
        if raw != row["source_raw_value"] or float(raw) != float(
            row["expression_value"]
        ):
            lineage_failures += 1
    checks.append(
        {
            "check_id": "source_value_lineage",
            "scope": "main_data",
            "check_name": "every pinned value matches its source locator",
            "status": "passed" if lineage_failures == 0 else "failed",
            "checked_count": len(main_rows),
            "failed_count": lineage_failures,
            "details": "",
        }
    )
    total_failed = sum(int(check["failed_count"]) for check in checks)
    report = {
        "schema_version": "1.0",
        "status": "valid" if total_failed == 0 else "invalid",
        "checks": checks,
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", "utf-8")
    return ValidationSummary(
        status=report["status"],
        checked_count=sum(int(check["checked_count"]) for check in checks),
        failed_count=total_failed,
        report_path=report_path.relative_to(report_path.parents[1]).as_posix(),
    ), checks


def run_pinned_fixture(
    *,
    task_id: str,
    base_dir: Path,
    fixture_dir: Path,
    topic: str = "breast cancer gene expression under Hsp70 inhibition",
    cancellation_requested: CancellationToken | None = None,
) -> RunManifest:
    started_at = datetime.now(timezone.utc)
    workdir = create_task_workdir(task_id, base_dir=str(base_dir))
    staging = workdir.staging_run("run_pinned_fixture")
    if any(staging.iterdir()):
        shutil.rmtree(staging)
        staging.mkdir(parents=True)
    _check_cancelled(cancellation_requested)

    fixture_manifest = json.loads((fixture_dir / "manifest.json").read_text("utf-8"))
    retrieved_at = datetime.fromisoformat(fixture_manifest["retrieved_at"])
    literature = parse_pubmed_xml((fixture_dir / "pubmed_34180400.xml").read_bytes())[0]
    geo = parse_geo_esummary((fixture_dir / "geo_esummary.json").read_bytes())[0]
    dataset_id = make_dataset_id(Database.GEO, geo.accession)
    pubmed_url = literature.source_url
    geo_url = f"https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc={geo.accession}"
    pubmed_source_id = make_source_id(Database.PUBMED, literature.pmid, pubmed_url)
    geo_source_id = make_source_id(Database.GEO, geo.accession, geo_url)
    _check_cancelled(cancellation_requested)

    compressed = gzip.compress(
        (fixture_dir / "tximport_counts_slice.tsv").read_bytes(), mtime=0
    )
    checksum = hashlib.sha256(compressed).hexdigest()
    source_path = workdir.source_assets / "GSE178352_tximportCounts.fixture.txt.gz"
    if source_path.exists():
        if _sha256(source_path) != checksum:
            raise FileExistsError(
                "fixture source asset already exists with different content"
            )
    else:
        with source_path.open("xb") as handle:
            handle.write(compressed)
            handle.flush()
            os.fsync(handle.fileno())
    attempt_id = "download_attempt_fixture_gse178352"
    source_asset = SourceAsset(
        asset_id=asset_id_from_sha256(checksum),
        kind="source",
        relative_path=source_path.relative_to(workdir.root).as_posix(),
        sha256=checksum,
        size_bytes=len(compressed),
        media_type="application/gzip",
        source_id=geo_source_id,
        successful_attempt_id=attempt_id,
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )
    _check_cancelled(cancellation_requested)
    parsed = process_geo_tximport_counts(
        source_asset=source_asset,
        dataset_id=dataset_id,
        workdir=workdir,
        soft_gzip=(fixture_dir / "gse178352_family.soft.gz").read_bytes(),
        logical_file="GSE178352_tximportCounts.txt",
    )
    shutil.copy2(
        workdir.root / parsed.file_asset.relative_path, staging / "main_data.csv"
    )
    _check_cancelled(cancellation_requested)

    sources = [
        SourceRecord(
            source_id=pubmed_source_id,
            database=Database.PUBMED,
            accession=literature.pmid,
            url=pubmed_url,
            title=literature.title,
            retrieved_at=retrieved_at,
        ),
        SourceRecord(
            source_id=geo_source_id,
            database=Database.GEO,
            accession=geo.accession,
            url=geo_url,
            title=geo.title,
            retrieved_at=retrieved_at,
        ),
    ]
    samples = parse_geo_soft_samples(
        (fixture_dir / "gse178352_family.soft.gz").read_bytes()
    )
    rows_by_file: dict[str, list[dict[str, object]]] = {
        "literature.csv": [
            {
                "source_id": pubmed_source_id,
                "pmid": literature.pmid,
                "pmcid": literature.pmcid or "",
                "doi": literature.doi or "",
                "title": literature.title,
                "authors": json.dumps(literature.authors),
                "journal": literature.journal,
                "published_at": literature.published_at.isoformat()
                if literature.published_at
                else "",
                "source_url": pubmed_url,
                "retrieved_at": retrieved_at.isoformat(),
            }
        ],
        "dataset_catalog.csv": [
            {
                "dataset_id": dataset_id,
                "source_id": geo_source_id,
                "database": "geo",
                "accession": geo.accession,
                "title": geo.title,
                "organism": geo.organism,
                "experiment_type": geo.experiment_type,
                "sample_count": geo.sample_count,
                "platform_ids": json.dumps(sorted(geo.platform_ids)),
                "related_pmids": json.dumps(sorted(geo.pubmed_ids)),
                "source_url": geo_url,
                "retrieved_at": retrieved_at.isoformat(),
            }
        ],
        "sample_metadata.csv": [
            {
                "sample_id": sample.sample_id,
                "dataset_id": dataset_id,
                "source_id": geo_source_id,
                "source_sample_alias": sample.source_alias,
                "cell_line_raw": sample.cell_line_raw,
                "cell_line_canonical": sample.cell_line_canonical,
                "normalization_rule": sample.normalization_rule,
                "treatment": sample.treatment,
                "replicate": sample.replicate,
                "organism": sample.organism,
                "source_url": geo_url,
            }
            for sample in samples
        ],
        "field_descriptions.csv": [
            {
                "field_name": field,
                "data_type": "string",
                "description": field.replace("_", " "),
                "unit": "estimated_count" if field == "expression_value" else "",
                "nullable": "true" if field == "gene_id_version" else "false",
                "source": "GSE178352_tximportCounts.txt",
                "example": "",
            }
            for field in _OUTPUT_COLUMNS
        ],
        "field_mapping.csv": [
            {
                "dataset_id": dataset_id,
                "raw_field": f"counts.{sample.source_alias}",
                "canonical_field": "expression_value",
                "conversion": "identity numeric parse",
                "confidence": "1.0",
                "notes": sample.sample_id,
            }
            for sample in samples
        ],
        "source_list.csv": [
            record.model_dump(mode="json", exclude={"schema_version"})
            for record in sources
        ],
        "source_relations.csv": [
            {
                "relation_id": "rel_pmid34180400_gse178352",
                "from_source_id": pubmed_source_id,
                "to_source_id": geo_source_id,
                "relation_type": "article_describes_dataset",
                "evidence_type": "geo_pubmed_id",
                "evidence_value": "34180400",
                "evidence_url": geo_url,
            }
        ],
        "source_assets.csv": [
            {
                "asset_id": source_asset.asset_id,
                "source_id": geo_source_id,
                "successful_attempt_id": attempt_id,
                "data_level": source_asset.data_level.value,
                "relative_path": source_asset.relative_path,
                "size_bytes": source_asset.size_bytes,
                "sha256": source_asset.sha256,
                "media_type": source_asset.media_type,
                "schema_version": source_asset.schema_version,
            }
        ],
        "download_log.csv": [
            {
                "attempt_id": attempt_id,
                "source_id": geo_source_id,
                "url": fixture_manifest["sources"]["tximport_counts"]["url"],
                "status": "succeeded",
                "bytes_received": len(compressed),
                "error_code": "",
                "error_message": "",
                "started_at": retrieved_at.isoformat(),
                "finished_at": retrieved_at.isoformat(),
            }
        ],
        "processing_log.csv": [
            {
                "step_id": "step_geo_tximport_counts_v1",
                "stage_attempt_id": "stage_processing_1",
                "stage": "processing",
                "operation": "parse_tximport_counts",
                "input_refs": json.dumps([source_asset.asset_id]),
                "output_refs": json.dumps([parsed.file_asset.asset_id]),
                "tool_version": "1.0.0",
                "rows_before": 4,
                "rows_after": parsed.row_count,
                "parameters": json.dumps({"measurement": "counts"}, sort_keys=True),
                "status": "succeeded",
                "started_at": started_at.isoformat(),
                "finished_at": datetime.now(timezone.utc).isoformat(),
                "warnings": "[]",
            }
        ],
        "warnings.csv": [],
    }
    for name, columns in _ARTIFACT_COLUMNS.items():
        if name != "quality_report.csv":
            _write_csv(staging / name, columns, rows_by_file.get(name, []))
    _write_csv(
        staging / "quality_report.csv", _ARTIFACT_COLUMNS["quality_report.csv"], []
    )
    _check_cancelled(cancellation_requested)

    validation, checks = _validate_package(
        staging, source_path, workdir.logs / "validation_report.json"
    )
    _write_csv(
        staging / "quality_report.csv", _ARTIFACT_COLUMNS["quality_report.csv"], checks
    )
    if validation.status != "valid":
        raise ValueError("pinned fixture failed validation")
    _check_cancelled(cancellation_requested)

    entries = []
    for path in sorted(staging.iterdir(), key=lambda item: item.name):
        checksum_value = _sha256(path)
        entries.append(
            ArtifactManifestEntry(
                artifact_id=f"artifact_{checksum_value[:32]}",
                name=path.name,
                relative_path=f"artifacts/{path.name}",
                media_type="text/csv",
                size_bytes=path.stat().st_size,
                sha256=checksum_value,
                generated_by_step_id="step_artifact_builder_v1",
            )
        )
    entries.sort(key=lambda entry: entry.artifact_id)
    specification = TaskSpecification(
        topic=topic,
        queries=[
            QuerySpecification(
                query_id="query_geo_1",
                database=Database.GEO,
                query="GSE178352[Accession]",
                generated_by="pipeline",
                purpose="pinned dataset",
                order=1,
            ),
            QuerySpecification(
                query_id="query_pubmed_1",
                database=Database.PUBMED,
                query="34180400[PMID]",
                generated_by="pipeline",
                purpose="pinned literature",
                order=2,
            ),
        ],
        datasets=[
            DatasetSelection(
                dataset_id=dataset_id,
                database=Database.GEO,
                accession=geo.accession,
                source_id=geo_source_id,
                reason="linked from PMID 34180400",
            )
        ],
        requested_outputs=[
            RequestedOutput.MAIN_DATA,
            RequestedOutput.LITERATURE,
            RequestedOutput.DATASET_CATALOG,
            RequestedOutput.SAMPLE_METADATA,
        ],
    )
    finished_stages_at = datetime.now(timezone.utc)
    stage_attempts = [
        StageAttempt(
            stage_attempt_id=f"stage_attempt_{stage.value}_1",
            task_id=task_id,
            stage=stage,
            attempt=1,
            input_digest=_digest_text(f"{task_id}:{stage.value}:input"),
            parameter_digest=_digest_text(f"{task_id}:{stage.value}:parameters"),
            output_digest=_digest_text(f"{task_id}:{stage.value}:output"),
            status=AttemptStatus.SUCCEEDED,
            started_at=started_at,
            finished_at=finished_stages_at,
        )
        for stage in (
            StageName.DISCOVERY,
            StageName.ACQUISITION,
            StageName.PROCESSING,
            StageName.ARTIFACT_BUILD,
            StageName.VALIDATION,
        )
    ]
    _write_jsonl(workdir.logs / "stage_attempts.jsonl", stage_attempts)
    manifest = RunManifest(
        task_id=task_id,
        id_generation_version="1.0",
        request=TaskRequest(topic=specification.topic),
        specification=specification,
        task_state=TaskState.COMPLETED,
        stage_attempt_ids=sorted(
            attempt.stage_attempt_id for attempt in stage_attempts
        ),
        source_ids=sorted([pubmed_source_id, geo_source_id]),
        artifacts=entries,
        validation=validation,
        pipeline_version="0.1.0",
        model_name=None,
        started_at=started_at,
        finished_at=datetime.now(timezone.utc),
    )
    (staging / "run_manifest.json").write_text(
        manifest.model_dump_json(indent=2) + "\n", "utf-8"
    )
    if any(workdir.artifacts.iterdir()):
        raise FileExistsError("artifacts directory is not empty")
    _check_cancelled(cancellation_requested)
    workdir.artifacts.rmdir()
    os.replace(staging, workdir.artifacts)

    sequence = 1
    events = [
        build_event(
            task_id=task_id,
            sequence=sequence,
            payload=TaskCreatedPayload(topic=specification.topic),
            timestamp=started_at,
        )
    ]
    sequence += 1
    events.append(
        build_event(
            task_id=task_id,
            sequence=sequence,
            payload=PlanReadyPayload(specification=specification),
            timestamp=started_at,
        )
    )
    sequence += 1
    for attempt in stage_attempts:
        events.append(
            build_event(
                task_id=task_id,
                sequence=sequence,
                stage_attempt_id=attempt.stage_attempt_id,
                payload=StageStartedPayload(
                    stage=attempt.stage, attempt=attempt.attempt
                ),
                timestamp=attempt.started_at,
            )
        )
        sequence += 1
        events.append(
            build_event(
                task_id=task_id,
                sequence=sequence,
                stage_attempt_id=attempt.stage_attempt_id,
                payload=StageCompletedPayload(
                    stage=attempt.stage,
                    status=AttemptStatus.SUCCEEDED,
                    output_digest=attempt.output_digest or "",
                ),
                timestamp=attempt.finished_at,
            )
        )
        sequence += 1
    for entry in entries:
        events.append(
            build_event(
                task_id=task_id,
                sequence=sequence,
                payload=ArtifactProducedPayload(artifact=entry),
                timestamp=manifest.finished_at,
            )
        )
        sequence += 1
    events.append(
        build_event(
            task_id=task_id,
            sequence=sequence,
            payload=TaskCompletedPayload(validation=validation),
            timestamp=manifest.finished_at,
        )
    )
    _write_jsonl(workdir.logs / "events.jsonl", events)
    return manifest
