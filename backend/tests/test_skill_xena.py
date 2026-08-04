"""Tests for the xena skill — search_xena, download_xena."""
from __future__ import annotations

import asyncio
import gzip
import json
from pathlib import Path
from unittest.mock import MagicMock, patch

from agents.tool_context import ToolContext
from app.agent_loop.context import RunContext
from app.skills.builtin.acquisition.xena import (
    download_xena,
    search_xena,
)
from app.tools.crawler import DownloadResult, FetchResult


def _make_ctx(task_id: str = "test_xena") -> ToolContext:
    rc = RunContext(task_id=task_id)
    return ToolContext(
        context=rc,
        tool_name="search_xena",
        tool_call_id="test_call_1",
        tool_arguments="{}",
    )


def _mock_urlopen_bytes(content: bytes) -> MagicMock:
    """Mock urlopen returning bytes (single read, for XML or JSON)."""
    mock_resp = MagicMock()
    mock_resp.__enter__.return_value = mock_resp
    mock_resp.__exit__.return_value = False
    mock_resp.read.return_value = content
    return mock_resp


def _mock_urlopen_streaming(content: bytes) -> MagicMock:
    """Mock urlopen returning binary (copyfileobj loop: content then empty)."""
    mock_resp = MagicMock()
    mock_resp.__enter__.return_value = mock_resp
    mock_resp.__exit__.return_value = False
    mock_resp.read.side_effect = [content, b""]
    return mock_resp


def _make_s3_xml(keys: list[tuple[str, int, str]]) -> bytes:
    """Build a minimal S3 ListBucket XML response.

    Args:
        keys: list of (key, size, last_modified) tuples.
    """
    ns = "http://s3.amazonaws.com/doc/2006-03-01/"
    items = ""
    for key, size, modified in keys:
        items += (
            f"<Contents>"
            f"<Key>{key}</Key>"
            f"<Size>{size}</Size>"
            f"<LastModified>{modified}</LastModified>"
            f"</Contents>"
        )
    return f'<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult xmlns="{ns}">{items}</ListBucketResult>'.encode()


# ---------------------------------------------------------------------------
# search_xena
# ---------------------------------------------------------------------------


