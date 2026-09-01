---
name: browser
description: Render and navigate public web pages with a guarded crawler, and download files through verified content-addressed staging.
---

# Browser

Use `navigate_page` to render a page and extract its title, cleaned visible body
text, and bounded links. The default response removes HTML formatting and never
persists or inlines the page HTML; use `max_chars` / `offset` to page through
long text. Set `archive_html: true` only when the complete rendered DOM is needed
as a verified `text/html` SourceAsset. That mode returns the asset, registration,
and acquisition-evidence metadata, not the HTML bytes in model context.

Use `download_from_page` for known file URLs. It downloads through isolated
staging with checksum-addressed SourceAsset validation and linked download
provenance.

## When to use

- Direct web navigation to read a page's visible content or locate
  information on any public biomedical web page.
- Downloading files from a known public URL.
- The browser tools are first-class acquisition tools: call them directly
  whenever direct web access serves the task, not only after other APIs fail.

## Constraints

- Requests use a real browser User-Agent, Referer/Accept headers, and rate
  limiting.
- `archive_html` stores the JavaScript-rendered DOM (bounded at 10 MiB); it does
  not bundle linked stylesheets, images, or scripts into an offline web archive.
- Downloads and archived HTML must be content-verified and recorded in
  provenance.
