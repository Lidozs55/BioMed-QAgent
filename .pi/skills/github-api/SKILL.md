---
name: github-api
description: Use GitHub REST API and raw downloads for biomedical dataset files. Invoke when a needed data file or programming doc lives on GitHub or official sources are unreachable.
---

# GitHub API and raw download discovery

Use GitHub as a mirror / secondary source only: first try the official
site, then the official API, then PMC/EuropePMC, and only then GitHub
raw + REST. Never treat GitHub as the default source.

## When to use

- A required dataset file, supplementary archive, or programming doc is
  known to live in a GitHub repository.
- The official source is unreachable or does not provide a
  machine-readable download, and a GitHub mirror is a reasonable
  substitute for the same data.

## Reliable entry points (verified 2026-09-01)

| Use | URL form | Notes |
| --- | --- | --- |
| Repository search | https://api.github.com/search/repositories?q=QUERY&per_page=20 | reachable; unauthenticated search limit is 10 req/min |
| Repository root listing | https://api.github.com/repos/OWNER/REPO/contents/ | returns a JSON array (names, sizes, download urls) for a directory, base64 body for a file |
| Raw download (preferred) | https://github.com/OWNER/REPO/raw/REF/PATH | reachable on this host |
| Raw domain | https://raw.githubusercontent.com/OWNER/REPO/REF/PATH | NOT reachable on this host |
| CDN mirrors | cdn.jsdelivr.net/gh/..., cdn.statically.io/gh/..., raw.githack.com/..., fastly.jsdelivr.net/..., raw.gitmirror.com/... | NOT reachable on this host |

## How to use (fetching a file)

1. Fetch JSON listings with a download-style tool (`download_from_page`)
   rather than a browser navigation tool; `api.github.com` returns JSON
   that renders poorly in a browser view.
2. The governed tools already send real browser headers (User-Agent included)
   on every request — GitHub's UA requirement is satisfied automatically; you
   cannot and must not try to add custom headers. Unauthenticated limits are
   60 requests per hour for the core API and 10 requests per minute for the
   search API; throttle batch probing and never hammer the search endpoint to
   enumerate repositories.
3. To fetch a file: first list `contents/` to confirm the exact path and
   ref (branch or tag), then use the returned download url. If that raw
   domain is unreachable on this host, rewrite it to
   https://github.com/OWNER/REPO/raw/REF/PATH and fetch once.
4. Confirmed unreachable after one alternative entry point? Stop
   mirror-hopping: classify it as an environment network constraint and
   either return to the official source or report a structured NO_DATA /
   unavailable source. Never retry a failed raw or CDN URL unchanged.

## Failure handling

- 403: rate limit (the User-Agent requirement is already handled by the
  governed tools); back off, retry once, then stop.
- 404: wrong path or ref; confirm via the search or contents API, fix once, retry.
- Network failure (fetch failed / ETIMEDOUT): environment constraint; do not
  loop across mirrors.

## Provenance boundary

GitHub-hosted files are refreshable third-party mirrors, not official
frozen carriers. For formal Dataset Core builds the source must be a
registered Core provider or task-owned asset with persisted
OperationResult; a GitHub download is discovery/staging evidence only
and never a formal carrier.