def test_search_xena_success() -> None:
    """search_xena parses S3 XML and returns matching datasets."""
    mock_datasets = [
        {"dataset_id": "TCGA.BRCA.sampleMap/HiSeqV2", "name": "TCGA.BRCA.sampleMap/HiSeqV2", "type": "gene_expression", "cohort": "TCGA-BRCA", "size_bytes": 50000, "last_modified": "2024-01-01"},
        {"dataset_id": "TCGA.BRCA.sampleMap/clinical.json", "name": "TCGA.BRCA.sampleMap/clinical.json", "type": "clinical", "cohort": "TCGA-BRCA", "size_bytes": 5000, "last_modified": "2024-01-01"},
        {"dataset_id": "TCGA.LUAD.sampleMap/HiSeqV2", "name": "TCGA.LUAD.sampleMap/HiSeqV2", "type": "gene_expression", "cohort": "TCGA-LUAD", "size_bytes": 40000, "last_modified": "2024-01-01"},
    ]

    ctx = _make_ctx(task_id="test_xena_search")
    with patch("app.skills.builtin.acquisition.xena._fetch_hub_index", return_value=mock_datasets):
        args = json.dumps({"term": "BRCA", "max_results": 10})
        result = asyncio.run(search_xena.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["source"] == "xena"
    assert data["term"] == "BRCA"
    assert data["count"] == 2  # HiSeqV2 + clinical.json (both contain BRCA)
    assert len(data["records"]) == 2
    # All records should contain BRCA
    for rec in data["records"]:
        assert "BRCA" in rec["name"] or "BRCA" in rec["cohort"]

    rc: RunContext = ctx.context
    assert len(rc.query_log) == 1
    assert rc.query_log[0]["status"] == "success"


def test_search_xena_accepts_query_parameter() -> None:
    """search_xena accepts ``query`` as the recommended parameter name."""
    mock_datasets = [
        {"dataset_id": "TCGA.BRCA.sampleMap/HiSeqV2", "name": "TCGA.BRCA.sampleMap/HiSeqV2", "type": "gene_expression", "cohort": "TCGA-BRCA", "size_bytes": 50000, "last_modified": "2024-01-01"},
    ]

    ctx = _make_ctx(task_id="test_xena_query")
    with patch("app.skills.builtin.acquisition.xena._fetch_hub_index", return_value=mock_datasets):
        args = json.dumps({"query": "BRCA", "max_results": 10})
        result = asyncio.run(search_xena.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["source"] == "xena"
    assert data["term"] == "BRCA"
    assert data["count"] == 1


def test_search_xena_query_preferred_over_term() -> None:
    """When both ``query`` and ``term`` are given, ``query`` wins."""
    mock_datasets = [
        {"dataset_id": "TCGA.BRCA.sampleMap/HiSeqV2", "name": "TCGA.BRCA.sampleMap/HiSeqV2", "type": "gene_expression", "cohort": "TCGA-BRCA", "size_bytes": 50000, "last_modified": "2024-01-01"},
        {"dataset_id": "TCGA.LUAD.sampleMap/HiSeqV2", "name": "TCGA.LUAD.sampleMap/HiSeqV2", "type": "gene_expression", "cohort": "TCGA-LUAD", "size_bytes": 40000, "last_modified": "2024-01-01"},
    ]

    ctx = _make_ctx(task_id="test_xena_both")
    with patch("app.skills.builtin.acquisition.xena._fetch_hub_index", return_value=mock_datasets):
        args = json.dumps({"query": "BRCA", "term": "LUAD"})
        result = asyncio.run(search_xena.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["term"] == "BRCA"  # query wins
    assert data["count"] == 1


def test_managed_search_xena_uses_bound_crawler_facade(
    monkeypatch,
    tmp_path,
) -> None:
    facade_calls: list[str] = []

    class ManagedFacade:
        async def api(self, url: str) -> FetchResult:
            facade_calls.append(url)
            return FetchResult(
                url=url,
                content=_make_s3_xml([]).decode("utf-8"),
                status_code=200,
                elapsed_ms=1,
                method_used="api",
            )

    context = RunContext(
        task_id="managed_xena",
        base_dir=tmp_path,
        subagent_id="child-xena",
    )
    context.bind_crawler_facade(ManagedFacade())
    ctx = ToolContext(
        context=context,
        tool_name="search_xena",
        tool_call_id="call-xena",
        tool_arguments="{}",
    )
    monkeypatch.setattr(
        "app.skills.builtin.acquisition.xena._fetch_hub_index",
        lambda: (_ for _ in ()).throw(AssertionError("urllib path used")),
    )

    result = asyncio.run(
        search_xena.on_invoke_tool(ctx, json.dumps({"term": "BRCA"}))
    )

    assert json.loads(result)["count"] == 0
    assert facade_calls


def test_child_download_xena_commits_compressed_source_asset(
    monkeypatch,
    tmp_path,
) -> None:
    raw_content = b"gene\tsample\nBRCA1\t1\n"
    gz_content = gzip.compress(raw_content)

    class ManagedFacade:
        async def download(self, url: str) -> DownloadResult:
            return DownloadResult(
                url=url,
                content=gz_content,
                status_code=200,
                elapsed_ms=1,
            )

    parent = RunContext(task_id="managed_xena_download", base_dir=tmp_path)
    parent.bind_crawler_facade(ManagedFacade())
    child = parent.create_child_context("child-xena")
    context = ToolContext(
        context=child,
        tool_name="download_xena",
        tool_call_id="call-xena-download",
        tool_arguments="{}",
    )
    monkeypatch.setattr(
        "app.skills.builtin.acquisition.xena._download",
        lambda *_args: (_ for _ in ()).throw(AssertionError("urllib path used")),
    )

    result = asyncio.run(
        download_xena.on_invoke_tool(
            context,
            json.dumps(
                {
                    "dataset_id": "TCGA.BRCA.sampleMap/HiSeqV2",
                    "file_type": "tsv",
                }
            ),
        )
    )

    data = json.loads(result)
    committed = Path(data["local_files"][0])
    assert committed.is_relative_to(parent.work_dir.source_assets)
    assert committed.read_bytes() == gz_content
    assert child.source_asset_ids


def test_search_xena_network_error_returns_error_json() -> None:
    """search_xena returns error JSON on network failure."""
    ctx = _make_ctx(task_id="test_xena_search_err")
    with patch("urllib.request.urlopen", side_effect=ConnectionError("timeout")):
        args = json.dumps({"term": "mutation"})
        result = asyncio.run(search_xena.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["source"] == "xena"
    assert data["term"] == "mutation"
    assert "error" in data
    assert data["count"] == 0
    assert data["records"] == []

    rc: RunContext = ctx.context
    assert len(rc.query_log) == 1
    assert rc.query_log[0]["status"] == "failed"


def test_search_xena_empty_term_returns_all() -> None:
    """search_xena with empty term returns all datasets."""
    mock_datasets = [
        {"dataset_id": "TCGA.BRCA.sampleMap/HiSeqV2", "name": "TCGA.BRCA.sampleMap/HiSeqV2", "type": "gene_expression", "cohort": "TCGA-BRCA", "size_bytes": 50000, "last_modified": "2024-01-01"},
        {"dataset_id": "TCGA.LUAD.sampleMap/clinical.tsv", "name": "TCGA.LUAD.sampleMap/clinical.tsv", "type": "clinical", "cohort": "TCGA-LUAD", "size_bytes": 5000, "last_modified": "2024-01-01"},
    ]

    ctx = _make_ctx(task_id="test_xena_search_all")
    with patch("app.skills.builtin.acquisition.xena._fetch_hub_index", return_value=mock_datasets):
        args = json.dumps({"term": "", "max_results": 50})
        result = asyncio.run(search_xena.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["count"] == 2


# ---------------------------------------------------------------------------
# download_xena
# ---------------------------------------------------------------------------


def test_download_xena_success() -> None:
    """download_xena downloads, decompresses, and tracks provenance."""
    # Create real gzipped content
    raw_content = b"gene\tsample1\tsample2\nBRCA1\t1.5\t2.0\nTP53\t3.1\t1.8\n"
    gz_content = gzip.compress(raw_content)

    mock_resp = _mock_urlopen_streaming(gz_content)

    ctx = _make_ctx(task_id="test_xena_download")
    ctx.tool_name = "download_xena"
    with patch("urllib.request.urlopen", return_value=mock_resp):
        args = json.dumps({
            "dataset_id": "TCGA.BRCA.sampleMap/HiSeqV2",
            "file_type": "tsv",
        })
        result = asyncio.run(download_xena.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["source"] == "xena"
    assert "TCGA.BRCA.sampleMap/HiSeqV2" in data["dataset_id"]
    assert "source_url" in data
    assert len(data["local_files"]) == 2  # .gz + decompressed
    assert data["format_hint"] == "xena_tsv"

    rc: RunContext = ctx.context
    assert len(rc.raw_assets) == 1
    assert len(rc.sources) == 1
    assert rc.sources[0].database.value == "ucsc_xena"


def test_download_xena_network_error_returns_error_json() -> None:
    """download_xena returns error JSON on network failure."""
    ctx = _make_ctx(task_id="test_xena_dl_err")
    ctx.tool_name = "download_xena"
    with patch("urllib.request.urlopen", side_effect=ConnectionError("403 Forbidden")):
        args = json.dumps({
            "dataset_id": "TCGA.BRCA.sampleMap/HiSeqV2",
            "file_type": "tsv",
        })
        result = asyncio.run(download_xena.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["source"] == "xena"
    assert "error" in data
    assert "download failed" in data["error"].lower()


def test_download_xena_403_returns_error_json() -> None:
    """download_xena returns error JSON on HTTP 403."""
    from urllib.error import HTTPError

    http_err = HTTPError(
        url="https://toil-xena-hub.s3.us-east-1.amazonaws.com/download/test.tsv.gz",
        code=403,
        msg="Forbidden",
        hdrs=None,
        fp=None,
    )

    ctx = _make_ctx(task_id="test_xena_dl_403")
    ctx.tool_name = "download_xena"
    with patch("urllib.request.urlopen", side_effect=http_err):
        args = json.dumps({
            "dataset_id": "TCGA.BRCA.sampleMap/HiSeqV2",
            "file_type": "tsv",
        })
        result = asyncio.run(download_xena.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["source"] == "xena"
    assert "error" in data
    assert "download failed" in data["error"].lower()


def test_download_xena_url_uses_gz_not_tsv_gz() -> None:
    """download_xena constructs URL as {dataset_id}.gz, NOT {dataset_id}.tsv.gz.

    This is the core fix for the 403 bug: Xena files are stored as .gz (not
    .tsv.gz), and forcing the .tsv suffix produced non-existent keys that S3
    rejects with 403 (because the bucket denies anonymous ListBucket).
    """
    raw_content = b"gene\tsample1\nBRCA1\t1.5\n"
    gz_content = gzip.compress(raw_content)
    mock_resp = _mock_urlopen_streaming(gz_content)

    ctx = _make_ctx(task_id="test_xena_url_gz")
    ctx.tool_name = "download_xena"
    with patch("urllib.request.urlopen", return_value=mock_resp) as mock_urlopen:
        args = json.dumps({
            "dataset_id": "TCGA.BRCA.sampleMap/HiSeqV2",
            "file_type": "tsv",
        })
        result = asyncio.run(download_xena.on_invoke_tool(ctx, args))

    # Capture the Request object passed to urlopen
    called_request = mock_urlopen.call_args[0][0]
    url = called_request.full_url

    # URL must be {base}.gz, NOT {base}.tsv.gz
    assert url == "https://toil-xena-hub.s3.us-east-1.amazonaws.com/download/TCGA.BRCA.sampleMap/HiSeqV2.gz"
    assert ".tsv.gz" not in url, f"URL should not contain .tsv.gz, got: {url}"
    assert url.endswith(".gz")

    # Verify the tool still succeeded
    data = json.loads(result)
    assert data["source"] == "xena"
    assert "error" not in data


def test_download_xena_url_decodes_percent_2f() -> None:
    """download_xena normalizes %2F to / in dataset_id via urllib.parse.unquote.

    S3 does not decode %2F in keys — it treats it as three literal characters.
    The fix uses unquote() so callers may pass either "probeMap/foo" or
    "probeMap%2Ffoo" and both produce the correct URL.
    """
    raw_content = b"probe\tvalue\nhugo_gencode\t1\n"
    gz_content = gzip.compress(raw_content)
    mock_resp = _mock_urlopen_streaming(gz_content)

    ctx = _make_ctx(task_id="test_xena_url_pct2f")
    ctx.tool_name = "download_xena"
    with patch("urllib.request.urlopen", return_value=mock_resp) as mock_urlopen:
        args = json.dumps({
            "dataset_id": "probeMap%2Fhugo_gencode_good_hg19_V24lift37",
            "file_type": "tsv",
        })
        result = asyncio.run(download_xena.on_invoke_tool(ctx, args))

    called_request = mock_urlopen.call_args[0][0]
    url = called_request.full_url

    # %2F must be decoded to / in the URL
    assert "%2F" not in url, f"URL should not contain %2F, got: {url}"
    assert "probeMap/hugo_gencode_good_hg19_V24lift37.gz" in url
    assert url == "https://toil-xena-hub.s3.us-east-1.amazonaws.com/download/probeMap/hugo_gencode_good_hg19_V24lift37.gz"

    data = json.loads(result)
    assert data["source"] == "xena"
    assert "error" not in data
