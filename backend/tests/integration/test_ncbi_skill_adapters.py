from __future__ import annotations

import hashlib
import inspect
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import cast

import app.skills.builtin.acquisition.geo as geo_module
import app.skills.builtin.discovery.pubmed as pubmed_module
import httpx
import pytest
from app.agent_loop.context import ProgressEmitter, RunContext
from app.domain.contracts import Database, DataLevel, SourceRecord, StageName
from app.integrations.ncbi.factory import NcbiServices
from app.skills.builtin.acquisition.geo import (
    describe_geo_adapter,
    download_geo_adapter,
    download_geo_platform_annotation_adapter,
    search_geo,
    search_geo_adapter,
)
from app.skills.builtin.discovery.pubmed import (
    download_supplementary_adapter,
    search_pubmed,
    search_pubmed_adapter,
)
from app.tools.content_cache import ContentCache
from app.tools.crawler import BROWSER_UA
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
    # LLM output hygiene: top-level summary + usage_hint must be present so the
    # LLM can brief the user without restating the full records array.
    # See docs/REVIEW_2026-07-20-llm-output-hygiene.md.
    assert "summary" in pubmed
    assert "usage_hint" in pubmed
    assert "records_count" in pubmed
    assert pubmed["records_count"] == len(pubmed["records"])
    assert "analyze_papers" in pubmed["usage_hint"]
    assert geo["accessions"] == ["GSE178352"]
    assert "200178352" not in geo["accessions"]
    assert geo["records"][0]["platform_count"] == 1
    assert geo["records"][0]["pubmed_id"] == "34180400"
    assert described["accession"] == "GSE178352"
    assert described["sample_count"] == 12
    # esummary exposes platform_ids (GPL*) but not per-platform title/organism.
    # Regression guard for docs/REVIEW_2026-07-18.md §17.3 item 1 — the old
    # describe_geo_adapter fabricated ``platforms=[{id, title:"", organism:""}]``
    # with hardcoded empty strings. Now we surface real platform_ids and a
    # derivable supplementary_file_listing_url instead.
    assert described["platform_ids"] == ["GPL24676"]
    assert described["platform_count"] == 1
    assert described["supplementary_file_listing_url"] == (
        "https://ftp.ncbi.nlm.nih.gov/geo/series/GSE178nnn/GSE178352/suppl/"
    )
    assert "note" in described
    # Forbidden fabricated placeholders — must never come back.
    assert "platforms" not in described
    assert "overall_design" not in described
    assert "supplementary_file_urls" not in described
    assert client.geo_summary_ids.count("200178352") == 2
    assert all(value.isdigit() for value in client.geo_summary_ids)
    assert context.query_log[0]["status"] == "success"


class _FailingEutils:
    """Eutils client that raises on esearch to simulate NCBI network failure."""

    async def esearch(self, *, db: str, term: str, retmax: int) -> bytes:
        raise RuntimeError("NCBI request failed: connection reset")

    async def esummary(self, *, db: str, ids: list[str]) -> bytes:
        raise RuntimeError("NCBI request failed")

    async def efetch(self, *, db: str, ids: list[str], retmode: str) -> bytes:
        raise RuntimeError("NCBI request failed")


