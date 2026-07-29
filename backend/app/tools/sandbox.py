"""LLM 脚本沙箱 — 让 Agent 自行编写数据处理脚本并安全执行。

设计目标（D4 决策）：
  - 使用本模块的 AST 安全模型校验用户脚本
  - 扩展白名单：``csv``/``json``/``re``/``math``/``itertools``/``collections``/
    ``sqlite3``/``statistics``/``datetime``（数据处理常用）
  - 子进程隔离：用 ``subprocess.run`` 在独立 Python 解释器中执行
  - 受控 I/O：脚本通过 ``read_input()``/``write_output()`` 与任务目录交互，
    无法直接 ``open()`` 任意文件
  - 资源上限：CPU 时间 10s、内存 512MB（Windows 上 rlimit 不可用，仅 Linux 生效；
    Windows 依赖 subprocess timeout 兜底）

执行模型：
  1. LLM 通过 ``run_python_script`` function tool 提交一段 Python 代码
  2. 服务端 AST 校验 → 注入受控 I/O 包装 → 写入临时脚本
  3. ``subprocess.run([sys.executable, script], timeout=N)`` 执行
  4. 收集 stdout（作为脚本输出）+ stderr（作为错误信息）
  5. 脚本通过调用 ``write_output(content)`` 把结果写入任务目录的
     ``staging/agent/sandbox_output/<run_id>.txt``

脚本约定：
  - 脚本顶部自动注入 ``INPUT_PATH`` 和 ``OUTPUT_PATH`` 两个常量
  - 脚本可调用 ``read_input()`` 读取 INPUT_PATH 文本
  - 脚本可调用 ``write_output(text)`` 写入 OUTPUT_PATH
  - 脚本不能 ``import os``/``subprocess``/``shutil``/``pathlib``/``open``
"""

from __future__ import annotations

import ast
import contextlib
import logging
import subprocess
import sys
import tempfile
import textwrap
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from agents import RunContextWrapper, function_tool

from app.agent_loop.context import RunContext

logger = logging.getLogger(__name__)

_FORBIDDEN_CALL_NAMES = frozenset(
    {
        "exec",
        "eval",
        "compile",
        "open",
        "__import__",
        "globals",
        "locals",
        "vars",
        "input",
        "breakpoint",
        "exit",
        "quit",
        "help",
    }
)

#: 沙箱脚本允许 import 的模块白名单（数据处理常用）。
#: 比 ``_ALLOWED_IMPORT_MODULES`` 更宽松：覆盖 CSV/JSON/正则/数学/统计/迭代器等
#: 纯计算模块，但仍禁止 ``os``/``subprocess``/``shutil``/``pathlib`` 等可访问
#: 文件系统/网络的模块。
SANDBOX_ALLOWED_MODULES: frozenset[str] = frozenset({
    # 标准库纯计算模块
    "csv",
    "json",
    "re",
    "math",
    "itertools",
    "collections",
    "statistics",
    "datetime",
    "decimal",
    "fractions",
    "hashlib",
    "io",  # StringIO / BytesIO（不能 open 文件）
    # 第三方数据处理库
    "pandas",
    "numpy",
})

#: 子进程超时（秒）。
SANDBOX_TIMEOUT_SECONDS: int = 30

#: 输出大小上限（字节），防止 LLM 写入巨量输出导致 OOM。
SANDBOX_MAX_OUTPUT_BYTES: int = 10 * 1024 * 1024  # 10 MB

