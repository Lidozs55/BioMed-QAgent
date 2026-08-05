# Secure Skill Runtime Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate `origin/skill-core-hardening` on the latest main baseline while enforcing task-file integrity, public-network-only crawling, functional HTTP-to-Playwright fallback, and all current quality gates.

**Architecture:** Preserve current main as the formatting, fixture, frontend, and CI/CD baseline. Merge the Skill branch once on an isolated integration branch, then separate task-local file/network safety from fallback orchestration so each behavior has focused tests and review gates.

**Tech Stack:** Python 3.12, FastAPI, OpenAI Agents SDK, Pydantic v2, HTTPX, Playwright, BeautifulSoup, pytest, Ruff, React 19, pnpm, Vitest, Vite.

## Global Constraints

- Work only on `fix/secure-skill-runtime-and-fallbacks`; never implement on `main`.
- Do not modify `.github/**`, release packaging, or CI/CD configuration.
- Treat current main versions of `.gitattributes`, fixture files and hashes, `frontend/package.json`, `frontend/vite.config.ts`, and Ruff/pytest configuration as authoritative.
- Agent reads and lists may use the complete task root; Agent writes must remain under `staging/agent/`.
- Incomplete browser downloads live under `download_tmp/`; successful files move atomically to `source_assets/`; existing assets are not overwritten.
- Generic browser/crawler requests allow only public HTTP(S) destinations and validate every redirect before sending it.
- Reactome and PubChem must never report an HTTP 200 shell page as an empty successful structured result.
- Use TDD for every behavior change: add the test, observe the expected failure, implement minimally, and rerun the focused suite.
- Keep changes surgical; do not refactor unrelated Skills or pipeline code.
- Use pnpm, never npm.

---

### Task 1: Integrate the Skill Branch on the Main Baseline

**Files:**
- Merge: `origin/skill-core-hardening`
- Modify during conflict resolution: `backend/app/agent_loop/agent.py`
- Modify during conflict resolution: `backend/app/api/ws.py`
- Modify during conflict resolution: `backend/app/domain/events.py`
- Modify during conflict resolution: `backend/app/domain/task.py`
- Modify during conflict resolution: `backend/app/skills/builtin/acquisition/browser.py`
- Modify during conflict resolution: `backend/app/skills/builtin/acquisition/xena.py`
- Modify during conflict resolution: `backend/app/tools/_registry.py`
- Delete during conflict resolution: `backend/app/tools/analyze.py`
- Modify during conflict resolution: `backend/app/tools/io.py`
- Modify: `backend/pyproject.toml`
- Modify: `backend/uv.lock`
- Preserve from main: `backend/tests/fixtures/ncbi/gse178352/manifest.json`
- Preserve from main: `frontend/tsconfig.app.tsbuildinfo`

**Interfaces:**
- Consumes: current `origin/main` and `origin/skill-core-hardening`.
- Produces: one merge commit containing the source branch's Skill capabilities, tests, and documentation on the current main quality configuration.

- [ ] **Step 1: Record the pre-merge base and start the merge without committing**

Run:

```powershell
git rev-parse HEAD
git merge --no-commit --no-ff origin/skill-core-hardening
```

Expected: merge stops with the known conflict set; `.github/**` remains the main version.

- [ ] **Step 2: Resolve conflicts using explicit semantic rules**

Apply these rules:

```text
agent.py        main formatting + target module list; remove duplicate forced Skill appends
api/ws.py       keep main contextlib.suppress behavior unless target logging adds behavior
domain/*.py     keep main UTC/StrEnum and Ruff-compatible imports
browser.py      keep target BeautifulSoup/crawler integration; Task 2 hardens it
xena.py         keep target pagination and canonical .gz URL; keep main Ruff style
_registry.py    keep main style and target cleanup; Task 3 aligns module imports
analyze.py      keep target deletion after confirming no production imports
io.py           temporarily keep target task-root read behavior; Task 2 splits write scope
```

- [ ] **Step 3: Preserve main-owned files and remove generated drift**

Run:

```powershell
git restore --source=origin/main -- .gitattributes backend/tests/fixtures/ncbi/gse178352/manifest.json frontend/tsconfig.app.tsbuildinfo frontend/package.json frontend/vite.config.ts
git diff --name-only origin/main -- .github
```

Expected: the `.github` diff is empty; fixture hashes match the LF fixture bytes.

- [ ] **Step 4: Reconcile dependencies and current quality configuration**

Keep these target dependencies:

