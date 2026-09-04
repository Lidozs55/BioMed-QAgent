# Phase 5 PDF 技术选型 Spike（P5-08A / P5-D6）

> 状态：**结论已冻结**（P5-D6 依据）
> 范围：`extract_pdf_tables` / `extract_pdf_metadata` / `extract_chart_data_vlm`
> 的 TS PDF 后端选型；实施见 `server/src/processing/pdf/` 与 `server/src/processing/vlm/`。
> 实施计划：[phase5-external-capabilities-completion-plan.md](phase5-external-capabilities-completion-plan.md) Checkpoint P5-08。

## 1. 候选方案

仓库硬性约束（P5-D6）：不得为了 TS 长期新增 Python 运行时依赖；候选实现
必须能解释表格提取覆盖率、text metadata、CJK、image-only PDF、页面栅格化、
Windows/Arch 安装复杂度、取消治理。已安装依赖仅 `pdfjs-dist ^6.2.108` 与
`pngjs`，故候选集为：

| 候选 | 说明 |
| --- | --- |
| A. `pdfjs-dist` 6.2.108（legacy build） | Mozilla PDF.js 的 Node 通用构建，纯 JS（可选依赖 `@napi-rs/canvas` 未安装，用于页面渲染，本方案不依赖） |
| B. 无新依赖：raw PDF stream 正则 | 逐行移植 Python `extract_tables.py` 的 `_extract_text_via_regex` 等 fallback（zlib + regex，Node 内置） |

Python 侧 pdfplumber / PyPDF2 没有 Node 等价实现，且本 spike 按硬规则不新增依赖，
故不做第三种候选。B 只作为 A 的降级层保留（见 §4 决策），不单独作为主后端。

## 2. 实测结果（fixtures 在 `server/tests/phase5/fixtures/pdf/`）

实测环境：Node 24.11.1（引擎要求 ≥22.13，与项目 Node 22.19+ 兼容）、Windows。
pdfjs-dist 在 Node 下必须用 `legacy/build/pdf.mjs`（标准构建依赖 `DOMMatrix`，
Node 无此全局）；legacy 构建自动完成 fake-worker 装配（`workerSrc` 缺省为
`./pdf.worker.mjs`，Node 下无需额外配置）。

| 评估项 | pdfjs-dist 结果 | raw regex 结果 | 结论 |
| --- | --- | --- | --- |
| page count | `doc.numPages`（minimal_table=1、multipage=2 ✓） | 数 `/Type /Page[^s]`（Python 同款，无 xref 时兜底 1） | A 为准，B 兜底 |
| text | 14 个 text item，位置/字体齐全；注意 pdfjs 会插入空白 `" "` item（`h:0`），需过滤 | 仅能拿到 Tj/TJ 字符串，无位置 | A |
| metadata | `getMetadata().info`（Fixture 无 Info dict，与 Python 一致走文本启发式）；`standardFontDataUrl` 可传包内 `standard_fonts/` 消除字体告警 | — | A |
| DOI/caption 保持 | 文本启发式正则（DOI / `Figure N:` caption）与 Python 完全同构，golden 已对齐 | 同（Python fallback 路径） | 两者均保行为 |
| table extraction | 规则线表格：`constructPath`+`stroke` 算子给出线段坐标（minimal_table 得到 H=[600,620,640,660]、V=[72,180,300]），结合 text item 位置聚类，golden 一致（Gene/FC、BRCA1/1.5、TP53/2.0） | `_detect_delimited_rows`（≥2 列、模式列数过滤），仅能处理空白分隔行 | A 为主，B 兜底 |
| CJK | 无 ToUnicode/嵌入 CJK 字体的 PDF：文本为 mojibake（实测 UTF-8 literal 出 `Ł¡¤Ł`）；正常嵌入 ToUnicode 的 CJK PDF 可正确提取。Python 特制的无 xref CJK blob：pdfjs 直接 `InvalidPDFException` | Python 同款 `_decode_pdf_bytes` 启发式（UTF-16 BOM / NUL 交错 / UTF-8 / CJK 码点占比 / latin-1）可完整恢复 hex 与 literal CJK | B 覆盖 Python 特制场景；pdfjs 正常 CJK PDF 无退化 |
| scanned detection | 0 text item + operator list 含 `paintImageXObject`（OPS 85）→ 可判定；`scanned_image.pdf` 命中 | 无法判定图像 | A |
| image rasterization（VLM L1 输入） | **嵌入式栅格图**：`page.objs.get(name)` 返回 RGBA `Uint8ClampedArray`，pngjs 可编码 PNG（实测 2×2 DeviceGray → 67B PNG ✓）。**整页栅格化**：需要 Canvas 2D 实现（`@napi-rs/canvas` 未安装）→ 不可用 | 不可用 | A（有限制，见 §4.2 退化） |
| malformed PDF | `InvalidPDFException`（无 xref blob、乱码文件均失败） | 总能返回文本（可能为空） | A 抛错 → B 兜底 → 仍无结果则 error |
| Node/Windows/Arch 安装 | 纯 JS + 可选原生依赖不安装；无编译步骤；pnpm 已锁 `^6.2.108` | 零依赖 | 均满足 |
| cancellation 治理 | `PDFDocumentLoadingTask.destroy()` 可中止加载；文本/算子抽取为快速主线程操作；VLM HTTP 走 `PublicHttpClient` + `AbortSignal` | 纯同步 CPU 正则，无需取消 | 均满足 |
| 额外 Python runtime | 无 | 无 | 均满足 |