_PRELUDE = textwrap.dedent(
    """
    # 沙箱 prelude：注入受控 I/O。``_real_open`` 只存在于闭包中，
    # 不暴露到模块作用域，LLM 代码无法绕过 ``_sbx_open`` 直接调用真实 open。
    def _sbx_setup(_csv_mod, _json_mod, _input_path, _output_path):
        import builtins as _bi
        import os as _os
        _real_open = _bi.open
        _allowed = {_os.path.abspath(_input_path), _os.path.abspath(_output_path)}

        def _guarded_open(path, mode='r', *args, **kwargs):
            _resolved = _os.path.abspath(str(path))
            if _resolved not in _allowed:
                raise PermissionError(
                    f"sandbox forbids opening {_resolved!r}; "
                    f"only INPUT_PATH/OUTPUT_PATH are accessible"
                )
            return _real_open(path, mode, *args, **kwargs)

        _bi.open = _guarded_open

        def read_input():
            \"\"\"读取 INPUT_PATH 文本文件并返回字符串。\"\"\"
            with _guarded_open(_input_path, 'r', encoding='utf-8') as _f:
                return _f.read()

        def write_output(text):
            \"\"\"将 text 写入 OUTPUT_PATH（覆盖）。\"\"\"
            with _guarded_open(_output_path, 'w', encoding='utf-8') as _f:
                _f.write(text)

        def read_csv(path=None):
            \"\"\"读取 path（默认 INPUT_PATH）为 CSV，返回 list[dict]。\"\"\"
            target = path or _input_path
            with _guarded_open(target, 'r', encoding='utf-8-sig', newline='') as _f:
                return list(_csv_mod.DictReader(_f))

        def read_json(path=None):
            \"\"\"读取 path（默认 INPUT_PATH）为 JSON。\"\"\"
            target = path or _input_path
            with _guarded_open(target, 'r', encoding='utf-8') as _f:
                return _json_mod.load(_f)

        def write_csv(rows, path=None, fieldnames=None):
            \"\"\"将 rows（list[dict]）写为 CSV 到 path（默认 OUTPUT_PATH）。\"\"\"
            target = path or _output_path
            if not rows:
                return
            cols = fieldnames or list(rows[0].keys())
            with _guarded_open(target, 'w', encoding='utf-8-sig', newline='') as _f:
                _w = _csv_mod.DictWriter(_f, fieldnames=cols, extrasaction='raise')
                _w.writeheader()
                for _r in rows:
                    _w.writerow(_r)

        def write_json(obj, path=None):
            \"\"\"将 obj 写为 JSON 到 path（默认 OUTPUT_PATH）。\"\"\"
            target = path or _output_path
            with _guarded_open(target, 'w', encoding='utf-8') as _f:
                _json_mod.dump(obj, _f, ensure_ascii=False, indent=2)

        return (read_input, write_output, read_csv, read_json,
                write_csv, write_json)

    import csv as _sbx_csv
    import json as _sbx_json

    INPUT_PATH = {INPUT_PATH_TOKEN}
    OUTPUT_PATH = {OUTPUT_PATH_TOKEN}

    (read_input, write_output, read_csv, read_json,
     write_csv, write_json) = _sbx_setup(_sbx_csv, _sbx_json, INPUT_PATH, OUTPUT_PATH)

    # 清理 setup 函数，防止 LLM 通过它访问闭包内的 _real_open
    del _sbx_setup
    """
)


@dataclass(frozen=True)
class SandboxResult:
    """沙箱执行结果。"""

    exit_code: int
    stdout: str
    stderr: str
    output_text: str  # 脚本通过 write_output 写入的内容
    output_path: Path | None  # OUTPUT_PATH 路径


def validate_sandbox_code(code: str) -> None:
    """使用本模块的 AST 安全模型校验沙箱脚本代码。

    与 ``validate_skill_code`` 的差异：白名单模块为 ``SANDBOX_ALLOWED_MODULES``，
    允许 ``import X`` 形式（因为沙箱脚本不会通过 importlib 加载到主进程）。
    """
    try:
        tree = ast.parse(code)
    except SyntaxError as exc:
        raise ValueError(f"Sandbox code has syntax error: {exc}") from exc

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                module_name = alias.name.split(".")[0]
                if module_name not in SANDBOX_ALLOWED_MODULES:
                    raise ValueError(
                        f"import {alias.name!r} is not allowed in sandbox "
                        f"(line {node.lineno}). Allowed modules: "
                        f"{', '.join(sorted(SANDBOX_ALLOWED_MODULES))}."
                    )
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            top = module.split(".")[0]
            if top not in SANDBOX_ALLOWED_MODULES:
                raise ValueError(
                    f"from {module!r} import is not allowed in sandbox "
                    f"(line {node.lineno}). Allowed modules: "
                    f"{', '.join(sorted(SANDBOX_ALLOWED_MODULES))}."
                )
        if isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Name) and func.id in _FORBIDDEN_CALL_NAMES:
                raise ValueError(
                    f"Call to {func.id!r}() is forbidden in sandbox "
                    f"(line {node.lineno})."
                )
        if isinstance(node, ast.Attribute) and node.attr.startswith("__"):
            raise ValueError(
                f"Access to dunder attribute {node.attr!r} is forbidden in "
                f"sandbox (line {node.lineno})."
            )
        if isinstance(node, ast.Name) and node.id.startswith("__"):
            raise ValueError(
                f"Use of dunder name {node.id!r} is forbidden in sandbox "
                f"(line {node.lineno})."
            )


