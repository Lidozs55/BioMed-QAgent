from __future__ import annotations

import asyncio
import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest
from app.domain.contracts import Database, DatasetSelection, TaskSpecification
from app.pipeline.stages import acquisition
from app.pipeline.stages.base import StageContext
from app.tools.workdir import create_task_workdir


def test_gdc_live_acquisition_queries_files_and_downloads_verified_asset(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = b"gene_id\tS1\nTP53\t1.5\n"
    checksum = hashlib.sha256(payload).hexdigest()
    requests: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(str(request.url))
        if request.url.path == "/files":
            return httpx.Response(
                200,
                json={
                    "data": {
                        "hits": [
                            {
                                "file_id": "file-expression-1",
                                "file_name": "expression.tsv",
                                "data_format": "TSV",
                                "md5sum": "not-a-sha256",
                            }
                        ]
                    }
                },
            )
        if request.url.path == "/data/file-expression-1":
            return httpx.Response(200, content=payload)
        return httpx.Response(404)

    real_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(acquisition.httpx, "AsyncClient", lambda: real_client)
    workdir = create_task_workdir("gdc_live", base_dir=str(tmp_path / "tasks"))
    specification = TaskSpecification(
        topic="GDC live contract",
        datasets=[
            DatasetSelection(
                dataset_id="ds_gdc_live",
                database=Database.GDC,
                accession="TCGA-BRCA",
                source_id="",
                reason="explicit project",
                data_type="gene-expression",
            )
        ],
    )
    recorded_attempts = []
    context = StageContext(
        task_id="gdc_live",
        workdir=workdir,
        fixture_dir=tmp_path,
        topic=specification.topic,
        started_at=datetime.now(UTC),
        mode="live",
        databases=["gdc"],
        specification=specification,
        download_attempt_recorder=recorded_attempts.append,
    )

    try:
        result = acquisition.run_acquisition(context, datetime.now(UTC))
    finally:
        asyncio.run(real_client.aclose())

    output = result.output
    assert len(output.source_assets) == 1
    assert output.source_assets[0].sha256 == checksum
    assert output.download_attempts[0].status.value == "succeeded"
    assert requests[0].startswith("https://api.gdc.cancer.gov/files?")
    assert requests[1] == "https://api.gdc.cancer.gov/data/file-expression-1"
    assert output.source_assets[0].source_id == output.download_attempts[0].source_id
    assert recorded_attempts == output.download_attempts
    filters = json.loads(httpx.URL(requests[0]).params["filters"])
    assert filters["content"] == [
        {
            "op": "=",
            "content": {
                "field": "cases.project.project_id",
                "value": "TCGA-BRCA",
            },
        },
        {
            "op": "=",
            "content": {
                "field": "data_type",
                "value": "Gene Expression Quantification",
            },
        },
        {
            "op": "=",
            "content": {"field": "data_format", "value": "TSV"},
        },
    ]


def test_gdc_live_clinical_fails_before_opening_http_client(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def unexpected_client():
        raise AssertionError("HTTP must not be used for unsupported live clinical data")

    monkeypatch.setattr(acquisition.httpx, "AsyncClient", unexpected_client)
    workdir = create_task_workdir("gdc_live_clinical", base_dir=str(tmp_path / "tasks"))
    specification = TaskSpecification(
        topic="GDC live clinical contract",
        datasets=[
            DatasetSelection(
                dataset_id="ds_gdc_live_clinical",
                database=Database.GDC,
                accession="TCGA-BRCA",
                source_id="",
                reason="explicit project",
                data_type="clinical",
            )
        ],
    )
    context = StageContext(
        task_id="gdc_live_clinical",
        workdir=workdir,
        fixture_dir=tmp_path,
        topic=specification.topic,
        started_at=datetime.now(UTC),
        mode="live",
        databases=["gdc"],
        specification=specification,
    )

    with pytest.raises(ValueError, match="live clinical is not supported"):
        acquisition.run_acquisition(context, datetime.now(UTC))
