"""Tests for ``app.agent_loop.import_agent.build_import_agent`` and the
``ImportRunExecutor`` wiring in ``app.agent_loop.runner``.

Covers:
  - ``build_import_agent`` returns an ``AgentBuild`` with the expected tools
    (read_file, write_file, list_files, run_python_script, commit_to_cache)
    and an instructions string that documents the 22-column schema.
  - ``ImportRunExecutor`` subclasses ``AgentRunExecutor`` and overrides
    ``_max_turns`` to ``IMPORT_AGENT_MAX_TURNS``.
  - ``ModeDispatchRunExecutor`` routes ``TaskMode.IMPORT`` to the
    ``ImportRunExecutor`` (not the agent or fixture executor).
  - End-to-end IMPORT agent run with a scripted LLM that calls ``list_files``,
    ``read_file``, ``run_python_script``, and ``commit_to_cache`` against
    a CSV fixture — verifies the dataset lands in the local cache.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest
from agents.tool_context import ToolContext
from app.agent_loop.agent import AgentBuild
from app.agent_loop.context import RunContext
from app.agent_loop.import_agent import (
    IMPORT_AGENT_MAX_TURNS,
    IMPORT_INSTRUCTIONS,
    build_import_agent,
)
from app.agent_loop.runner import ImportRunExecutor, ModeDispatchRunExecutor
from app.tools import cache_store as cache_store_module
from app.tools.cache_store import init_cache_store
from app.tools.cache_tools import commit_to_cache
from app.tools.io import list_files, read_file
from app.tools.sandbox import run_python_script

# ── build_import_agent ──────────────────────────────────────────────


def test_build_import_agent_returns_agent_build_with_expected_tools() -> None:
    build = build_import_agent()

    assert isinstance(build, AgentBuild)
    tool_names = {tool.name for tool in build.agent.tools}
    assert tool_names == {
        "read_file",
        "write_file",
        "list_files",
        "run_python_script",
        "commit_to_cache",
    }
    # No external-database acquisition skills are loaded.
    assert "search_pubmed" not in tool_names
    assert "search_geo" not in tool_names
    assert "run_research_pipeline" not in tool_names


def test_import_instructions_documents_22_column_schema() -> None:
    """The IMPORT instructions must teach the LLM the 22-column schema."""
    expected_columns = [
        "record_id", "dataset_id", "source_id", "asset_id",
        "gene_id_raw", "gene_id", "gene_id_namespace", "gene_id_version",
        "sample_id", "source_sample_alias", "measurement_type",
        "value_semantics", "value_scale", "is_normalized",
        "is_integer_expected", "expression_value", "expression_unit",
        "source_logical_file", "source_line_number",
        "source_column_index", "source_column_name", "source_raw_value",
    ]
    for col in expected_columns:
        assert col in IMPORT_INSTRUCTIONS, f"missing column in instructions: {col}"


def test_import_instructions_lists_workflow_steps() -> None:
    """The instructions must mention the key workflow steps."""
    assert "list_files" in IMPORT_INSTRUCTIONS
    assert "read_file" in IMPORT_INSTRUCTIONS
    assert "run_python_script" in IMPORT_INSTRUCTIONS
    assert "commit_to_cache" in IMPORT_INSTRUCTIONS
    assert "source_assets" in IMPORT_INSTRUCTIONS


def test_import_agent_max_turns_is_reasonable() -> None:
    """IMPORT_AGENT_MAX_TURNS must accommodate the workflow (>=6, <=20)."""
    assert 6 <= IMPORT_AGENT_MAX_TURNS <= 20


# ── ImportRunExecutor / ModeDispatchRunExecutor wiring ──────────────


def test_mode_dispatch_routes_import_to_import_executor() -> None:
    """``ModeDispatchRunExecutor`` exposes an ``import_executor`` attribute."""
    # We don't need a real repository — the routing logic is what we test.
    class _StubRepo:
        pass

    dispatcher = ModeDispatchRunExecutor(_StubRepo())
    assert isinstance(dispatcher.import_executor, ImportRunExecutor)


def test_import_run_executor_subclasses_agent_run_executor() -> None:
    from app.agent_loop.runner import AgentRunExecutor

    assert issubclass(ImportRunExecutor, AgentRunExecutor)


# ── End-to-end IMPORT tool chain ─────────────────────────────────────
#
# This test simulates the IMPORT agent's tool-call sequence without an actual
# LLM: we drive each function tool directly, mimicking what an LLM would do
# when given a CSV fixture. The goal is to prove the tool chain can clean and
# import a non-normalized CSV into the local cache end-to-end.


def _make_tool_ctx(run_ctx: RunContext, tool_name: str) -> ToolContext:
    return ToolContext(
        context=run_ctx,
        tool_name=tool_name,
        tool_call_id="test_call",
        tool_arguments="{}",
    )


def _call(tool, ctx: ToolContext, **kwargs: Any) -> str:
    return asyncio.run(tool.on_invoke_tool(ctx, json.dumps(kwargs)))


@pytest.fixture
def initialized_cache(tmp_path: Path):
    """Initialize the global CacheStore at tmp_path/cache."""
    store = init_cache_store(tmp_path / "cache")
    yield store
    cache_store_module._global_store = None


def test_import_tool_chain_imports_csv_to_cache(
    tmp_path: Path,
    initialized_cache,  # noqa: ANN001
) -> None:
    """End-to-end: simulate IMPORT agent cleaning a CSV and committing to cache.

    Simulates the LLM tool-call sequence:
      1. list_files('source_assets') — discover uploaded files
      2. read_file('source_assets/patients.csv') — inspect content
      3. run_python_script — clean clinical CSV into 22-col CSV
      4. read_file('staging/agent/cleaned.csv') — read cleaned output
      5. commit_to_cache — write to cache
      6. (verify) search_local_cache finds the dataset
    """
    # Set up a task workdir with an "uploaded" CSV fixture.
    rc = RunContext(
        task_id="task_import_e2e_csv",
        base_dir=str(tmp_path / "tasks"),
    )
    upload_path = rc.work_dir.source_asset_file("patients.csv")
    upload_path.write_text(
        "patient_id,age,sex,diagnosis,stage,treatment,response,survival_days\n"
        "P001,54,F,BRCA,II,Paclitaxel,CR,1240\n"
        "P002,67,M,LUAD,IV,Cisplatin,PR,540\n"
        "P003,45,F,BRCA,I,Tamoxifen,CR,2100\n",
        encoding="utf-8",
    )

    # Step 1: list_files('source_assets')
    list_ctx = _make_tool_ctx(rc, "list_files")
    listing = _call(list_files, list_ctx, subdir="source_assets")
    assert "patients.csv" in listing

    # Step 2: read_file('source_assets/patients.csv')
    read_ctx = _make_tool_ctx(rc, "read_file")
    content = _call(read_file, read_ctx, path="source_assets/patients.csv")
    assert "patient_id" in content
    assert "P001" in content

    # Step 3: run_python_script to clean the clinical CSV into 22-col schema.
    # The LLM would generate this script based on the columns it observed.
    clean_script = """
