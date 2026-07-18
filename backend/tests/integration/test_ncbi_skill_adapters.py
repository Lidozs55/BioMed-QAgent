from __future__ import annotations

import json
from pathlib import Path
from typing import cast

import app.skills.builtin.acquisition.geo as geo_module
import httpx
import pytest
from app.agent_loop.context import ProgressEmitter, RunContext
from app.domain.contracts import StageName
from app.integrations.ncbi.factory import NcbiServices
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

        pubmed = json.loads(
            await search_pubmed_adapter(context, "34180400[PMID]", 1, services=services)
        )
        geo = json.loads(
            await search_geo_adapter(
                context, "GSE178352[Accession]", 20, services=services
            )
        )
        described = json.loads(
            await describe_geo_adapter(context, "GSE178352", services=services)
        )

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
            return httpx.Response(
                200, content=listing, headers={"Content-Type": "text/html"}
            )
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
        payload = json.loads(
            await download_geo_adapter(
                context,
                "GSE178352",
                "suppl",
                services=services,
                max_size_mb=1,
            )
        )

    assert payload["asset"]["data_level"] == "repository_processed"
    relative_path = payload["asset"]["relative_path"]
    downloaded = context.work_dir.root / relative_path
    assert downloaded.name == "GSE178352_tximportCounts.txt.gz"
    assert downloaded.read_bytes() == compressed
    assert not downloaded.with_suffix("").exists()
    assert context.raw_assets == [str(downloaded)]


