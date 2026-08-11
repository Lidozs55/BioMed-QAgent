# Task 5 Report: Phase 0E Python DatasetBuild Service Boundary

## Status

DONE. The V2 DatasetBuild application service is directly callable through
`app.datasets.service` without importing the OpenAI Agents SDK. The existing
FunctionTool names, decorators, descriptions, JSON envelopes, managed-run
handoff, legacy artifact mirror, and V2 Core behavior remain in place through a
thin legacy adapter. No HTTP migration endpoint or TypeScript bridge was added.

## TDD RED evidence

The focused service tests were written before the service module existed:

```powershell
Set-Location backend
uv run pytest tests/test_dataset_service.py -q
```

Expected RED result: collection failed with one error,
`ModuleNotFoundError: No module named 'app.datasets.service'`. This was the
missing required API/module, not a syntax or fixture error.

After implementation, the same focused command passed:

```text
12 passed in 2.00s
```

## Files changed

- `backend/app/datasets/service.py`
  - Adds typed named operations for `validate_dataset_build_spec`,
    `execute_dataset_build`, and task-scoped `get_build_result`.
  - Owns SpecValidator configuration, local/recipe SourceAsset preparation,
    V2 executor/runner invocation, outcome classification, cache commit, and
    safe task-local read lookup.
  - Has no `agents`, `RunContextWrapper`, FunctionTool decorator, arbitrary
    dispatcher, arbitrary SQL/Python, or arbitrary path-write surface.
- `backend/app/pipeline/dataset_build_tool.py`
  - Retains the legacy OpenAI decorators/descriptions and exact JSON adapter
    behavior.
  - Retains legacy-only managed-run `PendingDatasetBuild` transfer and V1
    artifact mirroring.
  - Preserves existing private test/debug seams for build-output, NO_DATA,
    publication-order, and recipe-fetcher behavior.
- `backend/tests/test_dataset_service.py`
  - Direct validation coverage for valid, semantic rejection, and malformed
    input.
  - Direct safe lookup coverage for success, task isolation, not found, and
    path-like ID rejection.
  - Direct-service/legacy-wrapper stable-field parity for SUCCEEDED, NO_DATA,
    and invalid/spec-rejected validation.
  - AST guard proving the service module does not import the Agents SDK.

## Exact checks and results

Baseline before edits:

```text
uv run pytest tests/test_dataset_build_tool.py -q
37 passed in 4.90s
```

Focused service + legacy compatibility:

```text
uv run pytest tests/test_dataset_service.py tests/test_dataset_build_tool.py tests/test_dataset_build_tool_recipe.py -q
52 passed in 4.53s
```

Brief-specified finite regression set:

```text
uv run pytest tests/test_dataset_build_tool.py tests/test_dataset_build_tool_recipe.py tests/test_dataset_expression_runner.py tests/test_dataset_contracts.py tests/test_migration_golden.py -q
155 passed in 12.28s
```

Lint:

```text
uv run ruff check app/datasets/service.py app/pipeline/dataset_build_tool.py tests/test_dataset_service.py
All checks passed!
```

Diff integrity:

```text
git diff --check
PASS
git diff --cached --check
PASS
```

The full backend suite, frontend checks, startup smoke, push, merge, and broad
review were intentionally not run: Task 5 requested the finite checks above,
no push, and one deferred whole-branch review after all Phase 0/1 work.
Commonly was explicitly out of scope.

## Commit

Implementation commit: `71246b9` (`refactor: extract DatasetBuild service boundary`).

No push was performed.

## Phase 1E concern

The legacy FunctionTool must keep returning its historical absolute
`output_dir`/`manifest_file` fields for compatibility, so the Phase 1E bridge
must not forward that legacy envelope directly. It should serialize the typed
service outcome and/or call task-scoped `get_build_result`, exposing only the
relative manifest/publication/artifact references defined by ADR-022. The
bridge must also resolve the correct lifespan-owned `RunContext` for the
requested BioMed task/run and translate structured service outcomes into the
documented bridge error taxonomy without reconstructing `RunContextWrapper`.

The unchanged expression runner currently stamps `DatasetManifest.task_id`
with the build ID. The safe lookup therefore derives task authority from the
already-scoped task workdir and validates `manifest.build_id`; Phase 1E should
continue resolving the task directory from trusted runtime state, never from a
caller-supplied path.
