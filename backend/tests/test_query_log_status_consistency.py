"""Static consistency check: all skill ``log_query()`` calls use ``QueryStatus``.

Per TODO §8.4: "遍历所有 skill 的 query_log 输出，断言 status ∈ QueryStatus".

Enforced via AST scan so we catch any future regression that reintroduces a
raw string literal (e.g., ``"ok"``, ``"failed"``, ``"page_fallback"``) in
place of the unified ``QueryStatus`` enum. Before §1.8, the codebase mixed
six different status spellings across 11 skill files; this test locks in
the post-migration invariant.

The check is intentionally static: a dynamic check would require mocking
the HTTP layer for every skill, and would still miss code paths that only
log on rare error branches. AST scanning covers every call site regardless
of reachability.
"""

from __future__ import annotations

import ast
import importlib
from pathlib import Path

import pytest
from app.domain.contracts import QueryStatus

SKILLS_DIR = Path(__file__).parent.parent / "app" / "skills" / "builtin"
VALID_STATUS_VALUES = {member.value for member in QueryStatus}


def _find_log_query_status_args(tree: ast.AST) -> list[tuple[ast.expr, ast.Call]]:
    """Return ``(status_expr, call_node)`` for every ``*.log_query(...)`` call.

    ``status`` is the 3rd positional argument in ``log_query(query, source,
    status, records_count=0)``; it may also be passed as ``status=``.
    """
    found: list[tuple[ast.expr, ast.Call]] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        if not isinstance(node.func, ast.Attribute):
            continue
        if node.func.attr != "log_query":
            continue
        if len(node.args) >= 3:
            found.append((node.args[2], node))
            continue
        for kw in node.keywords:
            if kw.arg == "status":
                found.append((kw.value, node))
                break
    return found


def _collect_skill_files() -> list[Path]:
    """Return every ``*.py`` under ``skills/builtin/`` (excluding __init__/utils)."""
    files: list[Path] = []
    for path in sorted(SKILLS_DIR.rglob("*.py")):
        if path.name == "__init__.py":
            continue
        files.append(path)
    return files


SKILL_FILES = _collect_skill_files()


def _is_query_status_attribute(expr: ast.expr) -> bool:
    """True for ``QueryStatus.X`` references (the desired form)."""
    return (
        isinstance(expr, ast.Attribute)
        and isinstance(expr.value, ast.Name)
        and expr.value.id == "QueryStatus"
    )


def _query_status_member(expr: ast.expr) -> str | None:
    """Return the member name (e.g., ``"SUCCESS"``) for a ``QueryStatus.X`` ref."""
    if _is_query_status_attribute(expr):
        return expr.attr
    return None


@pytest.mark.parametrize(
    "skill_file",
    SKILL_FILES,
    ids=lambda p: str(p.relative_to(SKILLS_DIR)),
)
def test_log_query_status_uses_query_status_enum(skill_file: Path) -> None:
    """Every ``log_query(...)`` status argument must reference ``QueryStatus.X``.

    String literals (e.g., ``"ok"``, ``"failed"``) are rejected — they bypass
    the enum and reintroduce the pre-§1.8 inconsistency. Bare names (variables)
    are also rejected in skills: the status should be a literal enum reference
    so the call site is greppable and auditable.
    """
    source = skill_file.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(skill_file))
    calls = _find_log_query_status_args(tree)

    rejected: list[str] = []
    for status_expr, call in calls:
        if _is_query_status_attribute(status_expr):
            member = _query_status_member(status_expr)
            if member not in QueryStatus.__members__:
                rejected.append(
                    f"{skill_file.name}:{call.lineno}: QueryStatus.{member} "
                    f"is not a valid member"
                )
            continue
        # Reject string literals and any other non-enum form
        if isinstance(status_expr, ast.Constant):
            rejected.append(
                f"{skill_file.name}:{call.lineno}: log_query uses literal "
                f"status={status_expr.value!r} (must use QueryStatus.X)"
            )
        else:
            rejected.append(
                f"{skill_file.name}:{call.lineno}: log_query uses non-enum "
                f"status expression (must use QueryStatus.X, got "
                f"{ast.dump(status_expr)})"
            )

    assert not rejected, (
        f"{len(rejected)} log_query call(s) violate QueryStatus enum contract:\n"
        + "\n".join(rejected)
    )


@pytest.mark.parametrize(
    "skill_file",
    SKILL_FILES,
    ids=lambda p: str(p.relative_to(SKILLS_DIR)),
)
def test_skill_files_import_query_status_when_using_log_query(
    skill_file: Path,
) -> None:
    """Skills that call ``log_query()`` must import ``QueryStatus``.

    Without the import, the code would ``NameError`` at runtime. This catches
    a skill file that copies a ``log_query(...)`` call from another module
    without adding the enum import.
    """
    source = skill_file.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(skill_file))

    if not _find_log_query_status_args(tree):
        return  # no log_query calls → no import needed

    imported_names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            for alias in node.names:
                imported_names.add(alias.asname or alias.name)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                # ``import app.domain.contracts as contracts`` → check attr access separately
                if alias.asname:
                    imported_names.add(alias.asname)
                elif alias.name:
                    imported_names.add(alias.name.split(".")[0])

    # Accept any of:
    #   from app.domain.contracts import QueryStatus
    #   from app.domain.contracts import (... QueryStatus ...)
    #   import app.domain.contracts (then QueryStatus is attribute access —
    #       but our AST check above already requires ``QueryStatus.X`` form,
    #       so this case would still need ``QueryStatus`` in scope)
    assert "QueryStatus" in imported_names, (
        f"{skill_file.name}: calls log_query() but does not import QueryStatus; "
        f"add `from app.domain.contracts import QueryStatus`"
    )


def test_query_status_enum_values_are_stable() -> None:
    """Lock the canonical set of ``QueryStatus`` values.

    Adding a new value is fine (the AST test accepts any ``QueryStatus.X``
    member), but removing or renaming an existing value would silently break
    skill code. This test makes such a change explicit.
    """
    assert {
        "success",
        "not_found",
        "failed",
        "skipped",
        "page_fallback",
    } == VALID_STATUS_VALUES


def test_query_status_enum_is_importable_from_contracts() -> None:
    """``QueryStatus`` must be re-exported from ``app.domain.contracts``.

    Skills import it from there (not from ``app.domain.contracts.enums``),
    so the re-export is part of the public contract.
    """
    module = importlib.import_module("app.domain.contracts")
    assert hasattr(module, "QueryStatus"), (
        "app.domain.contracts must re-export QueryStatus for skill imports"
    )
