"""Tests for the pdb skill — search_pdb, describe_pdb, download_pdb."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import httpx
import pytest
from agents.tool_context import ToolContext
from app.agent_loop.context import RunContext
from app.domain.contracts import DataLevel
from app.skills.builtin.acquisition.pdb import (
    PdbServices,
    describe_pdb,
    download_pdb,
    download_pdb_adapter,
    search_pdb,
)
from app.tools.content_cache import ContentCache
from app.tools.crawler import FetchResult


def _make_ctx(task_id: str = "test_pdb") -> ToolContext:
    rc = RunContext(task_id=task_id)
    return ToolContext(
        context=rc,
        tool_name="search_pdb",
        tool_call_id="test_call_1",
        tool_arguments="{}",
    )


def _mock_urlopen(response_data: bytes, content_type: str = "application/json"):
    """Create a mock for urllib.request.urlopen that returns response_data."""
    mock_resp = MagicMock()
    mock_resp.__enter__.return_value = mock_resp
    mock_resp.__exit__.return_value = False
    mock_resp.read.return_value = response_data
    mock_resp.headers = {"content-type": content_type}
    mock_resp.status = 200
    return mock_resp


def _call(tool, task_id: str, **kwargs) -> dict[str, Any]:
    ctx = _make_ctx(task_id=task_id)
    args = json.dumps(kwargs)
    result = asyncio.run(tool.on_invoke_tool(ctx, args))
    return json.loads(result)


# ---------------------------------------------------------------------------
# search_pdb
# ---------------------------------------------------------------------------


def test_search_pdb_success() -> None:
    """search_pdb returns records and logs query on success.

    The RCSB Search API v2 ``result_set`` only contains ``identifier``;
    ``search_pdb`` enriches the top ``_DESCRIBE_BATCH_LIMIT`` entries by
    calling the Data API. We mock ``urlopen`` with ``side_effect`` to
    serve the search response first, then describe responses.
    """
    search_api_response = {
        "result_set": [
            {"identifier": "1CBS"},
            {"identifier": "2XYZ"},
        ]
    }
    describe_1cbs = {
        "struct": {"title": "Cellular retinoic acid binding protein"},
        "rcsb_entry_info": {"resolution_combined": [1.8]},
        "exptl": [{"method": "X-RAY DIFFRACTION"}],
        "rcsb_accession_info": {"deposit_date": "1992-01-01"},
        "polymer_entities": [
            {"rcsb_entity_source_organism": [{"scientific_name": "Homo sapiens"}]}
        ],
    }
    describe_2xyz = {
        "struct": {"title": "Hypothetical protein XYZ"},
        "rcsb_entry_info": {"resolution_combined": [2.5]},
        "exptl": [{"method": "SOLUTION NMR"}],
        "rcsb_accession_info": {"deposit_date": "2010-05-05"},
        "polymer_entities": [],
    }

    search_resp = _mock_urlopen(
        json.dumps(search_api_response).encode("utf-8")
    )
    describe_1cbs_resp = _mock_urlopen(
        json.dumps(describe_1cbs).encode("utf-8")
    )
    describe_2xyz_resp = _mock_urlopen(
        json.dumps(describe_2xyz).encode("utf-8")
    )

    ctx = _make_ctx(task_id="test_pdb_search")
    # search_pdb 内部按顺序: 1 次 POST search, 2 次 GET describe.
    # Rate limiting is handled inside _get_json via _rate_limit() (mocked by conftest).
    with patch(
        "urllib.request.urlopen",
        side_effect=[search_resp, describe_1cbs_resp, describe_2xyz_resp],
    ):
        args = json.dumps({"term": "retinoic acid", "max_results": 5})
        result = asyncio.run(search_pdb.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["source"] == "pdb"
    assert data["term"] == "retinoic acid"
    assert "1CBS" in data["pdb_ids"]
    assert len(data["records"]) == 2
    assert data["enriched_count"] == 2
    # 第一条记录已补全字段
    rec0 = data["records"][0]
    assert rec0["pdb_id"] == "1CBS"
    assert rec0["title"] == "Cellular retinoic acid binding protein"
    assert rec0["method"] == "X-RAY DIFFRACTION"
    assert rec0["resolution"] == 1.8
    assert rec0["organism"] == "Homo sapiens"
    assert rec0["deposit_date"] == "1992-01-01"
    # 第二条记录也已补全
    rec1 = data["records"][1]
    assert rec1["pdb_id"] == "2XYZ"
    assert rec1["title"] == "Hypothetical protein XYZ"
    assert rec1["method"] == "SOLUTION NMR"

    # log_query 应记录成功
    rc: RunContext = ctx.context
    assert len(rc.query_log) == 1
    assert rc.query_log[0]["status"] == "success"


def test_managed_search_pdb_uses_bound_crawler_facade(
    monkeypatch,
    tmp_path,
) -> None:
    class ManagedFacade:
        def __init__(self) -> None:
            self.calls: list[tuple[str, str]] = []

        async def api_request(
            self,
            url: str,
            *,
            method: str = "GET",
            json_body: dict[str, object] | None = None,
        ) -> FetchResult:
            del json_body
            self.calls.append((method, url))
            return FetchResult(
                url=url,
                content=json.dumps({"result_set": []}),
                status_code=200,
                elapsed_ms=1,
                method_used="api",
            )

    facade = ManagedFacade()
    context = RunContext(
        task_id="managed_pdb",
        base_dir=tmp_path,
        subagent_id="child-pdb",
    )
    context.bind_crawler_facade(facade)
    ctx = ToolContext(
        context=context,
        tool_name="search_pdb",
        tool_call_id="call-pdb",
        tool_arguments="{}",
    )
    monkeypatch.setattr(
        "app.skills.builtin.acquisition.pdb._post_json",
        lambda *_args: (_ for _ in ()).throw(AssertionError("urllib path used")),
    )

    result = asyncio.run(
        search_pdb.on_invoke_tool(ctx, json.dumps({"term": "BRCA"}))
    )

    assert json.loads(result)["pdb_ids"] == []
    assert facade.calls[0][0] == "POST"


def test_child_download_pdb_commits_source_asset(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Child (subagent) run: asset staged in child boundary then committed.

    Mirrors the GEO child test: the download path is replaced by a staged
    asset so the staging-commit boundary is exercised deterministically
    (acquire_source's real hardlink publication is covered by the
    integration tests in tests/integrations/test_acquisition.py).
    """
    import app.skills.builtin.acquisition.pdb as pdb_module

    parent = RunContext(task_id="managed_pdb_download", base_dir=tmp_path)
    child = parent.create_child_context("child-pdb")
    workspace = child.source_asset_workspace()
    asset = workspace.stage_bytes(
        content=b"ATOM child structure",
        filename="1cbs.pdb",
        source_id="src_pdb_child",
        successful_attempt_id="attempt_pdb_child",
        data_level=DataLevel.REPOSITORY_PROCESSED,
        media_type="application/octet-stream",
    )

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

    monkeypatch.setattr(pdb_module, "acquire_source", fake_acquire_source)

    async def run() -> str:
        services = PdbServices(
            http=None,  # type: ignore[arg-type]
            cache=None,  # type: ignore[arg-type]
        )
        return await download_pdb_adapter(
            child,
            "1cbs",
            "pdb",
            services=services,
        )

    result = asyncio.run(run())

    data = json.loads(result)
    committed = parent.work_dir.root / data["asset"]["relative_path"]
    assert committed.exists()
    assert committed.read_bytes() == b"ATOM child structure"
    assert not (child.work_dir.root / data["asset"]["relative_path"]).exists()
    assert child.source_asset_ids == [asset.asset_id]
    assert data["asset"]["kind"] == "source"
    assert data["attempt"]["status"] == "succeeded"


