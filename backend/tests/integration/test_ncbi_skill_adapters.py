from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from app.agent_loop.context import RunContext
from app.skills.builtin.acquisition.geo import (
    describe_geo_adapter,
    download_geo_adapter,
    search_geo,
    search_geo_adapter,
)
from app.skills.builtin.discovery.pubmed import (
    search_pubmed,
    search_pubmed_adapter,
)
from app.integrations.ncbi.factory import NcbiServices
from app.tools.content_cache import ContentCache
from app.tools.workdir import create_task_workdir


FIXTURE_DIR = Path(__file__).parents[1] / "fixtures" / "ncbi" / "gse178352"


class FixtureNcbiClient:
    def __init__(self) -> None:
        self.geo_summary_ids: list[str] = []

    async def esearch(self, *, db: str, term: str, retmax: int) -> bytes:
        name = "pubmed_esearch.json" if db == "pubmed" else "geo_esearch.json"
        return (FIXTURE_DIR / name).read_bytes()

    async def esummary(self, *, db: str, ids: list[str]) -> bytes:
        assert db == "gds"
        self.geo_summary_ids.extend(ids)
        return (FIXTURE_DIR / "geo_esummary.json").read_bytes()

    async def efetch(self, *, db: str, ids: list[str], retmode: str) -> bytes:
        assert (db, ids, retmode) == ("pubmed", ["34180400"], "xml")
        return (FIXTURE_DIR / "pubmed_34180400.xml").read_bytes()


def run_context(tmp_path: Path) -> RunContext:
    context = RunContext(task_id="adapter_fixture")
    context._work_dir = create_task_workdir(  # noqa: SLF001 - injected test seam
        "adapter_fixture", base_dir=str(tmp_path / "tasks")
    )
    return context


@pytest.mark.asyncio
async def test_pubmed_and_geo_discovery_adapters_use_typed_services(
    tmp_path: Path,
) -> None:
    client = FixtureNcbiClient()
    async with httpx.AsyncClient() as http:
        services = NcbiServices(
            eutils=client,
            http=http,
            cache=ContentCache(tmp_path / "cache"),
        )
        context = run_context(tmp_path)

        pubmed = json.loads(await search_pubmed_adapter(
            context, "34180400[PMID]", 1, services=services
        ))
        geo = json.loads(await search_geo_adapter(
            context, "GSE178352[Accession]", 20, services=services
        ))
        described = json.loads(await describe_geo_adapter(
            context, "GSE178352", services=services
        ))

    assert search_pubmed.name == "search_pubmed"
    assert search_geo.name == "search_geo"
    assert pubmed["records"][0]["pmid"] == "34180400"
    assert isinstance(pubmed["records"][0]["authors"], str)
    assert pubmed["records"][0]["is_open_access"] is True
    assert "pub_date" in pubmed["records"][0]
    assert geo["accessions"] == ["GSE178352"]
    assert "200178352" not in geo["accessions"]
    assert geo["records"][0]["platform_count"] == 1
    assert geo["records"][0]["pubmed_id"] == "34180400"
    assert described["accession"] == "GSE178352"
    assert described["sample_count"] == 12
    assert described["platforms"] == [{"id": "GPL24676", "title": "", "organism": ""}]
    assert client.geo_summary_ids.count("200178352") == 2
    assert all(value.isdigit() for value in client.geo_summary_ids)
    assert context.query_log[0]["status"] == "completed"


@pytest.mark.asyncio
async def test_download_geo_returns_compressed_repository_processed_asset(
    tmp_path: Path,
) -> None:
    compressed = b"gzip bytes stay compressed"
    listing = (FIXTURE_DIR / "geo_suppl_listing.html").read_bytes()

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/suppl/"):
            return httpx.Response(200, content=listing, headers={"Content-Type": "text/html"})
        assert request.url.path.endswith("GSE178352_tximportCounts.txt.gz")
        return httpx.Response(
            200,
            content=compressed,
            headers={
                "Content-Length": str(len(compressed)),
                "Content-Type": "application/gzip",
            },
        )

    client = FixtureNcbiClient()
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        services = NcbiServices(
            eutils=client,
            http=http,
            cache=ContentCache(tmp_path / "cache"),
        )
        context = run_context(tmp_path)
        payload = json.loads(await download_geo_adapter(
            context,
            "GSE178352",
            "suppl",
            services=services,
            max_size_mb=1,
        ))

    assert payload["asset"]["data_level"] == "repository_processed"
    relative_path = payload["asset"]["relative_path"]
    downloaded = context.work_dir.root / relative_path
    assert downloaded.name == "GSE178352_tximportCounts.txt.gz"
    assert downloaded.read_bytes() == compressed
    assert not downloaded.with_suffix("").exists()
    assert context.raw_assets == [str(downloaded)]
