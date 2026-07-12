from __future__ import annotations

import asyncio
import hashlib
import json
import os
from pathlib import Path

import pytest

from app.agent_loop.context import RunContext
from app.integrations.ncbi.factory import open_ncbi_services
from app.skills.builtin.acquisition.geo import download_geo_adapter, search_geo_adapter
from app.skills.builtin.discovery.pubmed import search_pubmed_adapter
from app.tools.workdir import create_task_workdir


pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(
        os.getenv("RUN_NCBI_LIVE") != "1",
        reason="set RUN_NCBI_LIVE=1 to permit live NCBI network acceptance",
    ),
]


@pytest.mark.asyncio
async def test_gse178352_live_acceptance(tmp_path: Path) -> None:
    context = RunContext(task_id="gse178352_live")
    context._work_dir = create_task_workdir(  # noqa: SLF001 - isolated live run
        "gse178352_live", base_dir=str(tmp_path / "tasks")
    )

    async with asyncio.timeout(180):
        async with open_ncbi_services(cache_root=tmp_path / "cache") as services:
            pubmed = json.loads(await search_pubmed_adapter(
                context, "34180400[PMID]", 1, services=services
            ))
            geo = json.loads(await search_geo_adapter(
                context, "GSE178352[Accession]", 20, services=services
            ))
            download = json.loads(await download_geo_adapter(
                context,
                "GSE178352",
                "suppl",
                services=services,
                max_size_mb=10,
                expected_size=4_597_797,
                expected_sha256=(
                    "71e78e43fbd0db021c243feb8d935850d2c95bbfeba884d42f6dd78bfa753a55"
                ),
            ))

    assert pubmed["records"][0]["pmid"] == "34180400"
    assert geo["accessions"] == ["GSE178352"]
    assert geo["records"][0]["sample_count"] == 12
    asset = download["asset"]
    assert asset["size_bytes"] == 4_597_797
    assert asset["sha256"] == (
        "71e78e43fbd0db021c243feb8d935850d2c95bbfeba884d42f6dd78bfa753a55"
    )
    path = context.work_dir.root / asset["relative_path"]
    assert hashlib.sha256(path.read_bytes()).hexdigest() == asset["sha256"]
    assert path.suffix == ".gz"

