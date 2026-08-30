---
name: browser
description: Render and navigate public web pages with a guarded crawler, and download files through verified content-addressed staging.
---

# Browser

Use `navigate_page` to render a page and extract its title and body text, and
`download_from_page` to download files through isolated staging with
checksum-addressed SourceAsset validation and linked download provenance.

## When to use

- Direct web navigation to read a page's visible content or locate
  information on any public biomedical web page.
- Downloading files from a known public URL.
- The browser tools are first-class acquisition tools: call them directly
  whenever direct web access serves the task, not only after other APIs fail.

## Constraints

- Requests use a real browser User-Agent, Referer/Accept headers, and rate
  limiting.
- Downloads must be content-verified and recorded in provenance.