其它实测要点：

- pdfjs 6.x `getDocument({data})` 要求 `Uint8Array`（`Buffer` 会报错）；
- `PDFDocumentProxy.destroy()` 在 6.x 已改名 `cleanup()`；加载任务仍为
  `loadingTask.destroy()`；
- operator list 中 `OPS` 枚举可从 `pdfjs-dist/legacy/build/pdf.mjs` 导入
  （`OPS.paintImageXObject = 85`、`OPS.constructPath = 91`、`OPS.stroke = 20`、
  `OPS.clip = 29`、`OPS.endPath = 28`）；
- `constructPath` args 结构：`[pathOps, closePathInfo]`，pathOps 每项
  `{0: op, 1: x, 2: y, ...}`（0=moveTo, 1=lineTo）；clip 矩形（`re W n`）也
  以 constructPath 形式出现，可作图像 bbox 的近似来源。

## 3. Python golden parity 实测

用后端 venv（pdfplumber 0.11.10）对 `minimal_table.pdf` 生成 golden
（`server/tests/phase5/fixtures/pdf/golden/`）：

- 表格：1 表 / page 1 / 列 `["Gene","FC"]` / 2 行 / CSV 为 BOM + CRLF；
- metadata：title `Gene Expression Analysis in Cancer`、authors
  `Smith, J., Doe, A.`、doi `10.1234/test.5678`、abstract 吞并后续所有非
  全大写标题行（含表格文本）、num_pages 1、captions `[]`。

TS 表格算法（grid 聚类）对同一 fixture 复现相同行列；metadata 启发式逐条
对齐（含 abstract 的“吞并”行为）。TS CSV 以 utf-8-sig + CRLF 写出，与
Python 逐字节一致。

## 4. 选定方案与决策

### 4.1 主方案：pdfjs-dist（legacy build）为唯一主后端，raw regex 为降级层

```text
pdfjs-dist（文本/元数据/规则线表格/图像算子）
    ├─ 打开失败（malformed、无 xref 特制 blob）
    │     └─ raw PDF stream 正则（Python fallback 逐行移植，含 CJK 解码启发式）
    │           ├─ 检出表格行 → ok + warning（降级精度提示）
    │           └─ 无行 → error（malformed → error shape，不 silent success）
    ├─ 打开成功、无文本、有图像算子 → ok + 0 表 + scanned warning（指向 extract_chart_data_vlm）
    └─ 打开成功 → 表格 = grid 聚类（规则线）→ 位置聚类（无规则线）
```