```toml
"beautifulsoup4>=4.12.0"
"playwright>=1.40.0"
```

Do not add `requests`; no production code imports it. Preserve main's Ruff and pytest sections, then run:

```powershell
uv lock
uv sync --frozen
uv run ruff check --fix app tests launcher.py
```

Expected: the lock contains the two required packages and Ruff reports no remaining lint errors. Do not run a repository-wide formatter; current main does not use `ruff format` as a quality gate and doing so would create unrelated churn.

- [ ] **Step 5: Reproduce and fix the warning-as-error regression**

Run before editing:

```powershell
uv run pytest tests/test_skill_stats.py::test_generate_correlation_matrix_success -v
```

Expected RED: Seaborn raises the known Matplotlib `PendingDeprecationWarning` under main's warning policy.

Wrap only the third-party correlation heatmap call in a local warning filter matching the exact `set_bad` deprecation message and `PendingDeprecationWarning`. Do not change global pytest or CI warning policy.

Use this narrowly scoped form:

```python
with warnings.catch_warnings():
    warnings.filterwarnings(
        "ignore",
        message=r"The set_bad function will be deprecated.*",
        category=PendingDeprecationWarning,
        module=r"seaborn\.matrix",
    )
    sns.heatmap(...)
```

Run again; expected GREEN: the focused test passes with no warnings.

- [ ] **Step 6: Verify and commit the integration**

Run:

```powershell
uv run pytest
uv run ruff check app tests launcher.py
git diff --check
git ls-files -u
git status --short
```

Expected: all default backend tests pass, Ruff passes, no unmerged entries remain, and only intended backend/docs changes are staged.

Commit:

```powershell
git commit -m "feat(skills): integrate hardened acquisition sources"
```

---

### Task 2: Enforce File and Network Safety Boundaries

**Files:**
- Create: `backend/app/tools/network_safety.py`
- Modify: `backend/app/tools/io.py`
- Modify: `backend/app/tools/workdir.py`
- Modify: `backend/app/tools/crawler.py`
- Modify: `backend/app/skills/builtin/acquisition/browser.py`
- Test: `backend/tests/test_tools_io.py`
- Test: `backend/tests/test_workdir.py`
- Test: `backend/tests/test_network_safety.py`
- Test: `backend/tests/test_tools_crawler.py`
- Test: `backend/tests/test_skill_browser.py`

**Interfaces:**
- Produces: `validate_public_http_url(url: str) -> str` and HTTPX request hooks that raise `UnsafeUrlError` before unsafe requests.
- Produces: `TaskWorkDir.agent_staging_file(relative: str) -> Path`.
- Consumes: existing `TaskWorkDir.download_temp_file`, `source_asset_file`, and crawler `FetchResult`.

- [ ] **Step 1: Add failing task-file boundary tests**

Add tests proving:

```python
assert write_file("report.md") writes staging/agent/report.md
assert read_file("source_assets/input.csv") returns source content
assert list_files("") includes parsed and source asset paths
assert write_file("../state/task.lock") returns a path error
assert agent_staging_file("../../artifacts/run_manifest.json") raises ValueError
```

Run:

```powershell
uv run pytest tests/test_tools_io.py tests/test_workdir.py -v
```

Expected RED: current writes resolve under the task root/artifacts instead of dedicated Agent staging.

- [ ] **Step 2: Implement split read/write roots**

Implement the interfaces:

```python
def agent_staging_file(self, relative: str) -> Path:
    root = _safe_child(self.staging, "agent")
    root.mkdir(parents=True, exist_ok=True)
    return _safe_child(root, relative)
```

Use the task root for read/list resolution and `agent_staging_file` for writes. Do not append staged files to an authoritative manifest.

Run the focused tests; expected GREEN.

- [ ] **Step 3: Add failing URL validation tests**

Cover these exact cases with a patched DNS resolver:

```text
https://example.org/data            accepted when DNS resolves globally
ftp://example.org/data              rejected
http://user:pass@example.org        rejected
http://localhost/data               rejected
http://127.0.0.1/data               rejected
http://169.254.169.254/latest/meta   rejected
https://private.example/data        rejected when DNS resolves to 10.0.0.8
```

Also prove both sync and async HTTPX request hooks call the validator.

Run:

```powershell
uv run pytest tests/test_network_safety.py -v
```

Expected RED: the module does not exist.

- [ ] **Step 4: Implement public HTTP(S) validation**

Use `urllib.parse.urlsplit`, `socket.getaddrinfo`, and `ipaddress.ip_address`.
Reject a destination when any resolved address has `is_global == False`.
Define sync and async request hooks for HTTPX redirects.