def test_search_pdb_network_error_returns_error_json() -> None:
    """search_pdb returns error JSON (not raises) on network failure."""
    ctx = _make_ctx(task_id="test_pdb_search_err")
    with patch("urllib.request.urlopen", side_effect=ConnectionError("DNS failed")):
        args = json.dumps({"term": "protein"})
        result = asyncio.run(search_pdb.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["source"] == "pdb"
    assert data["term"] == "protein"
    assert "error" in data
    assert data["pdb_ids"] == []
    assert data["records"] == []

    # log_query should record error
    rc: RunContext = ctx.context
    assert len(rc.query_log) == 1
    assert rc.query_log[0]["status"] == "failed"


# ---------------------------------------------------------------------------
# describe_pdb
# ---------------------------------------------------------------------------


def test_describe_pdb_success() -> None:
    """describe_pdb returns metadata and logs query on success."""
    mock_api_response = {
        "struct": {"title": "Test Structure"},
        "rcsb_entry_info": {"resolution_combined": [2.1]},
        "exptl": [{"method": "X-RAY DIFFRACTION"}],
        "audit_author": [{"name": "Smith, J."}],
        "citation": [{"title": "Test Paper"}],
        "rcsb_accession_info": {"deposit_date": "2020-01-01"},
        "polymer_entities": [],
        "nonpolymer_entities": [],
    }
    mock_resp = _mock_urlopen(json.dumps(mock_api_response).encode("utf-8"))

    ctx = _make_ctx(task_id="test_pdb_describe")
    with patch("urllib.request.urlopen", return_value=mock_resp):
        args = json.dumps({"pdb_id": "1cbs"})
        result = asyncio.run(describe_pdb.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["source"] == "pdb"
    assert data["pdb_id"] == "1CBS"
    assert data["title"] == "Test Structure"
    assert data["method"] == "X-RAY DIFFRACTION"
    assert data["resolution"] == 2.1

    rc: RunContext = ctx.context
    assert len(rc.query_log) == 1


# ---------------------------------------------------------------------------
# download_pdb
# ---------------------------------------------------------------------------


def test_download_pdb_success(tmp_path: Path) -> None:
    """download_pdb saves file, tracks provenance, and logs query."""
    file_content = (
        b"ATOM      1  N   MET A   1      11.104  6.134  6.504  1.00 20.00           N"
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=file_content,
            headers={
                "Content-Length": str(len(file_content)),
                "Content-Type": "application/octet-stream",
            },
        )

    ctx = _make_ctx(task_id="test_pdb_download")

    async def run() -> str:
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler)
        ) as http:
            services = PdbServices(
                http=http,
                cache=ContentCache(tmp_path / "cache"),
            )
            return await download_pdb_adapter(
                ctx.context,
                "1cbs",
                "pdb",
                services=services,
            )

    data = json.loads(asyncio.run(run()))
    assert data["source"] == "pdb"
    assert data["pdb_id"] == "1CBS"
    assert data["format_hint"] == "pdb_legacy"
    assert len(data["local_files"]) == 1
    assert data["local_files"][0].endswith("1cbs.pdb")

    # Verify provenance tracking
    rc: RunContext = ctx.context
    assert len(rc.raw_assets) == 1
    assert len(rc.sources) == 1
    assert rc.sources[0].database.value == "pdb"
    assert rc.source_asset_ids
    assert data["asset"]["sha256"] is not None
    assert data["attempt"]["status"] == "succeeded"


def test_download_pdb_unsupported_file_type() -> None:
    """download_pdb returns error JSON for unsupported file_type."""
    ctx = _make_ctx(task_id="test_pdb_bad_type")
    args = json.dumps({"pdb_id": "1cbs", "file_type": "xml"})
    result = asyncio.run(download_pdb.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["source"] == "pdb"
    assert "error" in data
    assert "xml" in data["error"] or "unsupported" in data["error"].lower()


def test_download_pdb_network_error_returns_error_json(tmp_path: Path) -> None:
    """download_pdb returns error JSON (not raises) on network failure."""
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, content=b"server error")

    ctx = _make_ctx(task_id="test_pdb_dl_err")

    async def run() -> str:
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler)
        ) as http:
            services = PdbServices(
                http=http,
                cache=ContentCache(tmp_path / "cache"),
            )
            return await download_pdb_adapter(
                ctx.context,
                "1cbs",
                "pdb",
                services=services,
            )

    data = json.loads(asyncio.run(run()))
    assert data["source"] == "pdb"
    assert "error" in data
    rc: RunContext = ctx.context
    assert rc.query_log[-1]["status"] == "failed"
