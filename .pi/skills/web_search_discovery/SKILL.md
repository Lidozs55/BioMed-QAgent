---
name: web_search_discovery
description: Find sources, official entries, and download locations on the open web through the guarded browser when registered provider searches do not already answer the question.
---

# Web Search via Browser Automation

Open-web search has no dedicated API tool; the guarded browser covers it.
Whenever a needed source, entry, or download location is not already in hand —
an official page is unreachable, registered provider searches do not cover it,
a list page does not show its download link, or it is unknown which official
site hosts a dataset — navigate to a search-engine result page (for example
Bing) with `navigate_page` and use the extracted absolute links (the links /
links_total fields) to find candidate entries, then navigate to a candidate to
confirm it. Wake this route early during source discovery; do not wait for
tools to fail repeatedly, and prefer rephrasing the query over repeating the
same one.

## Constraints

- Calling mechanics (parameters, body-text paging, rate limiting, download
  staging) live in the browser skill; this skill only decides when a web
  search is the right route.
- Result-page hits are leads: prefer official or authoritative hosts, and
  acquire real bytes through the browser skill's download tool or a registered
  Core provider so provenance stays content-addressed.
- If the search engine returns no usable results, report the structured
  no-result outcome honestly instead of fabricating candidates.
