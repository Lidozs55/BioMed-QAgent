"""Reactome skill tests for the unified async fallback chain."""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from unittest.mock import AsyncMock, Mock, patch

from agents.tool_context import ToolContext
from app.agent_loop.context import RunContext
from app.skills.builtin.acquisition.reactome import (
    _accept_reactome_pathway_result,
    _accept_reactome_search_result,
    download_reactome,
    get_pathway,
    search_reactome,
)
from app.tools.crawler import CrawlAttempt, FetchResult, fetch_with_fallback


def _context(task_id: str) -> tuple[ToolContext, Mock]:
    facade = Mock()
    facade.api = AsyncMock()
    run_context = RunContext(task_id=task_id)
    run_context.bind_crawler_facade(facade)
    return (
        ToolContext(
            context=run_context,
            tool_name="reactome",
            tool_call_id="call_1",
            tool_arguments="{}",
        ),
        facade,
    )


def _attempt(method: str, *, status: str = "succeeded") -> CrawlAttempt:
    return CrawlAttempt(
        method=method,
        url=f"https://{method}.example/data",
        started_at=datetime.now(UTC),
        status=status,
        status_code=200 if status == "succeeded" else 500,
    )


class _FallbackFacade:
    def __init__(self, api_content: str, *, html_content: str) -> None:
        self.api_content = api_content
        self.html_content = html_content
        self.calls: list[str] = []

    async def api(self, url: str) -> FetchResult:
        self.calls.append("api")
        return FetchResult(
            url=url,
            content=self.api_content,
            status_code=200,
            elapsed_ms=1,
            method_used="api",
        )

    async def html(self, url: str) -> FetchResult:
        self.calls.append("html")
        return FetchResult(
            url=url,
            content=self.html_content,
            status_code=200,
            elapsed_ms=1,
            method_used="httpx",
        )

    async def browser(self, url: str) -> FetchResult:
        self.calls.append("browser")
        return FetchResult(
            url=url,
            content="<html><body>Rendered Reactome result</body></html>",
            status_code=200,
            elapsed_ms=1,
            method_used="crawl",
        )


def test_search_fallback_rejects_api_json_list_before_html() -> None:
    facade = _FallbackFacade("[]", html_content="<html><body>Static result</body></html>")

    result = asyncio.run(
        fetch_with_fallback(
            "https://reactome.org/api",
            "https://reactome.org/page",
            facade=facade,
            accept_result=_accept_reactome_search_result,
        )
    )

    assert result.method_used == "httpx"
    assert facade.calls == ["api", "html"]


def test_search_fallback_rejects_api_error_document_before_browser() -> None:
    facade = _FallbackFacade(
        '{"error": "temporarily unavailable"}',
        html_content="<html><body><script>no static result</script></body></html>",
    )

    result = asyncio.run(
        fetch_with_fallback(
            "https://reactome.org/api",
            "https://reactome.org/page",
            facade=facade,
            accept_result=_accept_reactome_search_result,
        )
    )

    assert result.method_used == "crawl"
    assert facade.calls == ["api", "html", "browser"]


def test_pathway_fallback_rejects_non_json_api_body_before_html() -> None:
    facade = _FallbackFacade(
        "Service temporarily unavailable",
        html_content="<html><body>Static pathway</body></html>",
    )

    result = asyncio.run(
        fetch_with_fallback(
            "https://reactome.org/api",
            "https://reactome.org/page",
            facade=facade,
            accept_result=_accept_reactome_pathway_result,
        )
    )

    assert result.method_used == "httpx"
    assert facade.calls == ["api", "html"]


def test_search_reactome_uses_one_audited_fallback_call() -> None:
    context, facade = _context("reactome_search")
    result = FetchResult(
        url="https://api.example/data",
        content=json.dumps(
            {
                "results": [
                    {
                        "entries": [
                            {
                                "stId": "R-HSA-169893",
                                "name": '<span class="highlighting">Apoptosis</span>',
                                "species": ["Homo sapiens"],
                                "summation": "Programmed cell death",
                                "exactType": "Pathway",
                            }
                        ]
                    }
                ],
                "numberOfMatches": 1,
            }
        ),
        status_code=200,
        elapsed_ms=2,
        method_used="api",
        attempts=(_attempt("api"),),
    )

    with patch(
        "app.skills.builtin.acquisition.reactome.fetch_with_fallback",
        new=AsyncMock(return_value=result),
    ) as fallback:
        payload = asyncio.run(
            search_reactome.on_invoke_tool(
                context,
                json.dumps({"term": "apoptosis"}),
            )
        )

    data = json.loads(payload)
    assert data["records"][0]["name"] == "Apoptosis"
    assert data["attempts"][0]["method"] == "api"
    assert fallback.await_args.args[0].startswith(
        "https://reactome.org/ContentService/search/query"
    )
    assert fallback.await_args.args[1].startswith("https://reactome.org/content/query")
    assert fallback.await_args.kwargs["facade"] is facade
    predicate = fallback.await_args.kwargs["accept_result"]
    assert predicate(result)
    assert not predicate(
        FetchResult(
            url="https://api.example/error",
            content='{"error": "not found"}',
            status_code=200,
            elapsed_ms=1,
            method_used="api",
        )
    )


