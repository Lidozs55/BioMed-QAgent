# M08 测试矩阵

- Commit: be78a1a577a9d20cec4cefb3b604661f0187a59c
- 环境: Windows / Node 24.19 / Playwright Chromium

| Case | 结果 | 证据 |
| --- | --- | --- |
| M08-T01 | PASS | `network-policy.test.ts`（SSRF/private DNS/IPv6/IDNA） |
| M08-T02 | PASS | `geo-client.test.ts`（有界重试/Retry-After）、`network-policy.test.ts` |
| M08-T03 | PASS | `acquisition.test.ts`、`crawler.test.ts`、`pdf.test.ts` |
| M08-T04 | PASS | `acquisition.test.ts`（cache/publication）、`geo-adapter.test.ts`（截断 gzip） |
| M08-T05 | PASS | `browser.test.ts`（32 真实 Chromium） |
| M08-T06 | PASS | `pdf.test.ts`（8） |
| M08-T07 | PASS | `crawler.test.ts`、`event-adapter.test.ts`（脱敏） |
| M08-T08 | PASS | fixture 默认 + `live-smoke.test.ts`（BIOMED_LIVE_SMOKE=1 显式） |
