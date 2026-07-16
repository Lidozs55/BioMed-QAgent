"""Tests for the pdb skill — search_pdb, describe_pdb, download_pdb."""
from __future__ import annotations

import asyncio
import json
from typing import Any
from unittest.mock import MagicMock, patch

from agents.tool_context import ToolContext
from app.agent_loop.context import RunContext
from app.skills.builtin.acquisition.pdb import (
    describe_pdb,
    download_pdb,
    search_pdb,
)


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
    """search_pdb returns records and logs query on success."""
    mock_api_response = {
        "result_set": [
            {
                "identifier": "1CBS",
                "title": "Cellular retinoic acid binding protein",
                "exptl": [{"method": "X-RAY DIFFRACTION"}],
                "rcsb_entry_info": {"resolution_combined": [1.8]},
                "rcsb_accession_info": {"deposit_date": "1992-01-01"},
                "entity_poly": {"rcsb_entity_polymer_type": "polypeptide(L)"},
            }
        ]
    }
    mock_resp = _mock_urlopen(json.dumps(mock_api_response).encode("utf-8"))

    ctx = _make_ctx(task_id="test_pdb_search")
    with patch("urllib.request.urlopen", return_value=mock_resp):
        args = json.dumps({"term": "retinoic acid", "max_results": 5})
        result = asyncio.run(search_pdb.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["source"] == "pdb"
    assert data["term"] == "retinoic acid"
    assert "1CBS" in data["pdb_ids"]
    assert len(data["records"]) == 1
    assert data["records"][0]["title"] == "Cellular retinoic acid binding protein"

    # log_query should record success
    rc: RunContext = ctx.context
    assert len(rc.query_log) == 1
    assert rc.query_log[0]["status"] == "ok"


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
    assert rc.query_log[0]["status"] == "error"


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


def test_download_pdb_success() -> None:
    """download_pdb saves file, tracks provenance, and logs query."""
    file_content = b"ATOM      1  N   MET A   1      11.104  6.134  6.504  1.00 20.00           N"

    # shutil.copyfileobj calls resp.read(bufsize) in a loop until empty bytes
    # Return content on first read, empty on subsequent reads
    read_calls = [file_content, b""]
    mock_resp = MagicMock()
    mock_resp.__enter__.return_value = mock_resp
    mock_resp.__exit__.return_value = False
    mock_resp.read.side_effect = read_calls

    ctx = _make_ctx(task_id="test_pdb_download")
    with patch("urllib.request.urlopen", return_value=mock_resp):
        args = json.dumps({"pdb_id": "1cbs", "file_type": "pdb"})
        result = asyncio.run(download_pdb.on_invoke_tool(ctx, args))

    data = json.loads(result)
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


def test_download_pdb_unsupported_file_type() -> None:
    """download_pdb returns error JSON for unsupported file_type."""
    ctx = _make_ctx(task_id="test_pdb_bad_type")
    args = json.dumps({"pdb_id": "1cbs", "file_type": "xml"})
    result = asyncio.run(download_pdb.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["source"] == "pdb"
    assert "error" in data
    assert "xml" in data["error"] or "unsupported" in data["error"].lower()


def test_download_pdb_network_error_returns_error_json() -> None:
    """download_pdb returns error JSON (not raises) on network failure."""
    ctx = _make_ctx(task_id="test_pdb_dl_err")
    with patch("urllib.request.urlopen", side_effect=ConnectionError("timeout")):
        args = json.dumps({"pdb_id": "1cbs", "file_type": "pdb"})
        result = asyncio.run(download_pdb.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["source"] == "pdb"
    assert "error" in data
