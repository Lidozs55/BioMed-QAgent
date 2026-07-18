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


@pytest.fixture(autouse=True)
def _disable_gdc_rate_limit() -> Any:
    """Skip GDC module-level 2s rate limiting during tests."""
    with patch("app.skills.builtin.acquisition.gdc._rate_limit"):
        yield


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
    assert "TCGA-LUAD" in data["project_ids"]
    assert "TCGA-BRCA" not in data["project_ids"]  # doesn't match "lung"
    assert len(data["records"]) == 1
    assert data["records"][0]["project_id"] == "TCGA-LUAD"
    assert data["records"][0]["case_count"] == 500

    rc: RunContext = ctx.context
    assert len(rc.query_log) == 1
    assert rc.query_log[0]["status"] == "ok"


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
    assert rc.query_log[0]["status"] == "error"


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