def test_search_reactome_enrichment_uses_bound_async_facade() -> None:
    context, facade = _context("reactome_enrichment")
    search_result = FetchResult(
        url="https://api.example/data",
        content=json.dumps(
            {
                "results": [
                    {
                        "entries": [
                            {
                                "stId": "R-HSA-169893",
                                "name": "Apoptosis",
                                "species": ["Homo sapiens"],
                                "exactType": "Pathway",
                            }
                        ]
                    }
                ],
                "numberOfMatches": 1,
            }
        ),
        status_code=200,
        elapsed_ms=2,
        method_used="api",
        attempts=(_attempt("api"),),
    )
    facade.api.return_value = FetchResult(
        url="https://reactome.org/summation",
        content=json.dumps([{"text": "Programmed cell death."}]),
        status_code=200,
        elapsed_ms=1,
        method_used="api",
    )

    with patch(
        "app.skills.builtin.acquisition.reactome.fetch_with_fallback",
        new=AsyncMock(return_value=search_result),
    ):
        payload = asyncio.run(
            search_reactome.on_invoke_tool(
                context,
                json.dumps({"term": "apoptosis"}),
            )
        )

    assert json.loads(payload)["records"][0]["summary"] == "Programmed cell death."
    facade.api.assert_awaited_once_with(
        "https://reactome.org/ContentService/data/pathways/R-HSA-169893/summation"
    )


def test_reactome_static_html_fallback_preserves_attempt_audit() -> None:
    context, _ = _context("reactome_fallback")
    result = FetchResult(
        url="https://reactome.org/content/query?q=apoptosis",
        content="<html><body>Visible pathway</body></html>",
        status_code=200,
        elapsed_ms=2,
        method_used="httpx",
        attempts=(
            _attempt("api", status="failed"),
            _attempt("html"),
        ),
    )

    with patch(
        "app.skills.builtin.acquisition.reactome.fetch_with_fallback",
        new=AsyncMock(return_value=result),
    ):
        payload = asyncio.run(
            search_reactome.on_invoke_tool(
                context,
                json.dumps({"term": "apoptosis"}),
            )
        )

    data = json.loads(payload)
    assert data["status"] == "page_fallback"
    assert [attempt["method"] for attempt in data["attempts"]] == ["api", "html"]


def test_get_pathway_api_success_adds_source_provenance() -> None:
    context, _ = _context("reactome_get")
    result = FetchResult(
        url="https://api.example/data",
        content=json.dumps(
            {
                "stId": "R-HSA-169893",
                "name": ["Apoptosis"],
                "speciesName": "Homo sapiens",
                "hasDiagram": True,
            }
        ),
        status_code=200,
        elapsed_ms=2,
        method_used="api",
        attempts=(_attempt("api"),),
    )

    with patch(
        "app.skills.builtin.acquisition.reactome.fetch_with_fallback",
        new=AsyncMock(return_value=result),
    ):
        payload = asyncio.run(
            get_pathway.on_invoke_tool(
                context,
                json.dumps({"pathway_id": "R-HSA-169893"}),
            )
        )

    assert json.loads(payload)["record"]["name"] == "Apoptosis"
    assert context.context.sources[0].accession == "R-HSA-169893"


def test_download_reactome_tsv_saves_raw_file_and_tracks_provenance(
    tmp_path,
) -> None:
    """download_reactome saves a participants TSV and records a SourceRecord."""
    from pathlib import Path

    run_context = RunContext(task_id="reactome_dl_tsv", base_dir=str(tmp_path))
    context = ToolContext(
        context=run_context,
        tool_name="download_reactome",
        tool_call_id="call_reactome_dl_tsv",
        tool_arguments="{}",
    )
    payload = (
        "stId\tparticipantName\tparticipantType\n"
        "R-HSA-109581\tApoptosis signaling\tPhysicalEntity\n"
    )
    with patch(
        "app.skills.builtin.acquisition.reactome.download_file_for_run",
        new=AsyncMock(side_effect=lambda _ctx, url, dest: dest.write_text(payload)),
    ) as mock_dl:
        result = asyncio.run(
            download_reactome.on_invoke_tool(
                context,
                json.dumps({"pathway_id": "R-HSA-169893", "file_type": "tsv"}),
            )
        )

    data = json.loads(result)
    assert data["source"] == "reactome"
    assert data["pathway_id"] == "R-HSA-169893"
    assert data["format_hint"] == "reactome_participants_tsv"
    assert data["source_url"] == (
        "https://reactome.org/ContentService/exporter/participants/"
        "R-HSA-169893.tsv"
    )
    assert mock_dl.await_args.args[1] == data["source_url"]
    local_path = Path(data["local_files"][0])
    assert local_path.is_file()
    assert "Apoptosis signaling" in local_path.read_text(encoding="utf-8")
    assert len(run_context.raw_assets) == 1
    assert run_context.sources[0].database.value == "reactome"
    assert run_context.sources[0].accession == "R-HSA-169893"