Run the focused tests; expected GREEN.

- [ ] **Step 5: Add failing browser download safety tests**

Add tests proving:

```text
filename traversal is rejected before opening a response body
HTTP 404 creates neither download_tmp nor source_assets files
stream exceptions remove the .part file
an existing source asset is not overwritten
successful bytes move from download_tmp to source_assets
```

Run:

```powershell
uv run pytest tests/test_skill_browser.py -v
```

Expected RED against the integrated target implementation.

- [ ] **Step 6: Implement safe browser navigation and downloads**

Configure AsyncClient with the async public-URL request hook. Resolve the
destination with `download_temp_file` and `source_asset_file`, check HTTP
status before creating the temp file, remove partial files on exceptions, and
use `Path.replace` only after success. Refuse to replace an existing asset.

Run all Task 2 tests plus Ruff; expected GREEN and no warnings.

- [ ] **Step 7: Commit**

```powershell
git add backend/app/tools/network_safety.py backend/app/tools/io.py backend/app/tools/workdir.py backend/app/tools/crawler.py backend/app/skills/builtin/acquisition/browser.py backend/tests/test_network_safety.py backend/tests/test_tools_io.py backend/tests/test_workdir.py backend/tests/test_tools_crawler.py backend/tests/test_skill_browser.py
git commit -m "fix(skills): enforce safe file and network boundaries"
```

---

### Task 3: Connect the Functional Crawler Fallback and Skill Registration

**Files:**
- Modify: `backend/app/tools/crawler.py`
- Modify: `backend/app/skills/builtin/acquisition/pubchem.py`
- Modify: `backend/app/skills/builtin/acquisition/reactome.py`
- Modify: `backend/app/skills/builtin/acquisition/browser.py`
- Modify: `backend/app/agent_loop/agent.py`
- Modify: `backend/app/tools/_registry.py`
- Modify: `docs/skills_interface_spec.md`
- Test: `backend/tests/test_tools_crawler.py`
- Test: `backend/tests/test_skill_pubchem.py`
- Test: `backend/tests/test_skill_reactome.py`
- Test: `backend/tests/test_skill_browser.py`
- Test: `backend/tests/test_tool_registry.py`
- Create: `backend/tests/live/test_reactome_pubchem_live.py`

**Interfaces:**
- Extends: `fetch_with_fallback(..., accept_result: Callable[[FetchResult], bool] | None = None) -> FetchResult`.
- Produces: page fallback JSON with `status`, `source`, `method_used`, `page_url`, and `body_text_preview`.
- Produces: identical built-in module registration in `agent_loop.agent` and `tools._registry`.

- [ ] **Step 1: Add failing crawler orchestration tests**

Add tests proving an acceptance predicate can reject an HTTP 200 static page,
continue to Playwright, and return the Playwright result. Add a Playwright test
whose mocked navigation response returns 404 and assert `FetchResult.ok` is
false. Add a browser Skill test proving `navigate_page` delegates rendered
navigation to `playwright_fetch` rather than issuing another static HTTP GET.

Run:

```powershell
uv run pytest tests/test_tools_crawler.py tests/test_skill_browser.py -v
```

Expected RED: HTTP 200 always terminates the current chain and Playwright
currently synthesizes status 200.

- [ ] **Step 2: Implement semantic acceptance and real navigation status**

Call `accept_result(result)` after transport `result.ok`; continue when it
returns false. In Playwright, use:

```python
response = page.goto(...)
status_code = response.status if response is not None else 0
```

Install the public-network route guard before `page.goto`.
Update `navigate_page` to consume `playwright_fetch`, parse its rendered HTML,
and preserve the returned status code and method in its JSON response.

Run the crawler tests; expected GREEN.

- [ ] **Step 3: Add failing Reactome and PubChem fallback tests**

Cover these behaviors:

```text
valid API JSON still returns structured records
API parse failure invokes page fallback
PubChem rejects the static HTTP shell and reaches Playwright
Reactome accepts useful static HTML without launching Playwright
fallback returns bounded visible text, not count=0/status=ok
all tiers failing returns a structured error with attempted methods
```

Run both Skill test files; expected RED on current empty-success behavior.

- [ ] **Step 4: Implement page fallback responses**

Use `fetch_with_fallback(None, page_url, ...)` after API parsing fails. Parse
visible text with BeautifulSoup, cap it at 5000 characters, and return
`status="page_fallback"`. PubChem's acceptance predicate accepts only crawl;
Reactome accepts non-empty static HTML or crawl. Return a structured error when
`CrawlError` is raised.