@pytest.mark.asyncio
async def test_download_geo_retries_transient_listing_timeout(tmp_path: Path) -> None:
    compressed = b"retry download bytes"
    listing = (FIXTURE_DIR / "geo_suppl_listing.html").read_bytes()
    listing_calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal listing_calls
        if request.url.path.endswith("/suppl/"):
            listing_calls += 1
            if listing_calls == 1:
                raise httpx.ConnectTimeout("transient", request=request)
            return httpx.Response(200, content=listing)
        return httpx.Response(
            200,
            content=compressed,
            headers={"Content-Length": str(len(compressed))},
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        services = NcbiServices(
            eutils=FixtureNcbiClient(),
            http=http,
            cache=ContentCache(tmp_path / "cache"),
        )
        payload = json.loads(
            await download_geo_adapter(
                run_context(tmp_path),
                "GSE178352",
                "suppl",
                services=services,
                max_size_mb=1,
            )
        )

    assert listing_calls == 2
    assert payload["asset"]["size_bytes"] == len(compressed)


@pytest.mark.asyncio
async def test_geo_listing_retries_429_and_5xx_and_respects_retry_after(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    listing = (FIXTURE_DIR / "geo_suppl_listing.html").read_bytes()
    compressed = b"bounded retry bytes"
    listing_calls = 0
    sleeps: list[float] = []

    async def fake_sleep(delay: float) -> None:
        sleeps.append(delay)

    monkeypatch.setattr(geo_module.asyncio, "sleep", fake_sleep)

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal listing_calls
        if request.url.path.endswith("/suppl/"):
            listing_calls += 1
            if listing_calls == 1:
                return httpx.Response(429, headers={"Retry-After": "2"})
            if listing_calls == 2:
                return httpx.Response(503)
            return httpx.Response(200, content=listing)
        return httpx.Response(
            200,
            content=compressed,
            headers={"Content-Length": str(len(compressed))},
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        services = NcbiServices(
            eutils=FixtureNcbiClient(),
            http=http,
            cache=ContentCache(tmp_path / "cache"),
        )
        payload = json.loads(
            await download_geo_adapter(
                run_context(tmp_path), "GSE178352", "suppl", services=services
            )
        )

    assert listing_calls == 3
    assert sleeps == [2.0, 0.5]
    assert payload["asset"]["size_bytes"] == len(compressed)


@pytest.mark.asyncio
async def test_geo_listing_retry_is_bounded() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(503, request=request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        with pytest.raises(httpx.HTTPStatusError):
            await geo_module._get_geo_listing(http, "https://ftp.ncbi.nlm.nih.gov/x")

    assert calls == 3


@pytest.mark.asyncio
async def test_discovery_skills_emit_progress_with_record_counts(
    tmp_path: Path,
) -> None:
    """PubMed/GEO discovery Skills must emit_progress(discovered_records).

    Regression guard for docs/REVIEW_2026-07-18.md §4 — without this, the
    frontend's Agent-mode stage progress section stays empty.
    """
    captured: list[tuple[StageName, str, int, int | None, dict[str, object]]] = []

    async def emitter(
        stage: StageName,
        kind: str,
        current: int,
        total: int | None,
        detail: dict[str, object],
    ) -> None:
        captured.append((stage, kind, current, total, detail))

    client = FixtureNcbiClient()
    async with httpx.AsyncClient() as http:
        services = NcbiServices(
            eutils=client,
            http=http,
            cache=ContentCache(tmp_path / "cache"),
        )
        context = run_context(tmp_path)
        context.bind_progress_emitter(cast(ProgressEmitter, emitter))

        await search_pubmed_adapter(context, "34180400[PMID]", 1, services=services)
        await search_geo_adapter(
            context, "GSE178352[Accession]", 20, services=services
        )

    assert len(captured) == 2
    pubmed_stage, pubmed_kind, pubmed_current, pubmed_total, pubmed_detail = captured[0]
    assert pubmed_stage is StageName.DISCOVERY
    assert pubmed_kind == "discovered_records"
    assert pubmed_current == 1
    assert pubmed_total == 1
    assert pubmed_detail["source"] == "pubmed"

    geo_stage, geo_kind, geo_current, geo_total, geo_detail = captured[1]
    assert geo_stage is StageName.DISCOVERY
    assert geo_kind == "discovered_records"
    assert geo_current == 1
    assert geo_detail["source"] == "geo"


@pytest.mark.asyncio
async def test_download_geo_skill_emits_progress_with_bytes(tmp_path: Path) -> None:
    """download_geo_adapter must emit_progress(downloaded_bytes)."""
    captured: list[tuple[StageName, str, int, int | None, dict[str, object]]] = []

    async def emitter(
        stage: StageName,
        kind: str,
        current: int,
        total: int | None,
        detail: dict[str, object],
    ) -> None:
        captured.append((stage, kind, current, total, detail))

    compressed = b"progress download bytes"
    listing = (FIXTURE_DIR / "geo_suppl_listing.html").read_bytes()

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/suppl/"):
            return httpx.Response(200, content=listing)
        return httpx.Response(
            200,
            content=compressed,
            headers={"Content-Length": str(len(compressed))},
        )

    client = FixtureNcbiClient()
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        services = NcbiServices(
            eutils=client,
            http=http,
            cache=ContentCache(tmp_path / "cache"),
        )
        context = run_context(tmp_path)
        context.bind_progress_emitter(cast(ProgressEmitter, emitter))
        await download_geo_adapter(
            context, "GSE178352", "suppl", services=services, max_size_mb=1
        )

    assert len(captured) == 1
    stage, kind, current, _total, detail = captured[0]
    assert stage is StageName.ACQUISITION
    assert kind == "downloaded_bytes"
    assert current == len(compressed)
    assert detail["accession"] == "GSE178352"


@pytest.mark.asyncio
async def test_emit_progress_is_noop_without_bound_emitter(tmp_path: Path) -> None:
    """Skills must remain callable when no emitter is bound (e.g. unit tests)."""
    client = FixtureNcbiClient()
    async with httpx.AsyncClient() as http:
        services = NcbiServices(
            eutils=client,
            http=http,
            cache=ContentCache(tmp_path / "cache"),
        )
        context = run_context(tmp_path)
        # No bind_progress_emitter call — emit_progress must be a no-op.
        payload = json.loads(
            await search_pubmed_adapter(context, "34180400[PMID]", 1, services=services)
        )

    assert payload["records"][0]["pmid"] == "34180400"
