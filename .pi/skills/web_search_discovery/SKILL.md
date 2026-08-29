---
name: web_search_discovery
description: Fallback discovery route when registered API searches do not fit or an official source is unreachable — run an explicit public web search through the guarded browser and mine the result-page links.
---

# Web Search via Browser Automation

This system has no dedicated general web-search API tool. When a needed entry
cannot be found through registered provider searches — an official file URL
keeps returning 404, an upstream host is unreachable, or you do not know which
official site hosts a dataset — you can still search the open web with the
guarded browser: navigate to a search-engine result page (for example Bing)
with `navigate_page` and use the extracted absolute links (the links /
links_total fields) to discover candidate official entries, then navigate to a
candidate to confirm it.

Wake this skill the moment you notice yourself enumerating URL patterns,
retrying sequential IDs against an unreachable host, or guessing download
paths — that is the signal to replace blind enumeration with one explicit
search. Prefer rephrasing the query over repeating the same one.

## Constraints

- Calling mechanics (parameters, body-text paging, rate limiting, download
  staging) live in the browser skill; this skill only decides when a web
  search is the right route.
- Result-page hits are discovery leads only. Prefer official or authoritative
  hosts, and never treat result-page snippets or rendered text as data
  evidence.
- Acquire real bytes afterwards through the browser skill's download tool or a
  registered Core provider so provenance stays content-addressed; redirect
  wrappers from the search engine must never become evidence URLs.
- If the search engine returns no usable results, report the structured
  no-result outcome honestly instead of fabricating candidates.