def test_download_reactome_sbgn_url_and_unsupported_type(tmp_path) -> None:
    """download_reactome builds the SBGN exporter URL and rejects bad types."""
    from pathlib import Path

    run_context = RunContext(task_id="reactome_dl_sbgn", base_dir=str(tmp_path))
    context = ToolContext(
        context=run_context,
        tool_name="download_reactome",
        tool_call_id="call_reactome_dl_sbgn",
        tool_arguments="{}",
    )
    with patch(
        "app.skills.builtin.acquisition.reactome.download_file_for_run",
        new=AsyncMock(side_effect=lambda _ctx, url, dest: dest.write_bytes(b"<sbgn/>")),
    ) as mock_dl:
        result = asyncio.run(
            download_reactome.on_invoke_tool(
                context,
                json.dumps({"pathway_id": "R-HSA-169893", "file_type": "sbgn"}),
            )
        )
    data = json.loads(result)
    assert data["format_hint"] == "reactome_sbgn"
    assert data["source_url"] == (
        "https://reactome.org/ContentService/exporter/diagram/"
        "R-HSA-169893.sbgn"
    )
    assert mock_dl.await_args.args[1] == data["source_url"]
    assert Path(data["local_files"][0]).is_file()

    # Unsupported file_type → error JSON, no download attempted.
    run_context2 = RunContext(task_id="reactome_dl_bad", base_dir=str(tmp_path))
    context2 = ToolContext(
        context=run_context2,
        tool_name="download_reactome",
        tool_call_id="call_reactome_dl_bad",
        tool_arguments="{}",
    )
    result2 = asyncio.run(
        download_reactome.on_invoke_tool(
            context2,
            json.dumps({"pathway_id": "R-HSA-169893", "file_type": "xml"}),
        )
    )
    data2 = json.loads(result2)
    assert "error" in data2
    assert "unsupported file_type" in data2["error"]


def test_download_reactome_network_error_returns_error_json(tmp_path) -> None:
    """download_reactome returns error JSON on download failure."""

    run_context = RunContext(task_id="reactome_dl_err", base_dir=str(tmp_path))
    context = ToolContext(
        context=run_context,
        tool_name="download_reactome",
        tool_call_id="call_reactome_dl_err",
        tool_arguments="{}",
    )
    with patch(
        "app.skills.builtin.acquisition.reactome.download_file_for_run",
        new=AsyncMock(side_effect=RuntimeError("403 Forbidden")),
    ):
        result = asyncio.run(
            download_reactome.on_invoke_tool(
                context,
                json.dumps({"pathway_id": "R-HSA-169893", "file_type": "tsv"}),
            )
        )
    data = json.loads(result)
    assert data["source"] == "reactome"
    assert "error" in data
    assert "download failed" in data["error"]


def test_child_download_reactome_commits_source_asset(
    monkeypatch,
    tmp_path,
) -> None:
    """Managed subagent download stages a compliant SourceAsset."""
    from pathlib import Path

    from app.tools.crawler import DownloadResult

    class ManagedFacade:
        async def download(self, url: str) -> DownloadResult:
            return DownloadResult(
                url=url,
                content=b"stId\tname\nR-HSA-109581\tApoptosis\n",
                status_code=200,
                elapsed_ms=1,
            )

    parent = RunContext(task_id="managed_reactome_dl", base_dir=str(tmp_path))
    parent.bind_crawler_facade(ManagedFacade())
    child = parent.create_child_context("child-reactome")
    context = ToolContext(
        context=child,
        tool_name="download_reactome",
        tool_call_id="call_reactome_dl_child",
        tool_arguments="{}",
    )
    monkeypatch.setattr(
        "app.skills.builtin.acquisition.reactome.download_file_for_run",
        lambda *_args: (_ for _ in ()).throw(
            AssertionError("raw path used in child run")
        ),
    )

    result = asyncio.run(
        download_reactome.on_invoke_tool(
            context,
            json.dumps({"pathway_id": "R-HSA-169893", "file_type": "tsv"}),
        )
    )

    data = json.loads(result)
    committed = Path(data["local_files"][0])
    assert committed.is_relative_to(parent.work_dir.source_assets)
    assert committed.read_bytes().startswith(b"stId\tname")
    assert child.source_asset_ids
