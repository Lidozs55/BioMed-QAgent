# M08 外部获取、网络安全与 Browser/PDF 审计结果（Run #2）

- 审计人: root
- 基线: be78a1a
- 状态: PASS

## 结论

- 真实 Chromium 用例在 Playwright 安装后全过（`browser.test.ts` 32、`web-visual-capture.test.ts` 8）。
- `network-policy.test.ts`（43）SSRF/私网/DNS 钉扎全过；`pdf.test.ts`（8）全过。
- 本拉取引入 `reuse url-policy for SSRF`：外部 sources（chembl/pdb/pubchem/reactome/uniprot）小幅改动，测试仍绿。

## 未覆盖

- 真实外部网络 live 模式仍以 fixture 为主（`live-smoke` 11 条跳过），真实外部数据源留待 M15。
