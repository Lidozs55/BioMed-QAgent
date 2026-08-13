---
name: browser_fallback
description: Last-resort rendered-browser fallback for navigating pages and downloading files when structured API tools fail.
---

# Browser fallback

Use `navigate_page` to render a page and extract its title and body text, and
`download_from_page` to download files through isolated staging with
checksum-addressed SourceAsset validation and linked download provenance.

## When to use (last resort only)

- Structured API tools (PubMed, GEO, PDB, Xena, GDC, …) are unavailable or
  return HTTP 403/404/network errors.
- Never replace a working structured API with browser automation.

## Constraints

- Requests use a real browser User-Agent, Referer/Accept headers, and rate
  limiting.
- Downloads must be content-verified and recorded in provenance.
- **Research-only source.** Browser-acquired data is for investigation and
  evidence only — never declare `browser_fallback` as a dataset build source.
