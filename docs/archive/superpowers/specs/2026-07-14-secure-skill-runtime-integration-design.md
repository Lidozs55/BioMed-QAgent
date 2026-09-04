# Secure Skill Runtime Integration Design

## Context

`origin/skill-core-hardening` adds Reactome and PubChem Skills, broader Skill
tests, crawler primitives, and several acquisition fixes. The audit found that
the branch cannot be merged as-is: it diverges from the current `main`, fails
current quality gates, expands Agent write access across the task directory,
and advertises a Playwright fallback that production Skills do not reach.

The integration branch starts at the latest `origin/main`. CI/CD and release
files remain owned by the existing collaborator and are not changed here.

## Considered Approaches

### Rebase the source branch onto main

This preserves a linear history, but replays four commits across the large
main-side Ruff and packaging change. The same semantic conflicts would need to
be resolved repeatedly, and it would rewrite the existing remote branch.

### Merge the source branch directly into main

This preserves history but puts unresolved security and quality issues in the
main checkout. It also makes review and rollback harder.

### Integrate on a new main-based branch

Create `fix/secure-skill-runtime-and-fallbacks` from current main, merge the
source branch there, resolve conflicts once with main as the baseline, and fix
the audited defects before opening a PR. This preserves both source branches,
keeps CI/CD unchanged, and produces a reviewable integration diff.

This is the selected approach.

## Architecture

### Task-local file access

Agent read and list tools may inspect the complete task directory so they can
consume source assets and parsed intermediates. Agent writes are isolated to
`staging/agent/`; they cannot modify immutable source assets, pipeline state,
logs, validated artifacts, or `run_manifest.json`.

Browser downloads use `download_tmp/` while incomplete. A successful response
is atomically moved into `source_assets/`. File names are resolved through the
existing `TaskWorkDir` safe-child helpers, traversal is rejected, and an
existing source asset is never overwritten.

### Network safety

All generic crawler and browser URLs must be public HTTP(S) destinations.
Validation rejects credentials, blank hosts, localhost, and IP addresses that
are not globally routable. Host names are resolved before each request so a
private address cannot be hidden behind DNS. HTTPX request hooks validate every
redirect before it is sent. Playwright installs a route guard before navigation
so the initial document and redirected/subresource requests use the same rule.

The validation helper is shared by synchronous HTTPX, asynchronous HTTPX, and
Playwright code. Source-specific clients outside the generic crawler are not
refactored in this change.

### Crawler fallback

The crawler owns the transport sequence:

1. structured API request;
2. static HTTP page request;
3. rendered Playwright request.

Transport success is not automatically semantic success. A caller-provided
acceptance predicate may reject an HTTP 200 shell page and continue to the next
tier. Playwright reports the navigation response status instead of inferring
HTTP 200 from `document.readyState`.

Reactome and PubChem keep their structured API parsing. When API transport or
parsing fails, they call the page fallback directly. A usable fallback returns
`status="page_fallback"`, the actual `method_used`, the source URL, and a
bounded visible-text preview. It never reports an empty structured result as a
successful search. When all tiers fail, the Skill returns a structured error
with the attempted methods.

### Skill registration

`agent_loop.agent` and `tools._registry` import the same built-in Skill module
set. Reactome and PubChem are registered exactly once. Optional import failures
are logged without hiding unrelated runtime errors.

### Compatibility and provenance

The current main-side `.gitattributes`, fixture bytes, fixture hashes, Ruff
configuration, warning policy, frontend package metadata, and CI/CD files are
authoritative. The source branch's generated `tsconfig.app.tsbuildinfo` change
is discarded. The unused `requests` dependency is not added.

## Error Handling

- Unsafe URL and unsafe path errors become structured tool errors and are
  logged as failed queries.
- HTTP error responses are checked before a download file is created.
- Partial browser downloads are removed after exceptions.
- Existing immutable source assets cause a conflict error instead of overwrite.
- Page fallback exhaustion returns a structured error; it does not claim an
  empty successful result.

## Verification

- Unit tests prove task-root reads, staging-only writes, traversal rejection,
  private-network rejection, safe redirects, failed-download cleanup, and
  fallback tier selection.
- Existing and new Skill suites run under the main-side warnings-as-errors
  configuration.
- Live-marked Reactome and PubChem tests call the official APIs explicitly.
- Backend gates: `uv run ruff check app tests launcher.py`, `uv run pytest`,
  compile/import smoke checks, and a short Uvicorn startup smoke test.
- Frontend gates: `pnpm lint`, `pnpm test`, and `pnpm build`.
- Git gates: no unmerged entries, no whitespace errors, no generated-file
  drift, and no CI/CD changes.

## Non-goals

- Replacing OpenAI Agents SDK or the deterministic pipeline.
- Changing CI/CD, release packaging, or frontend product behavior.
- Turning browser downloads into the full deterministic `DownloadAttempt` and
  content-addressed cache implementation.
- Adding support for more biomedical sources.