决策理由：

1. pdfjs-dist 是仓库唯一已安装的 PDF 候选，纯 JS、零原生编译，Node/Windows/Arch
   均可安装，且不与 Phase 8“删除 Python 科学依赖”冲突；
2. 表格提取 parity 靠 text item 位置 + 规则线算子复现 pdfplumber 的 lines
   策略，golden 一致；无规则线表格退化为位置聚类（覆盖 pdfplumber 的
   text 策略子集）；
3. Python 的三级分层（pdfplumber → PyPDF2 → regex）在 TS 收敛为
   （pdfjs → raw regex）：PyPDF2 在 Python 中只提供 text 级启发式，TS 中该
   能力由 raw regex 层提供，不损失行为；
4. CJK：pdfjs 对正常 CJK PDF（含 ToUnicode）表现良好；对 Python 特制的无
   xref / 坏编码 CJK blob，pdfjs 直接打不开 → raw regex 层复用 Python 的
   `_decode_pdf_bytes` 启发式恢复，与 Python fallback 完全同构；
5. 扫描件检测：pdfjs 文本为空 + `paintImageXObject` 存在即可判定，行为与
   Python 一致（0 表 + 明确 warning，绝不 silent success）。

### 4.2 已记录的退化（有 warning，不静默成功）

| # | 退化 | 原因 | 影响与缓解 |
| --- | --- | --- | --- |
| D1 | **无整页栅格化**：pdfjs + pngjs 只能抽取 PDF 嵌入式栅格图像，不能像 pdfplumber `page.to_image()` 一样把页面（含纯矢量图表）栅格化 | `@napi-rs/canvas` 未安装（pdfjs 可选依赖），硬规则不允许新增依赖 | 纯矢量图表（无嵌入栅格图的 PDF）不产生 L1 图像 → 自动走 L2 表格 / L3 caption。对“矢量表格”类 PDF 无影响（表格走文本聚类）。`extract_chart_data_vlm` 的 L1 覆盖范围窄于 Python |
| D2 | 图像 bbox 来自 clip 矩形近似（`re W n` 的 constructPath），非 pdfplumber 的 image placement bbox | pdfjs operator list 不含图像摆放 bbox | chart_data.csv 的 `bbox` 列在常见裁剪场景下与 Python 一致，否则为空字符串（Python 必有值） |
| D3 | >10 MiB 图像无法降采样（Python 用 Pillow 缩到 1920px） | 未安装图像处理依赖 | 显式报 `ChartExtractionError`（“image too large and no downsampling available”），不静默截断 |
| D4 | L2/L3 的 `model_name` 记录 `pdfjs-dist` / `pdfjs-dist_captions`（Python 写 `pdfplumber`） | source-of-record 必须真实 | 字段语义不变；如需精确 parity 可后续映射 |
| D5 | TS 工具返回的 `outputs` / `saved_path` 为 **taskRoot 相对路径**（Python 为绝对路径） | P5-08B 明确要求“CSV paths relative to task root”；绝对路径泄漏部署细节 | 契约矩阵已按相对路径定义，不属于漂移 |

### 4.3 明确不做

- 不引入 OCR（与 Python 一致，pytesseract 早已移除；扫描件只给 warning）；
- 不引入 `@napi-rs/canvas` / sharp / 任何新依赖做栅格化或降采样；
- 不把 raw regex 层暴露为独立工具，只作为内部降级层。

## 5. 结论

**选定：pdfjs-dist 6.2.108（legacy build）为主后端 + raw PDF stream 正则降级层**，
满足 P5-D6 全部评估项；表格/元数据/CJK/扫描件检测均达成 fixture parity；
D1–D5 五处退化为显式、可审计的降级，均有 warning 或 error 信号，无静默成功路径。
