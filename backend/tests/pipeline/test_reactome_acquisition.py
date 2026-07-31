from __future__ import annotations

import asyncio
import hashlib
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest
from app.domain.contracts import Database, DatasetSelection, QuerySpecification, TaskSpecification
from app.pipeline.stages import acquisition, discovery
from app.pipeline.stages.base import StageContext
from app.tools.workdir import create_task_workdir

_FIXTURE_DIR = Path(__file__).parents[1] / "fixtures" / "reactome"


def _context(tmp_path: Path, mode: str, specification: TaskSpecification) -> StageContext:
    return StageContext(
        task_id="reactome_test",
        workdir=create_task_workdir("reactome_test", base_dir=str(tmp_path / "tasks")),
        fixture_dir=_FIXTURE_DIR,
        topic=specification.topic,
        started_at=datetime.now(UTC),
        mode=mode,
        databases=["reactome"],
        specification=specification,
    )


def _specification() -> TaskSpecification:
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


def test_reactome_discovery_builds_explicit_source_record(tmp_path: Path) -> None:
    result = discovery.run_discovery(_context(tmp_path, "fixture", _specification()))

    output = result.output
    assert len(output.sources) == 1
    assert output.sources[0].database is Database.REACTOME
    assert output.sources[0].accession == "R-HSA-199420"
    assert output.sources[0].url == (
        "https://reactome.org/ContentService/data/participants/R-HSA-199420"
    )
    assert output.geo is None
    assert output.literature is None


def test_reactome_fixture_acquisition_reads_participants_fixture(tmp_path: Path) -> None:
    result = acquisition.run_acquisition(_context(tmp_path, "fixture", _specification()), datetime.now(UTC))

    payload = (_FIXTURE_DIR / "pathway_participants.tsv").read_bytes()
    output = result.output
    assert output.source_assets[0].sha256 == hashlib.sha256(payload).hexdigest()
    assert output.source_assets[0].source_id == output.download_attempts[0].source_id
    assert output.download_attempts[0].url.endswith("/participants/R-HSA-199420")
    assert output.source_path.read_bytes() == payload


@pytest.mark.parametrize(
    ("status_code", "content", "content_type"),
    [
        (200, b"{\"unexpected\": true}", "application/json"),
        (200, b"[]", "application/json"),
        (200, b"[{\"displayName\": \"missing id\"}]", "application/json"),
        (200, b"", "application/json"),
        (500, b"server error", "text/plain"),
    ],
)
def test_reactome_live_acquisition_rejects_invalid_content_service_response(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    status_code: int,
    content: bytes,
    content_type: str,
) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(status_code, content=content, headers={"Content-Type": content_type})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(acquisition.httpx, "AsyncClient", lambda: client)
    context = _context(tmp_path, "live", _specification())
    try:
        with pytest.raises(RuntimeError, match="live Reactome download failed"):
            acquisition.run_acquisition(context, datetime.now(UTC))
    finally:
        asyncio.run(client.aclose())

    assert requests[0].headers["accept"] == "application/json"
    assert not list(context.workdir.source_assets.glob("**/*.json"))


def test_reactome_live_acquisition_uses_content_service_and_cache(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = b"[{\"stId\": \"R-HSA-109581\", \"displayName\": \"Apoptosis signaling\"}]"
    requests: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(str(request.url))
        return httpx.Response(200, content=payload, headers={"Content-Type": "application/json"})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(acquisition.httpx, "AsyncClient", lambda: client)
    try:
        result = acquisition.run_acquisition(_context(tmp_path, "live", _specification()), datetime.now(UTC))
    finally:
        asyncio.run(client.aclose())

    output = result.output
    assert requests == [
        "https://reactome.org/ContentService/data/participants/R-HSA-199420"
    ]
    assert output.source_assets[0].size_bytes == len(payload)
    assert output.download_attempts[0].status.value == "succeeded"


def test_reactome_discovery_rejects_mixed_sources(tmp_path: Path) -> None:
    specification = _specification().model_copy(
        update={
            "queries": [
                QuerySpecification(
                    query_id="query_pubmed_1",
                    database=Database.PUBMED,
                    query="12345678[PMID]",
                    generated_by="agent",
                    purpose="mixed source regression",
                    order=1,
                )
            ]
        }
    )

    with pytest.raises(ValueError, match="Reactome cannot be combined"):
        discovery.run_discovery(_context(tmp_path, "fixture", specification))


def test_reactome_discovery_rejects_multiple_dataset_selections(tmp_path: Path) -> None:
    specification = _specification().model_copy(
        update={
            "datasets": [
                *_specification().datasets,
                DatasetSelection(
                    dataset_id="ds_reactome_r-hsa-109581",
                    database=Database.REACTOME,
                    accession="R-HSA-109581",
                    reason="second explicit pathway",
                    data_type="pathway-participants",
                ),
            ]
        }
    )

    with pytest.raises(ValueError, match="exactly one"):
        discovery.run_discovery(_context(tmp_path, "fixture", specification))


def test_reactome_only_acquisition_does_not_fallback_to_geo(tmp_path: Path) -> None:
    result = acquisition.run_acquisition(
        _context(tmp_path, "fixture", _specification()), datetime.now(UTC)
    )

    assert all(
        attempt.url.startswith("https://reactome.org/")
        for attempt in result.output.download_attempts
    )