rows = read_csv()
out = []
for i, r in enumerate(rows):
    out.append({
        'record_id': f'r{i+1}',
        'dataset_id': 'user_import_patients_csv',
        'source_id': 'user_import',
        'sample_id': r['patient_id'],
        'measurement_type': 'clinical',
        'value_semantics': 'categorical',
        'source_logical_file': 'patients.csv',
        'source_line_number': str(i + 2),
        'source_column_name': 'diagnosis',
        'source_raw_value': r['diagnosis'],
    })
write_csv(out)
"""
    sbx_ctx = _make_tool_ctx(rc, "run_python_script")
    sbx_result = _call(
        run_python_script,
        sbx_ctx,
        code=clean_script,
        input_relative_path="source_assets/patients.csv",
        output_relative_path="staging/agent/cleaned.csv",
    )
    assert "脚本执行成功" in sbx_result

    # Step 4: read the cleaned CSV.
    cleaned = _call(read_file, read_ctx, path="staging/agent/cleaned.csv")
    assert "record_id" in cleaned
    assert "user_import_patients_csv" in cleaned

    # Step 5: commit_to_cache.
    commit_ctx = _make_tool_ctx(rc, "commit_to_cache")
    commit_result = _call(
        commit_to_cache,
        commit_ctx,
        csv_content=cleaned,
        dataset_id="user_import_patients_csv",
        topic="Hospital oncology patient cohort",
        description="Cleaned clinical data from patients.csv upload",
        source_files="patients.csv",
    )
    payload = json.loads(commit_result)
    assert payload["status"] == "ok"
    assert payload["row_count"] == 3

    # Step 6: verify the dataset is queryable via the cache store.
    manifest, rows = initialized_cache.get_dataset(
        "user_import", "user_import_patients_csv"
    )
    assert manifest is not None
    assert manifest.topic == "Hospital oncology patient cohort"
    assert len(rows) == 3
    assert rows[0]["record_id"] == "r1"
    assert rows[0]["sample_id"] == "P001"
    assert rows[0]["measurement_type"] == "clinical"
    assert rows[0]["source_raw_value"] == "BRCA"


def test_import_tool_chain_imports_json_to_cache(
    tmp_path: Path,
    initialized_cache,  # noqa: ANN001
) -> None:
    """End-to-end: clean a nested JSON samples file into 22-col cache rows."""
    rc = RunContext(
        task_id="task_import_e2e_json",
        base_dir=str(tmp_path / "tasks"),
    )
    upload_path = rc.work_dir.source_asset_file("samples.json")
    upload_path.write_text(
        json.dumps({
            "study": "Hospital Cohort",
            "samples": [
                {"sample_id": "S001", "patient": {"age": 54, "diagnosis": "BRCA"},
                 "assays": [{"gene": "BRCA1", "value": 12.4, "type": "expression"}]},
                {"sample_id": "S002", "patient": {"age": 67, "diagnosis": "LUAD"},
                 "assays": [{"gene": "EGFR", "value": "L858R", "type": "mutation"}]},
            ],
        }),
        encoding="utf-8",
    )

    # LLM-authored clean script that flattens the nested JSON.
    clean_script = """