@pytest.mark.asyncio
async def test_search_pubmed_adapter_propagates_failure_so_sdk_marks_error(
    tmp_path: Path,
) -> None:
    """Regression: adapter must raise on NCBI failure so the Agents SDK marks
    the tool_output as ``is_error=True``. Previously the adapter swallowed the
    exception and returned ``{"error": ..., "total_count": 0}`` with
    ``is_error=False``, causing the frontend to render a successful tool call
    while the LLM saw an empty result and self-reported 'search failed'."""
    async with httpx.AsyncClient() as http:
        services = NcbiServices(
            eutils=_FailingEutils(),
            http=http,
            cache=ContentCache(tmp_path / "cache"),
        )
        context = run_context(tmp_path)

    with pytest.raises(RuntimeError, match="NCBI request failed"):
        await search_pubmed_adapter(
            context, "Alzheimer AND osteoporosis", 20, services=services
        )

    assert context.query_log[0]["status"] == "failed"
    assert context.query_log[0]["records_count"] == 0


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
async def test_child_download_geo_commits_asset_outside_child_staging(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    parent = run_context(tmp_path)
    child = parent.create_child_context("child-geo")
    workspace = child.source_asset_workspace()
    asset = workspace.stage_bytes(
        content=b"child geo bytes",
        filename="child.geo",
        source_id="src_geo_child",
        successful_attempt_id="attempt_geo_child",
        data_level=DataLevel.REPOSITORY_PROCESSED,
        media_type="application/octet-stream",
    )
    source = SourceRecord(
        source_id="src_geo_child",
        database=Database.GEO,
        accession="GSE_CHILD",
        url="https://ftp.ncbi.nlm.nih.gov/child.geo",
        title="Child GEO",
        retrieved_at=datetime.now(UTC),
    )

    async def fake_resolve(*_args: object, **_kwargs: object) -> tuple[SourceRecord, str, DataLevel]:
        return source, "child.geo", DataLevel.REPOSITORY_PROCESSED

    async def fake_acquire_source(**_kwargs: object) -> object:
        return type(
            "AcquisitionResultStub",
            (),
            {
                "asset": asset,
                "attempt": type(
                    "AttemptStub",
                    (),
                    {"model_dump": lambda self, mode: {"status": "succeeded"}},
                )(),
            },
        )()

    monkeypatch.setattr(geo_module, "_resolve_download", fake_resolve)
    monkeypatch.setattr(geo_module, "acquire_source", fake_acquire_source)

    payload = json.loads(
        await download_geo_adapter(
            child,
            "GSE_CHILD",
            "suppl",
            services=type("Services", (), {"cache": None, "http": None})(),
        )
    )

    committed = parent.work_dir.root / payload["asset"]["relative_path"]
    assert committed.exists()
    assert committed.read_bytes() == b"child geo bytes"
    assert not (child.work_dir.root / payload["asset"]["relative_path"]).exists()
    assert child.source_asset_ids == [asset.asset_id]


@pytest.mark.asyncio
async def test_download_geo_platform_annotation_returns_asset(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """P0 wiring (REVIEW_2026-08-09 §7.1): the annotation download locates the
    platform table (discovery is stubbed), acquires it as a provenance-tracked
    SourceAsset and reports the local path for ``mapping_files``."""
    compressed = b"gzip platform table bytes"
    located = ("annot", "GPL570.annot.gz")
    monkeypatch.setattr(geo_module, "discover_annotation_file", lambda *_a, **_k: located)

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/annot/GPL570.annot.gz")
        return httpx.Response(
            200,
            content=compressed,
            headers={
                "Content-Length": str(len(compressed)),
                "Content-Type": "application/gzip",
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        services = NcbiServices(
            eutils=FixtureNcbiClient(),
            http=http,
            cache=ContentCache(tmp_path / "cache"),
        )
        context = run_context(tmp_path)
        payload = json.loads(
            await download_geo_platform_annotation_adapter(
                context,
                "GPL570",
                services=services,
                max_size_mb=1,
            )
        )

    assert payload["platform"] == "GPL570"
    assert payload["asset"]["data_level"] == "repository_processed"
    relative_path = payload["asset"]["relative_path"]
    downloaded = context.work_dir.root / relative_path
    assert downloaded.name == "GPL570.annot.gz"
    assert downloaded.read_bytes() == compressed
    assert payload["local_files"] == [str(downloaded)]
    assert context.raw_assets == [str(downloaded)]


@pytest.mark.asyncio
async def test_download_geo_platform_annotation_no_file_returns_error(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A platform without a downloadable annotation table fails cleanly (no
    exception, structured error the agent can act on)."""
    monkeypatch.setattr(geo_module, "discover_annotation_file", lambda *_a, **_k: None)

    services = NcbiServices(
        eutils=FixtureNcbiClient(),
        http=httpx.AsyncClient(),
        cache=ContentCache(tmp_path / "cache"),
    )
    context = run_context(tmp_path)
    payload = json.loads(
        await download_geo_platform_annotation_adapter(
            context,
            "GPL19072",
            services=services,
        )
    )
    await services.http.aclose()

    assert payload["platform"] == "GPL19072"
    assert "no downloadable annotation table" in payload["error"]


@pytest.mark.asyncio
async def test_download_geo_platform_annotation_rejects_invalid_gpl(
    tmp_path: Path,
) -> None:
    """Malformed GPL accessions are rejected before any network work."""
    services = NcbiServices(
        eutils=FixtureNcbiClient(),
        http=httpx.AsyncClient(),
        cache=ContentCache(tmp_path / "cache"),
    )
    context = run_context(tmp_path)
    payload = json.loads(
        await download_geo_platform_annotation_adapter(
            context,
            "not-a-gpl",
            services=services,
        )
    )
    await services.http.aclose()

    assert "must match" in payload["error"]


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


# ---------------------------------------------------------------------------
# download_supplementary_adapter (TODO §1.5)
#
# Regression guards for the PubMed supplementary download compliance fix:
#   1. efetch must go through services.eutils (NcbiEutilsClient) — not Biopython
#      Entrez. NcbiEutilsClient already enforces tool/email/api_key params,
#      3/10 req/s rate limit, 429/5xx retry, so the adapter inherits compliance.
#   2. PMC HTML + supplementary file downloads must use services.http (httpx)
#      with BROWSER_UA — not urllib.request with a fake "BioMed-QAgent/0.1" UA.
#   3. Dead code _parse_pubmed_record and the Biopython Entrez import must be
#      removed so future regressions cannot silently resurrect them.
# ---------------------------------------------------------------------------


_PMC_HTML_WITH_SUPP = b"""<html><body><article>
<p>Main article text.</p>
<a href="/pmc/articles/PMC8275131/bin/supp_data.xlsx">Supplementary Table S1</a>
<a href="/pmc/articles/PMC8275131/pdf/main.pdf">Main PDF (full text)</a>
</article></body></html>"""

_PMC_HTML_NO_SUPP = b"<html><body><p>No supplementary files here.</p></body></html>"


class _FixtureNcbiClientForDownload:
    """Fixture NcbiDiscoveryClient for download_supplementary tests.

    Returns the real ``pubmed_34180400.xml`` fixture (PMID 34180400 has
    ``<ArticleId IdType="pmc">PMC8275131</ArticleId>``). esearch/esummary
    raise to assert they are never called by the download path.
    """

    async def esearch(self, *, db: str, term: str, retmax: int) -> bytes:
        raise AssertionError("esearch must not be called by download_supplementary")

    async def esummary(self, *, db: str, ids: list[str]) -> bytes:
        raise AssertionError("esummary must not be called by download_supplementary")

    async def efetch(self, *, db: str, ids: list[str], retmode: str) -> bytes:
        assert (db, ids, retmode) == ("pubmed", ["34180400"], "xml")
        return (FIXTURE_DIR / "pubmed_34180400.xml").read_bytes()


@pytest.mark.asyncio
async def test_download_supplementary_adapter_uses_eutils_and_httpx(
    tmp_path: Path,
) -> None:
    """Happy path: efetch via services.eutils, PMC page + file via services.http."""
    supp_content = b"fake xlsx bytes for supp download"

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/pmc/articles/PMC8275131/":
            return httpx.Response(
                200,
                content=_PMC_HTML_WITH_SUPP,
                headers={"Content-Type": "text/html"},
            )
        assert request.url.path.endswith("/bin/supp_data.xlsx")
        return httpx.Response(
            200,
            content=supp_content,
            headers={
                "Content-Length": str(len(supp_content)),
                "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            },
        )

    client = _FixtureNcbiClientForDownload()
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        services = NcbiServices(
            eutils=client,
            http=http,
            cache=ContentCache(tmp_path / "cache"),
        )
        context = run_context(tmp_path)
        payload = json.loads(
            await download_supplementary_adapter(
                context, "34180400", services=services, max_size_mb=1
            )
        )

    assert payload["source"] == "pubmed"
    assert payload["accession"] == "34180400"
    assert payload["source_url"] == (
        "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8275131/"
    )
    assert len(payload["local_files"]) == 1
    local_path = Path(payload["local_files"][0])
    assert local_path.name == "supp_data.xlsx"
    assert local_path.read_bytes() == supp_content
    # SourceRecord tracked
    assert len(context.sources) == 1
    assert context.sources[0].accession == "34180400"
    assert context.sources[0].url == (
        "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8275131/"
    )
    # raw asset tracked
    assert context.raw_assets == [str(local_path)]
    # The efetch XML is registered first (TODO Phase 2.5 P1), then the
    # supplementary file asset.
    assert len(context.source_asset_ids) == 2
    assert context.source_asset_ids[1] == payload["source_assets"][0]["asset_id"]
    assert payload["pubmed_xml_asset"]["media_type"] == "application/xml"
    assert payload["source_assets"][0]["sha256"] == hashlib.sha256(
        supp_content
    ).hexdigest()
    assert payload["download_attempts"][0]["status"] == "succeeded"


@pytest.mark.asyncio
async def test_download_supplementary_adapter_no_pmcid_returns_error(
    tmp_path: Path,
) -> None:
    """When PubMed record has no PMCID, return error JSON (not in PMC OA)."""

    xml_no_pmc = (
        b"<?xml version=\"1.0\"?><PubmedArticleSet><PubmedArticle>"
        b"<MedlineCitation><PMID>12345</PMID>"
        b"<Article><ArticleTitle>No PMC</ArticleTitle></Article>"
        b"</MedlineCitation>"
        b"<PubmedData><ArticleIdList>"
        b"<ArticleId IdType=\"pubmed\">12345</ArticleId>"
        b"<ArticleId IdType=\"doi\">10.1/2</ArticleId>"
        b"</ArticleIdList></PubmedData>"
        b"</PubmedArticle></PubmedArticleSet>"
    )

    class NoPmcClient:
        async def efetch(self, *, db: str, ids: list[str], retmode: str) -> bytes:
            assert (db, ids, retmode) == ("pubmed", ["12345"], "xml")
            return xml_no_pmc

    async with httpx.AsyncClient() as http:
        services = NcbiServices(
            eutils=NoPmcClient(),
            http=http,
            cache=ContentCache(tmp_path / "cache"),
        )
        context = run_context(tmp_path)
        payload = json.loads(
            await download_supplementary_adapter(context, "12345", services=services)
        )

    assert payload["source"] == "pubmed"
    assert payload["accession"] == "12345"
    assert "error" in payload
    assert "PMCID" in payload["error"]
    # No source/raw asset recorded on the no-PMCID path
    assert context.sources == []
    assert context.raw_assets == []


@pytest.mark.asyncio
async def test_download_supplementary_adapter_no_supplementary_links(
    tmp_path: Path,
) -> None:
    """When PMC page has no supplementary links, return error JSON."""

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/pmc/articles/PMC8275131/"
        return httpx.Response(200, content=_PMC_HTML_NO_SUPP)

    client = _FixtureNcbiClientForDownload()
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        services = NcbiServices(
            eutils=client,
            http=http,
            cache=ContentCache(tmp_path / "cache"),
        )
        context = run_context(tmp_path)
        payload = json.loads(
            await download_supplementary_adapter(context, "34180400", services=services)
        )

    assert payload["source"] == "pubmed"
    assert payload["accession"] == "34180400"
    assert "error" in payload
    assert "supplementary" in payload["error"].lower()
    assert context.raw_assets == []


@pytest.mark.asyncio
async def test_download_supplementary_adapter_skips_oversized_file(
    tmp_path: Path,
) -> None:
    """Files exceeding max_size_mb must be skipped with a warning, not crash."""

    # 2 MB content, max_size_mb=1 -> must be skipped
    oversized = b"x" * (2 * 1024 * 1024)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/pmc/articles/PMC8275131/":
            return httpx.Response(200, content=_PMC_HTML_WITH_SUPP)
        assert request.url.path.endswith("/bin/supp_data.xlsx")
        return httpx.Response(
            200,
            content=oversized,
            headers={"Content-Length": str(len(oversized))},
        )

    client = _FixtureNcbiClientForDownload()
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        services = NcbiServices(
            eutils=client,
            http=http,
            cache=ContentCache(tmp_path / "cache"),
        )
        context = run_context(tmp_path)
        payload = json.loads(
            await download_supplementary_adapter(
                context, "34180400", services=services, max_size_mb=1
            )
        )

    # No file downloaded -> error payload with details
    assert payload["source"] == "pubmed"
    assert "error" in payload
    details = payload.get("details") or payload.get("warnings")
    assert details, "expected oversized-skip warning in details or warnings"
    assert any("exceeds" in str(item) or "Skipped" in str(item) for item in details)
    assert context.raw_assets == []


@pytest.mark.asyncio
async def test_download_supplementary_adapter_uses_browser_ua(
    tmp_path: Path,
) -> None:
    """All services.http requests must carry the real BROWSER_UA (project_memory
    L11 hard constraint) — not the old fake 'BioMed-QAgent/0.1' UA."""

    seen_ua_headers: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_ua_headers.append(request.headers.get("User-Agent", ""))
        if request.url.path == "/pmc/articles/PMC8275131/":
            return httpx.Response(200, content=_PMC_HTML_WITH_SUPP)
        return httpx.Response(
            200,
            content=b"supp bytes",
            headers={"Content-Length": "10"},
        )

    client = _FixtureNcbiClientForDownload()
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        services = NcbiServices(
            eutils=client,
            http=http,
            cache=ContentCache(tmp_path / "cache"),
        )
        context = run_context(tmp_path)
        await download_supplementary_adapter(
            context, "34180400", services=services, max_size_mb=1
        )

    assert seen_ua_headers, "no requests observed"
    for ua in seen_ua_headers:
        assert ua == BROWSER_UA, f"expected BROWSER_UA, got {ua!r}"
        assert "BioMed-QAgent/0.1" not in ua


def test_pubmed_module_does_not_import_biopython() -> None:
    """TODO §1.5: Biopython Entrez must be removed entirely.

    The compliance fix routes efetch through NcbiEutilsClient, which already
    enforces tool/email/api_key params + 3/10 req/s rate limit + 429/5xx retry.
    Importing Biopython Entrez would reintroduce an uncontrolled global HTTP
    client with no rate limit or retry — a regression we must guard against.
    """
    source = inspect.getsource(pubmed_module)
    assert "from Bio import Entrez" not in source
    assert "from Bio " not in source
    assert "import Bio" not in source
    assert "Entrez.email" not in source
    assert "Entrez.efetch" not in source


def test_pubmed_module_does_not_define_parse_pubmed_record() -> None:
    """TODO §1.5: dead code _parse_pubmed_record must be removed."""
    assert not hasattr(pubmed_module, "_parse_pubmed_record")
    source = inspect.getsource(pubmed_module)
    assert "_parse_pubmed_record" not in source


def test_pubmed_module_does_not_use_urllib_for_http() -> None:
    """TODO §1.5: HTTP downloads must use services.http (httpx.AsyncClient),
    not urllib.request — project_memory L11 requires BROWSER_UA + rate limit
    discipline that urllib.request alone cannot enforce."""
    source = inspect.getsource(pubmed_module)
    assert "urllib.request" not in source
    assert "urlopen" not in source


def test_download_supplementary_tool_is_async() -> None:
    """The function_tool wrapper must be async so it can await services.eutils
    and services.http. A sync wrapper would block the event loop.

    The ``@function_tool`` decorator wraps the async function into a
    ``FunctionTool`` dataclass instance, so ``iscoroutinefunction`` returns
    False on the wrapper. We assert against the source definition instead.
    """
    source = inspect.getsource(pubmed_module)
    assert "async def download_supplementary(" in source
