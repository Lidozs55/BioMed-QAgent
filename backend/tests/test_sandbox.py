"""Unit tests for ``app.tools.sandbox``.

Covers:
  - ``validate_sandbox_code`` accepts whitelisted imports + rejects forbidden
    modules (os, subprocess, shutil, pathlib) and forbidden calls (exec/eval/
    open/...) and dunder access.
  - ``run_sandbox_script`` executes a script that reads INPUT_PATH via
    ``read_input()`` / ``read_csv()`` / ``read_json()`` and writes via
    ``write_output()`` / ``write_csv()`` / ``write_json()``.
  - The injected ``open`` is guarded: scripts cannot read/write arbitrary paths.
  - Subprocess returns non-zero on script error, and ``stderr`` is surfaced.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from app.tools.sandbox import (
    SANDBOX_ALLOWED_MODULES,
    SandboxResult,
    run_sandbox_script,
    validate_sandbox_code,
)

# ── validate_sandbox_code ────────────────────────────────────────────


def test_validate_accepts_empty_code() -> None:
    validate_sandbox_code("")


def test_validate_accepts_whitelisted_imports() -> None:
    code = "import csv\nimport json\nimport re\nimport statistics\n"
    validate_sandbox_code(code)


def test_validate_accepts_from_imports_for_whitelisted() -> None:
    code = "from csv import DictReader\nfrom collections import defaultdict\n"
    validate_sandbox_code(code)


@pytest.mark.parametrize(
    "module",
    ["os", "subprocess", "shutil", "pathlib", "socket", "sys", "builtins"],
)
def test_validate_rejects_forbidden_modules(module: str) -> None:
    code = f"import {module}\n"
    with pytest.raises(ValueError, match="not allowed in sandbox"):
        validate_sandbox_code(code)


@pytest.mark.parametrize(
    "module",
    ["os", "subprocess", "pathlib"],
)
def test_validate_rejects_forbidden_from_imports(module: str) -> None:
    code = f"from {module} import Path\n"
    with pytest.raises(ValueError, match="not allowed in sandbox"):
        validate_sandbox_code(code)


@pytest.mark.parametrize(
    "call",
    ["exec", "eval", "compile", "open", "__import__",
     "globals", "locals", "vars", "breakpoint"],
)
def test_validate_rejects_forbidden_calls(call: str) -> None:
    code = f"x = {call}()\n"
    with pytest.raises(ValueError, match="forbidden"):
        validate_sandbox_code(code)


def test_validate_rejects_dunder_attribute_access() -> None:
    code = "x = obj.__class__\n"
    with pytest.raises(ValueError, match="dunder"):
        validate_sandbox_code(code)


def test_validate_rejects_dunder_name_use() -> None:
    code = "x = __import__\n"
    with pytest.raises(ValueError, match="dunder"):
        validate_sandbox_code(code)


def test_validate_rejects_syntax_error() -> None:
    with pytest.raises(ValueError, match="syntax error"):
        validate_sandbox_code("def f(:\n")


def test_sandbox_allowed_modules_includes_data_libraries() -> None:
    """The sandbox whitelist must include common data-processing libs."""
    expected_subset = {
        "csv", "json", "re", "math", "itertools", "collections",
        "statistics", "datetime", "decimal", "fractions", "hashlib", "io",
    }
    assert expected_subset.issubset(SANDBOX_ALLOWED_MODULES)


# ── run_sandbox_script — successful executions ──────────────────────


def test_run_script_writes_output_via_write_output(tmp_path: Path) -> None:
    input_path = tmp_path / "input.txt"
    output_path = tmp_path / "output.txt"
    input_path.write_text("hello world", encoding="utf-8")

    code = "data = read_input()\nwrite_output(data.upper())\n"
    result = run_sandbox_script(code, input_path=input_path, output_path=output_path)

    assert result.exit_code == 0
    assert result.output_text == "HELLO WORLD"
    assert output_path.read_text(encoding="utf-8") == "HELLO WORLD"


def test_run_script_reads_csv_and_writes_csv(tmp_path: Path) -> None:
    input_path = tmp_path / "in.csv"
    output_path = tmp_path / "out.csv"
    input_path.write_text(
        "gene,value\nBRCA1,1.5\nTP53,2.0\n",
        encoding="utf-8",
    )

    code = (
        "rows = read_csv()\n"
        "out = [{'gene': r['gene'], 'doubled': str(float(r['value']) * 2)} "
        "for r in rows]\n"
        "write_csv(out)\n"
    )
    result = run_sandbox_script(code, input_path=input_path, output_path=output_path)

    assert result.exit_code == 0
    out_text = output_path.read_text(encoding="utf-8-sig")
    assert "gene,doubled" in out_text
    assert "BRCA1,3.0" in out_text
    assert "TP53,4.0" in out_text


def test_run_script_reads_json_and_writes_json(tmp_path: Path) -> None:
    input_path = tmp_path / "in.json"
    output_path = tmp_path / "out.json"
    input_path.write_text(
        json.dumps({"samples": [{"id": "S1", "val": 10}, {"id": "S2", "val": 20}]}),
        encoding="utf-8",
    )

    code = (
        "data = read_json()\n"
        "total = sum(s['val'] for s in data['samples'])\n"
        "write_json({'total': total, 'count': len(data['samples'])})\n"
    )
    result = run_sandbox_script(code, input_path=input_path, output_path=output_path)

    assert result.exit_code == 0
    out_data = json.loads(output_path.read_text(encoding="utf-8"))
    assert out_data == {"total": 30, "count": 2}


def test_run_script_can_use_math_and_statistics(tmp_path: Path) -> None:
    input_path = tmp_path / "in.txt"
    output_path = tmp_path / "out.txt"
    input_path.write_text("1,2,3,4,5", encoding="utf-8")

    # NB: the f-string inside the script must be evaluated by the sandbox,
    # not by the test. We build the script as a plain string so ``math`` and
    # ``statistics`` are resolved at sandbox runtime, not at test collection.
    code = (
        "import math\n"
        "import statistics\n"
        "raw = read_input()\n"
        "nums = [float(x) for x in raw.split(',')]\n"
        "mean_val = statistics.mean(nums)\n"
        "sqrt_max = math.sqrt(max(nums))\n"
        "write_output('mean={:.2f};sqrt_max={:.2f}'.format(mean_val, sqrt_max))\n"
    )
    result = run_sandbox_script(code, input_path=input_path, output_path=output_path)

    assert result.exit_code == 0
    assert "mean=3.00" in result.output_text
    assert "sqrt_max=2.24" in result.output_text


# ── run_sandbox_script — security: open is guarded ──────────────────


def test_run_script_blocks_open_of_arbitrary_path(tmp_path: Path) -> None:
    input_path = tmp_path / "in.txt"
    output_path = tmp_path / "out.txt"
    secret_path = tmp_path / "secret.txt"
    secret_path.write_text("top secret", encoding="utf-8")
    input_path.write_text("ignored", encoding="utf-8")

    # AST validation must reject direct ``open(...)`` calls.
    code = f"open({str(secret_path)!r})\n"
    with pytest.raises(ValueError, match="forbidden"):
        run_sandbox_script(code, input_path=input_path, output_path=output_path)


def test_run_script_blocks_import_os_to_access_filesystem(
    tmp_path: Path,
) -> None:
    input_path = tmp_path / "in.txt"
    output_path = tmp_path / "out.txt"
    input_path.write_text("ignored", encoding="utf-8")

    code = "import os\nos.listdir('/')\n"
    with pytest.raises(ValueError, match="not allowed in sandbox"):
        run_sandbox_script(code, input_path=input_path, output_path=output_path)


# ── run_sandbox_script — error handling ─────────────────────────────


def test_run_script_returns_nonzero_on_runtime_error(tmp_path: Path) -> None:
    input_path = tmp_path / "in.txt"
    output_path = tmp_path / "out.txt"
    input_path.write_text("data", encoding="utf-8")

    code = "raise ValueError('boom')\n"
    result = run_sandbox_script(code, input_path=input_path, output_path=output_path)

    assert result.exit_code != 0
    assert "boom" in result.stderr


def test_run_script_returns_no_output_when_write_output_not_called(
    tmp_path: Path,
) -> None:
    input_path = tmp_path / "in.txt"
    output_path = tmp_path / "out.txt"
    input_path.write_text("data", encoding="utf-8")

    code = "x = 1 + 1\n"
    result = run_sandbox_script(code, input_path=input_path, output_path=output_path)

    assert result.exit_code == 0
    assert result.output_text == ""
    assert result.output_path is None


def test_sandbox_result_dataclass_fields() -> None:
    """Sanity-check the SandboxResult dataclass shape."""
    result = SandboxResult(
        exit_code=0,
        stdout="",
        stderr="",
        output_text="",
        output_path=None,
    )
    assert result.exit_code == 0
    assert result.output_path is None
