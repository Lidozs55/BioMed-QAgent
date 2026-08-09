"""Tests for the gdc skill — search_gdc, describe_gdc, download_gdc."""
from __future__ import annotations

import asyncio
import json
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from agents.tool_context import ToolContext
from app.agent_loop.context import RunContext
from app.skills.builtin.acquisition.gdc import (
    describe_gdc,
    download_gdc,
    search_gdc,
)
from app.tools.crawler import DownloadResult, FetchResult


def _make_ctx(task_id: str = "test_gdc") -> ToolContext:
    rc = RunContext(task_id=task_id)
    return ToolContext(
        context=rc,
        tool_name="search_gdc",
        tool_call_id="test_call_1",
        tool_arguments="{}",
    )


def _mock_urlopen_json(payload: dict[str, Any]) -> MagicMock:
    """Mock urlopen returning JSON (single read)."""
    mock_resp = MagicMock()
    mock_resp.__enter__.return_value = mock_resp
    mock_resp.__exit__.return_value = False
    mock_resp.read.return_value = json.dumps(payload).encode("utf-8")
    return mock_resp


def _mock_urlopen_binary(content: bytes) -> MagicMock:
    """Mock urlopen returning binary (copyfileobj loop: content then empty)."""
    mock_resp = MagicMock()
    mock_resp.__enter__.return_value = mock_resp
    mock_resp.__exit__.return_value = False
    mock_resp.read.side_effect = [content, b""]
    return mock_resp


# ---------------------------------------------------------------------------
# search_gdc
# ---------------------------------------------------------------------------


