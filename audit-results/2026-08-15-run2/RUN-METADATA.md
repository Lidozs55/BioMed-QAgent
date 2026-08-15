# BioMed-QAgent 审计 — Run #2 运行元数据

- **Run 编号**：Run #2（第 2 次全量审计；Run #1 见 `audit-results/2026-08-15/`）
- **审计母版**：`docs/AI_AUDIT_TEST_PLAN.md` v1.0
- **基线提交**：`be78a1a577a9d20cec4cefb3b604661f0187a59c`（`main`，2026-08-15）
- **审计日期**：2026-08-15（Asia/Shanghai）
- **审计人**：root（总协调 + 独立总复核 + D 组）；子代理 A/B/C/E/F（模块审计）
- **隔离策略**：以不可变 SHA 为基线；审计对源码只读，结果写入独立目录
  `audit-results/2026-08-15-run2/`，与 Run #1 不覆盖。每个模块审计在开工与收工时
  记录 `git rev-parse HEAD` 与 `git status --short` 护栏，防止并发污染。
- **复跑约定**：后续 Run #3 请新建 `audit-results/<日期>-run3/`，不要覆盖本目录。

## 与 Run #1 的差异

Run #1 基线为 `ec3bb8b`。Run #2 基线为 `be78a1a`（较 Run #1 前进 21 个提交、
121 文件、约 +6737/-3901），涉及 contracts 收拢、model-registry、HTTP 层、
frontend 重构、runtime/事件、atomic-json 等，因此所有模块均需在 Run #2 重审。