Run the focused tests; expected GREEN.

- [ ] **Step 5: Align registration paths with failing tests first**

Extend `test_tool_registry.py` to assert Reactome and PubChem tools are present
after `get_all_tools()`. Run it and observe RED, then add both modules to
`tools._registry._import_skill_modules`. Keep `agent_loop.agent` and the tool
registry module lists identical and avoid duplicate Skill append logic.

Run the registry, agent, Reactome, and PubChem suites; expected GREEN.

- [ ] **Step 6: Add and run explicit live API tests**

Create two `@pytest.mark.live` tests:

```text
search_reactome("apoptosis", max_results=3) returns at least one R-HSA record
get_compound(2244) returns aspirin data with CID 2244 and a molecular formula
```

Run:

```powershell
uv run pytest -m live tests/live/test_reactome_pubchem_live.py -v
```

Expected: both official API checks pass. A service outage is reported separately
from default offline test results and does not trigger mock-success behavior.

- [ ] **Step 7: Update documentation and commit**

Update `docs/skills_interface_spec.md` so it describes direct page fallback,
semantic acceptance, public-network validation, and the actual response schema.
Remove claims that `navigate_page` is HTTP-only or that an unconsumed signal
automatically launches Playwright.

Run Ruff and focused tests, then commit:

```powershell
git add backend/app/tools/crawler.py backend/app/skills/builtin/acquisition/browser.py backend/app/skills/builtin/acquisition/pubchem.py backend/app/skills/builtin/acquisition/reactome.py backend/app/agent_loop/agent.py backend/app/tools/_registry.py backend/tests/test_tools_crawler.py backend/tests/test_skill_browser.py backend/tests/test_skill_pubchem.py backend/tests/test_skill_reactome.py backend/tests/test_tool_registry.py backend/tests/live/test_reactome_pubchem_live.py docs/skills_interface_spec.md
git commit -m "fix(skills): connect semantic crawler fallback"
```

---

### Task 4: Run Cross-stack Release Gates and Prepare the Branch

**Files:**
- Verify: all branch changes
- Preserve: `.github/**`
- Preserve: `frontend/tsconfig.app.tsbuildinfo`

**Interfaces:**
- Consumes: completed Tasks 1-3.
- Produces: a clean, review-approved branch ready for PR or merge selection.

- [ ] **Step 1: Run complete backend gates**

```powershell
uv sync --frozen
uv run ruff check app tests launcher.py
uv run python -m compileall -q app tests
uv run pytest
```

Expected: zero Ruff errors, zero warnings promoted to failures, and all
default tests pass with only the intentional live deselections.

- [ ] **Step 2: Run import and server startup smoke checks**

```powershell
uv run python -c "from app.server import app; from app.agent_loop.agent import create_agent; print(app.title); print(len(create_agent().tools))"
uv run uvicorn app.server:app --host 127.0.0.1 --port 8765
```

Expected: imports succeed and Uvicorn reaches application startup. Stop the
smoke server after confirming startup; do not kill unrelated Python processes.

- [ ] **Step 3: Run complete frontend gates with pnpm**

```powershell
pnpm lint
pnpm test
pnpm build
git restore -- frontend/tsconfig.app.tsbuildinfo
```

Expected: lint, 25 frontend tests, TypeScript, and production build pass; the
generated build-info file is not part of the branch diff.

- [ ] **Step 4: Run final Git integrity gates**

```powershell
git diff --check origin/main...HEAD
git ls-files -u
git status --short --branch
git diff --name-only origin/main...HEAD -- .github
git log --oneline --decorate origin/main..HEAD
```

Expected: no whitespace errors, no unmerged entries, clean worktree, no CI/CD
file changes, and semantic commits for integration, safety, and fallback.

- [ ] **Step 5: Request final whole-branch review**

Generate a review package from `origin/main` to `HEAD` and dispatch the final
reviewer. Fix every Critical or Important finding, rerun its covering tests,
and repeat review until both spec compliance and code quality are approved.

## Plan Self-Review

- The plan covers every Critical and Important audit finding.
- The merge conflict rules preserve main-owned CI/CD, fixture, frontend, and
  quality configuration.
- File safety, network safety, fallback orchestration, registration, and
  cross-stack verification are independently reviewable tasks.
- Every behavior change starts with a named failing test and exact command.
- No step requires force-push, direct main changes, npm, or warning-policy
  weakening.