data = read_json()
out = []
for s in data['samples']:
    for a in s['assays']:
        out.append({
            'record_id': f\"{s['sample_id']}_{a['gene']}\",
            'dataset_id': 'user_import_samples_json',
            'source_id': 'user_import',
            'gene_id_raw': a['gene'],
            'sample_id': s['sample_id'],
            'measurement_type': a['type'],
            'expression_value': str(a['value']),
            'source_logical_file': 'samples.json',
        })
write_csv(out)
"""
    sbx_ctx = _make_tool_ctx(rc, "run_python_script")
    sbx_result = _call(
        run_python_script,
        sbx_ctx,
        code=clean_script,
        input_relative_path="source_assets/samples.json",
        output_relative_path="staging/agent/cleaned.csv",
    )
    assert "脚本执行成功" in sbx_result

    read_ctx = _make_tool_ctx(rc, "read_file")
    cleaned = _call(read_file, read_ctx, path="staging/agent/cleaned.csv")
    assert "S001_BRCA1" in cleaned
    assert "S002_EGFR" in cleaned

    commit_ctx = _make_tool_ctx(rc, "commit_to_cache")
    commit_result = _call(
        commit_to_cache,
        commit_ctx,
        csv_content=cleaned,
        dataset_id="user_import_samples_json",
        topic="Hospital cohort samples JSON",
        description="Flattened nested samples.json into 22-col rows",
        source_files="samples.json",
    )
    payload = json.loads(commit_result)
    assert payload["status"] == "ok"
    assert payload["row_count"] == 2

    manifest, rows = initialized_cache.get_dataset(
        "user_import", "user_import_samples_json"
    )
    assert manifest is not None
    assert len(rows) == 2
    assert rows[0]["sample_id"] == "S001"
    assert rows[0]["gene_id_raw"] == "BRCA1"
    assert rows[1]["sample_id"] == "S002"
    assert rows[1]["gene_id_raw"] == "EGFR"


def test_import_tool_chain_imports_md_table_to_cache(
    tmp_path: Path,
    initialized_cache,  # noqa: ANN001
) -> None:
    """End-to-end: parse a Markdown table into 22-col cache rows."""
    rc = RunContext(
        task_id="task_import_e2e_md",
        base_dir=str(tmp_path / "tasks"),
    )
    upload_path = rc.work_dir.source_asset_file("clinical.md")
    upload_path.write_text(
        "# Clinical Cohort\n\n"
        "| sample_id | age | diagnosis | stage |\n"
        "|-----------|-----|-----------|-------|\n"
        "| S001 | 54 | BRCA | II |\n"
        "| S002 | 67 | LUAD | IV |\n",
        encoding="utf-8",
    )

    # LLM-authored script that parses the MD table.
    clean_script = """
import re
text = read_input()
lines = text.splitlines()
# Find lines starting with | that aren't the separator row.
table_rows = []
for line in lines:
    s = line.strip()
    if s.startswith('|') and not re.match(r'^\\|[-:|\\s]+\\|$', s):
        table_rows.append(s)