def test_search_gdc_success() -> None:
    """search_gdc returns matching projects and logs query on success."""
    api_response = {
        "data": {
            "hits": [
                {
                    "project_id": "TCGA-LUAD",
                    "name": "Lung Adenocarcinoma",
                    "disease_type": ["Adenomas and Adenocarcinomas"],
                    "primary_site": ["Lung"],
                    "summary": {
                        "case_count": 500,
                        "file_count": 3000,
                        "data_categories": [
                            {"data_category": "Transcriptome Profiling"}
                        ],
                    },
                },
                {
                    "project_id": "TCGA-BRCA",
                    "name": "Breast Invasive Carcinoma",
                    "disease_type": ["Ductal Neoplasms"],
                    "primary_site": ["Breast"],
                    "summary": {
                        "case_count": 1000,
                        "file_count": 5000,
                        "data_categories": [],
                    },
                },
            ]
        }
    }
    mock_resp = _mock_urlopen_json(api_response)

    ctx = _make_ctx(task_id="test_gdc_search")
    with patch("urllib.request.urlopen", return_value=mock_resp):
        args = json.dumps({"term": "lung", "max_results": 5})
        result = asyncio.run(search_gdc.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["source"] == "gdc"
    assert data["term"] == "lung"


def test_search_gdc_accepts_query_parameter() -> None:
    """search_gdc accepts ``query`` (the recommended name, aligned with the
    other search skills) as well as the legacy ``term`` alias.

    REVIEW_2026-08-09-task-3eb85407: the agent previously passed ``query``
    and the schema rejected it as an unknown property.
    """
    api_response = {
        "data": {
            "hits": [
                {
                    "project_id": "TCGA-PAAD",
                    "name": "Pancreatic Adenocarcinoma",
                    "disease_type": ["Ductal Neoplasms"],
                    "primary_site": ["Pancreas"],
                    "summary": {"case_count": 180, "file_count": 900},
                }
            ]
        }
    }
    mock_resp = _mock_urlopen_json(api_response)

    ctx = _make_ctx(task_id="test_gdc_search_query")
    with patch("urllib.request.urlopen", return_value=mock_resp):
        args = json.dumps({"query": "PAAD"})
        result = asyncio.run(search_gdc.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["source"] == "gdc"
    assert data["term"] == "PAAD"
    assert data["project_ids"] == ["TCGA-PAAD"]


def test_managed_search_gdc_uses_bound_crawler_facade(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    class ManagedFacade:
        def __init__(self) -> None:
            self.calls: list[str] = []

        async def api(self, url: str) -> FetchResult:
            self.calls.append(url)
            return FetchResult(
                url=url,
                content=json.dumps({"data": {"hits": [], "pagination": {"total": 0}}}),
                status_code=200,
                elapsed_ms=1,
                method_used="api",
            )

    facade = ManagedFacade()
    context = RunContext(
        task_id="managed_gdc",
        base_dir=tmp_path,
        subagent_id="child-gdc",
    )
    context.bind_crawler_facade(facade)
    ctx = ToolContext(
        context=context,
        tool_name="search_gdc",
        tool_call_id="call-gdc",
        tool_arguments="{}",
    )
    monkeypatch.setattr(
        "app.skills.builtin.acquisition.gdc._fetch_json",
        lambda _url: (_ for _ in ()).throw(AssertionError("urllib path used")),
    )

    result = asyncio.run(search_gdc.on_invoke_tool(ctx, json.dumps({"term": "BRCA"})))

    assert json.loads(result)["project_ids"] == []
    assert facade.calls


def test_managed_download_gdc_stages_source_asset(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    class ManagedFacade:
        async def api(self, url: str) -> FetchResult:
            return FetchResult(
                url=url,
                content=json.dumps(
                    {
                        "data": {
                            "hits": [
                                {
                                    "file_id": "file-1",
                                    "file_name": "counts.tsv",
                                    "data_type": "Gene Expression Quantification",
                                }
                            ],
                            "pagination": {"total": 1},
                        }
                    }
                ),
                status_code=200,
                elapsed_ms=1,
                method_used="api",
            )

        async def download(self, url: str) -> DownloadResult:
            return DownloadResult(
                url=url,
                content=b"gene\tsample\nBRCA1\t1\n",
                status_code=200,
                elapsed_ms=1,
            )

    facade = ManagedFacade()
    parent = RunContext(task_id="managed_gdc_download", base_dir=tmp_path)
    parent.bind_crawler_facade(facade)
    child = parent.create_child_context("child-gdc")
    ctx = ToolContext(
        context=child,
        tool_name="download_gdc",
        tool_call_id="call-gdc-download",
        tool_arguments="{}",
    )
    monkeypatch.setattr(
        "app.skills.builtin.acquisition.gdc._fetch_json",
        lambda _url: (_ for _ in ()).throw(AssertionError("urllib path used")),
    )
    monkeypatch.setattr(
        "app.skills.builtin.acquisition.gdc._download_file",
        lambda *_args: (_ for _ in ()).throw(AssertionError("urllib path used")),
    )

    result = asyncio.run(
        download_gdc.on_invoke_tool(
            ctx,
            json.dumps({"project_id": "TCGA-BRCA", "data_type": "RNA-Seq"}),
        )
    )

    data = json.loads(result)
    assert "error" not in data
    assert child.source_asset_ids
    committed = parent.work_dir.root / "source_assets"
    assert list(committed.rglob("counts.tsv"))


def test_search_gdc_network_error_returns_error_json() -> None:
    """search_gdc returns error JSON (not raises) on network failure."""
    ctx = _make_ctx(task_id="test_gdc_search_err")
    with patch("urllib.request.urlopen", side_effect=ConnectionError("DNS failed")):
        args = json.dumps({"term": "breast"})
        result = asyncio.run(search_gdc.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["source"] == "gdc"
    assert data["term"] == "breast"
    assert "error" in data
    assert data["project_ids"] == []
    assert data["records"] == []

    rc: RunContext = ctx.context
    assert len(rc.query_log) == 1


def test_describe_gdc_data_category_filter() -> None:
    """describe_gdc accepts an optional ``data_category`` filter.

    REVIEW_2026-08-09-task-3eb85407: the agent passed ``data_category`` and
    the schema rejected it as an unknown property.
    """
    api_response = {
        "data": {
            "project_id": "TCGA-LUAD",
            "name": "Lung Adenocarcinoma",
            "disease_type": ["Adenomas and Adenocarcinomas"],
            "primary_site": ["Lung"],
            "summary": {
                "case_count": 500,
                "file_count": 3000,
                "data_categories": [
                    {"data_category": "Transcriptome Profiling", "file_count": 1500},
                    {"data_category": "Simple Nucleotide Variation", "file_count": 500},
                ],
            },
        }
    }
    mock_resp = _mock_urlopen_json(api_response)

    ctx = _make_ctx(task_id="test_gdc_describe_filter")
    ctx.tool_name = "describe_gdc"
    with patch("urllib.request.urlopen", return_value=mock_resp):
        args = json.dumps({
            "project_id": "TCGA-LUAD",
            "data_category": "Transcriptome",
        })
        result = asyncio.run(describe_gdc.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["source"] == "gdc"
    assert [dc["category"] for dc in data["data_categories"]] == [
        "Transcriptome Profiling"
    ]


def test_search_gdc_multi_token_term_uses_or_matching() -> None:
    """search_gdc 多 token 查询采用 OR 语义（任一 token 命中即返回）。

    ISSUE-005 回归测试:旧版 substring 匹配会让 ``"breast cancer TP53"``
    整体作为子串查找,无任何项目命中;新行为拆分为 tokens 后任一命中
    即返回(本例中"breast"命中 TCGA-BRCA)。
    """
    api_response = {
        "data": {
            "hits": [
                {
                    "project_id": "TCGA-LUAD",
                    "name": "Lung Adenocarcinoma",
                    "disease_type": ["Adenomas and Adenocarcinomas"],
                    "primary_site": ["Lung"],
                    "summary": {"case_count": 500, "file_count": 3000},
                },
                {
                    "project_id": "TCGA-BRCA",
                    "name": "Breast Invasive Carcinoma",
                    "disease_type": ["Ductal Neoplasms"],
                    "primary_site": ["Breast"],
                    "summary": {"case_count": 1000, "file_count": 5000},
                },
            ]
        }
    }
    mock_resp = _mock_urlopen_json(api_response)

    ctx = _make_ctx(task_id="test_gdc_or_match")
    with patch("urllib.request.urlopen", return_value=mock_resp):
        args = json.dumps({"term": "breast cancer TP53", "max_results": 20})
        result = asyncio.run(search_gdc.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["term"] == "breast cancer TP53"
    # TP53 不在 project 元数据里,但 "breast" 命中 TCGA-BRCA
    assert "TCGA-BRCA" in data["project_ids"]
    # TCGA-LUAD 不含任一 token,不应被返回
    assert "TCGA-LUAD" not in data["project_ids"]
    assert len(data["records"]) == 1


def test_search_gdc_single_token_keeps_exact_substring() -> None:
    """search_gdc 单 token 查询保留精确子串匹配行为。"""
    api_response = {
        "data": {
            "hits": [
                {
                    "project_id": "TCGA-BRCA",
                    "name": "Breast Invasive Carcinoma",
                    "disease_type": ["Ductal Neoplasms"],
                    "primary_site": ["Breast"],
                    "summary": {"case_count": 1000, "file_count": 5000},
                },
            ]
        }
    }
    mock_resp = _mock_urlopen_json(api_response)

    ctx = _make_ctx(task_id="test_gdc_single_token")
    with patch("urllib.request.urlopen", return_value=mock_resp):
        args = json.dumps({"term": "TCGA-BRCA", "max_results": 5})
        result = asyncio.run(search_gdc.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert "TCGA-BRCA" in data["project_ids"]


# ---------------------------------------------------------------------------
# describe_gdc
# ---------------------------------------------------------------------------


def test_describe_gdc_success() -> None:
    """describe_gdc returns project metadata and logs query on success.

    Mock matches the real GDC API shape for /projects/{id}: the project
    object is returned directly under ``data`` (NOT under ``data.hits[]``).
    """
    api_response = {
        "data": {
            "project_id": "TCGA-LUAD",
            "name": "Lung Adenocarcinoma",
            "disease_type": ["Adenomas and Adenocarcinomas"],
            "primary_site": ["Lung"],
            "program": {"name": "TCGA"},
            "summary": {
                "case_count": 500,
                "file_count": 3000,
                "data_categories": [
                    {"data_category": "Transcriptome Profiling", "file_count": 1500}
                ],
                "experimental_strategies": [
                    {"experimental_strategy": "RNA-Seq"}
                ],
            },
            "dbgap_accession_number": "phs000218",
            "state": "open",
        }
    }
    mock_resp = _mock_urlopen_json(api_response)

    ctx = _make_ctx(task_id="test_gdc_describe")
    ctx.tool_name = "describe_gdc"
    with patch("urllib.request.urlopen", return_value=mock_resp):
        args = json.dumps({"project_id": "TCGA-LUAD"})
        result = asyncio.run(describe_gdc.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["source"] == "gdc"
    assert data["project_id"] == "TCGA-LUAD"
    assert data["name"] == "Lung Adenocarcinoma"
    assert data["program"] == "TCGA"
    assert data["case_count"] == 500
    assert data["file_count"] == 3000
    assert data["state"] == "open"
    assert len(data["data_categories"]) == 1
    assert data["data_categories"][0]["category"] == "Transcriptome Profiling"
    assert "RNA-Seq" in data["experimental_strategies"]

    rc: RunContext = ctx.context
    assert len(rc.query_log) == 1


def test_describe_gdc_not_found() -> None:
    """describe_gdc returns error when project data is missing project_id.

    Real GDC API returns HTTP 404 for unknown projects (caught by the
    except branch). This test exercises the secondary guard: a 200
    response with an empty/malformed ``data`` object.
    """
    api_response = {"data": {}}
    mock_resp = _mock_urlopen_json(api_response)

    ctx = _make_ctx(task_id="test_gdc_describe_nf")
    ctx.tool_name = "describe_gdc"
    with patch("urllib.request.urlopen", return_value=mock_resp):
        args = json.dumps({"project_id": "UNKNOWN-PROJ"})
        result = asyncio.run(describe_gdc.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["source"] == "gdc"
    assert "error" in data
    assert "not found" in data["error"].lower()


# ---------------------------------------------------------------------------
# download_gdc
# ---------------------------------------------------------------------------


def test_download_gdc_success() -> None:
    """download_gdc saves manifest + files and tracks provenance."""
    files_api_response = {
        "data": {
            "hits": [
                {
                    "file_id": "abc-123-uuid",
                    "file_name": "test_file.tsv",
                    "data_type": "Gene Expression Quantification",
                    "data_format": "TSV",
                    "data_category": "Transcriptome Profiling",
                    "file_size": 1024,
                    "md5sum": "d41d8cd98f00b204e9800998ecf8427e",
                }
            ],
            "pagination": {"total": 1},
        }
    }
    json_mock = _mock_urlopen_json(files_api_response)
    file_content = b"gene\tsample1\nBRCA1\t1.5\n"
    binary_mock = _mock_urlopen_binary(file_content)

    ctx = _make_ctx(task_id="test_gdc_download")
    ctx.tool_name = "download_gdc"
    # First urlopen call: JSON query; second: binary download
    with patch("urllib.request.urlopen", side_effect=[json_mock, binary_mock]):
        args = json.dumps({"project_id": "TCGA-LUAD", "data_type": "RNA-Seq"})
        result = asyncio.run(download_gdc.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["source"] == "gdc"
    assert data["accession"] == "TCGA-LUAD"
    assert data["data_type"] == "RNA-Seq"
    assert data["file_count"] == 1
    assert data["downloaded"] == 1
    assert len(data["local_files"]) >= 1
    assert "format_hint" in data
    assert "gdc_rna_seq" in data["format_hint"]

    # Verify provenance tracking
    rc: RunContext = ctx.context
    assert len(rc.raw_assets) >= 1
    assert len(rc.sources) == 1
    assert rc.sources[0].database.value == "gdc"


def test_download_gdc_accepts_data_category_and_workflow_type() -> None:
    """download_gdc accepts optional ``data_category``/``workflow_type``
    filters (previously rejected as unknown properties).

    REVIEW_2026-08-09-task-3eb85407: the agent passed both and the schema
    rejected them, forcing three wasted download attempts.
    """
    files_api_response = {
        "data": {
            "hits": [
                {
                    "file_id": "abc-123-uuid",
                    "file_name": "test_file.tsv",
                    "data_type": "Gene Expression Quantification",
                    "data_format": "TSV",
                    "data_category": "Transcriptome Profiling",
                    "file_size": 1024,
                    "md5sum": "d41d8cd98f00b204e9800998ecf8427e",
                }
            ],
            "pagination": {"total": 1},
        }
    }
    json_mock = _mock_urlopen_json(files_api_response)
    file_content = b"gene\tsample1\nBRCA1\t1.5\n"
    binary_mock = _mock_urlopen_binary(file_content)

    ctx = _make_ctx(task_id="test_gdc_download_filters")
    ctx.tool_name = "download_gdc"
    with patch("urllib.request.urlopen", side_effect=[json_mock, binary_mock]):
        args = json.dumps({
            "project_id": "TCGA-PAAD",
            "data_type": "Gene Expression Quantification",
            "data_category": "Transcriptome Profiling",
            "workflow_type": "STAR - Counts",
        })
        result = asyncio.run(download_gdc.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["source"] == "gdc"
    assert data["accession"] == "TCGA-PAAD"
    assert data["file_count"] == 1
    assert data["downloaded"] == 1


def test_download_gdc_reports_only_successfully_saved_files() -> None:
    files_api_response = {
        "data": {
            "hits": [
                {"file_id": "ok", "file_name": "ok.tsv"},
                {"file_id": "failed", "file_name": "failed.tsv"},
            ],
            "pagination": {"total": 2},
        }
    }
    ctx = _make_ctx(task_id="test_gdc_partial_download")
    ctx.tool_name = "download_gdc"
    with patch(
        "urllib.request.urlopen",
        side_effect=[
            _mock_urlopen_json(files_api_response),
            _mock_urlopen_binary(b"gene\tsample\nTP53\t1\n"),
            ConnectionError("download failed"),
        ],
    ):
        result = asyncio.run(
            download_gdc.on_invoke_tool(
                ctx,
                json.dumps({"project_id": "TCGA-LUAD", "data_type": "RNA-Seq"}),
            )
        )

    data = json.loads(result)
    assert data["file_count"] == 2
    assert data["downloaded"] == 1
    assert len(data["local_files"]) == 2
    assert "error" not in data


def test_download_gdc_zero_saved_files_is_an_error() -> None:
    files_api_response = {
        "data": {
            "hits": [{"file_id": "failed", "file_name": "failed.tsv"}],
            "pagination": {"total": 1},
        }
    }
    ctx = _make_ctx(task_id="test_gdc_zero_download")
    ctx.tool_name = "download_gdc"
    with patch(
        "urllib.request.urlopen",
        side_effect=[
            _mock_urlopen_json(files_api_response),
            ConnectionError("download failed"),
        ],
    ):
        result = asyncio.run(
            download_gdc.on_invoke_tool(
                ctx,
                json.dumps({"project_id": "TCGA-LUAD", "data_type": "RNA-Seq"}),
            )
        )

    data = json.loads(result)
    assert data["downloaded"] == 0
    assert len(data["local_files"]) == 1
    assert "failed to download any" in data["error"]


def test_download_gdc_no_files_returns_error() -> None:
    """download_gdc returns error JSON when no files match."""
    files_api_response = {
        "data": {"hits": [], "pagination": {"total": 0}}
    }
    json_mock = _mock_urlopen_json(files_api_response)

    ctx = _make_ctx(task_id="test_gdc_dl_empty")
    ctx.tool_name = "download_gdc"
    with patch("urllib.request.urlopen", return_value=json_mock):
        args = json.dumps({"project_id": "UNKNOWN", "data_type": "RNA-Seq"})
        result = asyncio.run(download_gdc.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["source"] == "gdc"
    assert "error" in data
    assert data["file_count"] == 0


def test_download_gdc_network_error_returns_error_json() -> None:
    """download_gdc returns error JSON on network failure during files query."""
    ctx = _make_ctx(task_id="test_gdc_dl_err")
    ctx.tool_name = "download_gdc"
    with patch("urllib.request.urlopen", side_effect=ConnectionError("timeout")):
        args = json.dumps({"project_id": "TCGA-LUAD", "data_type": "RNA-Seq"})
        result = asyncio.run(download_gdc.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["source"] == "gdc"
    assert "error" in data