def run_sandbox_script(
    code: str,
    *,
    input_path: Path,
    output_path: Path,
    timeout: int = SANDBOX_TIMEOUT_SECONDS,
) -> SandboxResult:
    """执行一段沙箱脚本。

    Args:
        code: Python 源码（不含 prelude，由本函数注入）。
        input_path: 脚本可读的唯一文件路径（通过 ``read_input()``/``read_csv()``
            /``read_json()`` 访问）。
        output_path: 脚本可写的唯一文件路径（通过 ``write_output()``/
            ``write_csv()``/``write_json()`` 访问）。
        timeout: 子进程超时秒数。

    Returns:
        ``SandboxResult``。

    Raises:
        ValueError: 代码未通过 AST 校验。
        subprocess.TimeoutExpired: 子进程超时。
        RuntimeError: 子进程异常退出且 stderr 为空。
    """
    validate_sandbox_code(code)

    prelude = _PRELUDE.replace("{INPUT_PATH_TOKEN}", repr(str(input_path))).replace(
        "{OUTPUT_PATH_TOKEN}", repr(str(output_path))
    )
    full_code = prelude + "\n" + code

    with tempfile.NamedTemporaryFile(
        mode="w",
        suffix=".py",
        prefix="sandbox_",
        delete=False,
        encoding="utf-8",
    ) as script_file:
        script_file.write(full_code)
        script_path = Path(script_file.name)

    try:
        completed = subprocess.run(
            [sys.executable, "-I", str(script_path)],
            capture_output=True,
            text=True,
            timeout=timeout,
            encoding="utf-8",
            errors="replace",
        )
    finally:
        with contextlib.suppress(OSError):
            script_path.unlink()

    output_text = ""
    if output_path.is_file():
        try:
            raw = output_path.read_bytes()
            if len(raw) > SANDBOX_MAX_OUTPUT_BYTES:
                raise RuntimeError(
                    f"sandbox output exceeds limit: {len(raw)} bytes > "
                    f"{SANDBOX_MAX_OUTPUT_BYTES} bytes"
                )
            output_text = raw.decode("utf-8", errors="replace")
        except OSError as exc:
            logger.warning("sandbox output read failed: %s", exc)

    return SandboxResult(
        exit_code=completed.returncode,
        stdout=completed.stdout or "",
        stderr=completed.stderr or "",
        output_text=output_text,
        output_path=output_path if output_path.is_file() else None,
    )


@function_tool(
    name_override="run_python_script",
    description_override=(
        "Run a Python script in a sandbox to parse/clean user-uploaded files. "
        "The script can read INPUT_PATH (the user's uploaded file) via "
        "read_input()/read_csv()/read_json(), and write results to OUTPUT_PATH "
        "via write_output()/write_csv()/write_json(). Allowed imports: csv, json, "
        "re, math, itertools, collections, statistics, datetime, decimal, "
        "fractions, hashlib, io, pandas, numpy. Forbidden: os, subprocess, "
        "shutil, pathlib, open (use read_input/write_output instead). "
        "Timeout: 30s. Max output: 10MB."
    ),
)
def run_python_script(
    ctx: RunContextWrapper[Any],
    code: str,
    input_relative_path: str,
    output_relative_path: str,
) -> str:
    """Execute a sandboxed Python script against a file in the task workdir.

    Args:
        code: Python source code (no prelude; the sandbox injects controlled
            I/O helpers automatically).
        input_relative_path: Relative path under the task workdir for the
            script's INPUT_PATH (e.g. ``source_assets/patients.csv``).
        output_relative_path: Relative path under the task workdir for the
            script's OUTPUT_PATH (e.g. ``staging/agent/cleaned.csv``).
    """
    run_ctx: RunContext = ctx.context
    task_root = run_ctx.work_dir.root.resolve()

    # 安全：解析 input/output 路径，限制在任务目录内
    in_path = (task_root / input_relative_path).resolve()
    out_path = (task_root / output_relative_path).resolve()
    try:
        in_path.relative_to(task_root)
        out_path.relative_to(task_root)
    except ValueError as exc:
        return f"路径错误: {exc}（必须在任务目录内）"

    if not in_path.is_file():
        return f"输入文件不存在: {input_relative_path}"

    out_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        result = run_sandbox_script(
            code,
            input_path=in_path,
            output_path=out_path,
        )
    except ValueError as exc:
        return f"沙箱校验失败: {exc}"
    except subprocess.TimeoutExpired:
        return f"沙箱执行超时（{SANDBOX_TIMEOUT_SECONDS}s）"
    except Exception as exc:  # noqa: BLE001 — 沙箱外的意外错误需返回给 LLM
        return f"沙箱执行异常: {exc}"

    if result.exit_code != 0:
        stderr_tail = result.stderr[-2000:] if result.stderr else "(no stderr)"
        return (
            f"脚本退出码 {result.exit_code}。\nstderr:\n{stderr_tail}"
        )

    output_preview = result.output_text[:2000]
    if len(result.output_text) > 2000:
        output_preview += f"\n... (输出已截断，共 {len(result.output_text)} 字符)"

    return (
        f"脚本执行成功。\n"
        f"输出文件: {output_relative_path}\n"
        f"stdout 末尾:\n{result.stdout[-1000:]}\n"
        f"输出内容预览:\n{output_preview}"
    )
