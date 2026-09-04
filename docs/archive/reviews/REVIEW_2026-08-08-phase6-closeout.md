# REVIEW — Phase 6 收尾（剩余 3 项 P2，TODO §2.7.3/2.7.4/2.7.5）

日期：2026-08-08
分支：`main` @ `1576b86`（Phase 6 全部完成）
结论：**TODO Phase 6 剩余 3 项 P2 全部落地（TDD 红→绿），Design §16 Phase 6 验收全达成。** 终态：后端 **2658 passed** / ruff 全量门 clean / import OK。

## 交付

| TODO | 交付 | 任务 |
| --- | --- | --- |
| P2 `extract_tables` OCR 回退 + 中文支持（§2.7.3） | Qwen-VL 已替代传统 OCR（pyproject 注释否决 pytesseract），架构正确的最小落地：**扫描 PDF 无文本层诊断**（零文本零表 + 有图像对象 → 明确 warning 建议 VLM 通道 `extract_chart_data_vlm`）+ **regex 回退 CJK/UTF-16 支持**（UTF-16BE hex-string PDF 字符串解码 + CJK 字面量透传）；**顺带修复 pre-existing bug**：`_decompress_pdf_streams` 的 `/Filter /FlateDecode` 匹配失败导致 decompression 一直是静默 no-op | P2-1 |
| P2 DE 分析 BH FDR 校正与 `padj` 输出（§2.7.4） | `run_differential_expression`：Benjamini-Hochberg 校正（scipy 交叉验证的 helper，NaN 收敛 1.0 不泄漏），DEG 条目新增 `padj`，**校正基于全集 p 值（top-N 截断前）**，排序保持原始 pvalue（spec 意图）；10 项新测试含手算 BH 示例 + 截断完整性 oracle | P2-2 |
| P2 `extract_tables` 真实 pdfplumber 路径测试与最小 PDF fixture（§2.7.5） | `backend/tests/fixtures/pdf/minimal_table.pdf`（真实可解析最小 PDF）+ `scanned_image.pdf`（无文本层 + 图像对象）；真实 pdfplumber 路径测试（无 mock）覆盖表格提取与元数据 | P2-3 |

## 验证

- 全量 `pytest -q`：**2658 passed**（baseline 2641 + 17 新：P2-2 +10，P2-1/3 +7），2 skipped，28 deselected
- `ruff check app/ tests/ launcher.py`：All checks passed（零告警）
- `python -c "import app.main"`：OK；uvicorn 冒烟 OK（P2-1/3 worker 验证）
- 前端未触碰

## 流程说明

- 两任务并行（P2-2 独立于 P2-1/3；P2-1 与 P2-3 同文件合并为一个 worker 避免冲突），均 dsv4-flash、TDD 红→绿。
- P2-1/3 的隔离 worktree 未生效（worker 直接在主 worktree 建分支），合并时经一次分支整理（98d7e68 → 1576b86），内容无损，全门复跑通过。
- P2-2 设计决策：`significant`/counts 保持原始 pvalue 语义向后兼容；padj-based 计数如需可一行跟进（记录于 `.superpowers/phase6/P2-2-report.md`）。