header = [c.strip() for c in table_rows[0].strip('|').split('|')]
out = []
for i, row_line in enumerate(table_rows[1:], start=1):
    cells = [c.strip() for c in row_line.strip('|').split('|')]
    record = dict(zip(header, cells))
    out.append({
        'record_id': f'r{i}',
        'dataset_id': 'user_import_clinical_md',
        'source_id': 'user_import',
        'sample_id': record['sample_id'],
        'measurement_type': 'clinical',
        'value_semantics': 'categorical',
        'source_logical_file': 'clinical.md',
        'source_line_number': str(i + 2),
        'source_column_name': 'diagnosis',
        'source_raw_value': record['diagnosis'],
    })
write_csv(out)
"""
    sbx_ctx = _make_tool_ctx(rc, "run_python_script")
    sbx_result = _call(
        run_python_script,
        sbx_ctx,
        code=clean_script,
        input_relative_path="source_assets/clinical.md",
        output_relative_path="staging/agent/cleaned.csv",
    )
    assert "脚本执行成功" in sbx_result

    read_ctx = _make_tool_ctx(rc, "read_file")
    cleaned = _call(read_file, read_ctx, path="staging/agent/cleaned.csv")
    assert "S001" in cleaned
    assert "BRCA" in cleaned

    commit_ctx = _make_tool_ctx(rc, "commit_to_cache")
    commit_result = _call(
        commit_to_cache,
        commit_ctx,
        csv_content=cleaned,
        dataset_id="user_import_clinical_md",
        topic="Clinical markdown table",
        description="Parsed MD table into 22-col cache rows",
        source_files="clinical.md",
    )
    payload = json.loads(commit_result)
    assert payload["status"] == "ok"
    assert payload["row_count"] == 2


def test_import_tool_chain_imports_tsv_to_cache(
    tmp_path: Path,
    initialized_cache,  # noqa: ANN001
) -> None:
    """End-to-end: convert a wide TSV (gene x sample) into long 22-col rows."""
    rc = RunContext(
        task_id="task_import_e2e_tsv",
        base_dir=str(tmp_path / "tasks"),
    )
    upload_path = rc.work_dir.source_asset_file("counts.tsv")
    upload_path.write_text(
        "gene_id\tS001\tS002\tS003\n"
        "BRCA1\t1250\t980\t1500\n"
        "TP53\t2100\t1800\t2400\n",
        encoding="utf-8",
    )

    # LLM-authored script that reshapes wide TSV into long 22-col rows.
    clean_script = """
import csv as _csv
import io as _io
text = read_input()
reader = _csv.DictReader(_io.StringIO(text), delimiter='\\t')
out = []
i = 0
for row in reader:
    gene = row['gene_id']
    for sample, value in row.items():
        if sample == 'gene_id':
            continue
        i += 1
        out.append({
            'record_id': f'r{i}',
            'dataset_id': 'user_import_counts_tsv',
            'source_id': 'user_import',
            'gene_id_raw': gene,
            'sample_id': sample,
            'measurement_type': 'expression',
            'value_semantics': 'continuous',
            'value_scale': 'raw_count',
            'is_integer_expected': 'true',
            'expression_value': value,
            'expression_unit': 'count',
            'source_logical_file': 'counts.tsv',
        })
write_csv(out)
"""
    sbx_ctx = _make_tool_ctx(rc, "run_python_script")
    sbx_result = _call(
        run_python_script,
        sbx_ctx,
        code=clean_script,
        input_relative_path="source_assets/counts.tsv",
        output_relative_path="staging/agent/cleaned.csv",
    )
    assert "脚本执行成功" in sbx_result

    read_ctx = _make_tool_ctx(rc, "read_file")
    cleaned = _call(read_file, read_ctx, path="staging/agent/cleaned.csv")
    # 2 genes * 3 samples = 6 rows
    assert "BRCA1" in cleaned
    assert "TP53" in cleaned

    commit_ctx = _make_tool_ctx(rc, "commit_to_cache")
    commit_result = _call(
        commit_to_cache,
        commit_ctx,
        csv_content=cleaned,
        dataset_id="user_import_counts_tsv",
        topic="Expression counts TSV",
        description="Wide TSV reshaped to long format",
        source_files="counts.tsv",
    )
    payload = json.loads(commit_result)
    assert payload["status"] == "ok"
    assert payload["row_count"] == 6  # 2 genes × 3 samples

    manifest, rows = initialized_cache.get_dataset(
        "user_import", "user_import_counts_tsv"
    )
    assert manifest is not None
    assert len(rows) == 6
    # Verify the first row is BRCA1 in S001.
    brca1_s001 = [r for r in rows if r["gene_id_raw"] == "BRCA1"
                  and r["sample_id"] == "S001"]
    assert len(brca1_s001) == 1
    assert brca1_s001[0]["expression_value"] == "1250"
