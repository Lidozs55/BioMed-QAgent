# BioMed-QAgent 参赛作品报告（LaTeX）

把 `PROJECT_REPORT_DRAFT.md` 初稿完整转换为多章节 LaTeX 论文。

## 目录结构

```
docs/latex/
├── PROJECT_REPORT_DRAFT.md   # 唯一事实源（md 初稿；图片引用 ../architecture/*.svg）
├── REVISION-GUIDE.md         # 30 页改版指南（页面预算/逐章指令/取数清单）
├── main.tex                  # 主文件：ctexbook 文档类、宏包、封面/前言/目录、章节装配
├── chapters/                 # 每章一个 .tex（由脚本生成，勿手改）
│   ├── ch00-abstract.tex     #   参赛作品简介（不编号章）
│   ├── ch01-introduction.tex #   一、引言
│   ├── ch02-problem-definition.tex
│   ├── ch03-system-overview.tex
│   ├── ch04-dataset-core.tex
│   ├── ch05-experiments.tex
│   └── ch06-conclusion.tex
├── images/                   # SVG 转 PDF（生成物，勿手改）
├── tools/
│   ├── md2latex.mjs          # md → chapters/*.tex 转换脚本
│   └── svg2pdf.mjs           # docs/architecture/*.svg → images/*.pdf（Edge headless）
└── .gitignore                # 忽略 build/ 与转换临时文件
```

## 构建

```bash
cd docs/latex
latexmk -xelatex -outdir=build main.tex   # 输出 build/main.pdf（A4）
```

需要 TeX Live（xelatex + ctex）。中文字体自动探测（Windows SimSun/SimHei/FangSong），
无外部字体要求。

## 内容修改流程

1. 改 `PROJECT_REPORT_DRAFT.md`（唯一事实源）；
2. `node tools/md2latex.mjs` 重新生成 `chapters/*.tex`；
3. 重新 `latexmk` 构建。

## 手工维护项（脚本不覆盖）

- `main.tex`：文档类、宏包、封面、目录、页眉页脚、`\code`/`lstlisting` 样式、表列型 `L`。
- `md2latex.mjs` 顶部 `TABLE_CAPTIONS`：表格 `\caption`/`\label`（按表头匹配）。
- 表内/正文的“见 3.2”式章节引用是字面数字，与 LaTeX 自动编号一一对应，无需手工改。

## 转换脚本说明

- `md2latex.mjs`：标题去手工编号交给 LaTeX 自动编号；`**粗体**`→`\textbf`、`` `代码` ``→`\code`、
  pipe 表格→`xltabular`、代码围栏→`lstlisting`、`![](...)`→`figure`。
  `\code` 用 `seqsplit` 支持长标识符（SHA-256、路径）折行；`_`/`/`/`+` 后插入断点防 Overfull。
- `svg2pdf.mjs`：用 Edge headless 打印 SVG 为矢量 PDF（无 Inkscape 依赖）；
  独立 `--user-data-dir` + 轮询等文件，规避 Edge 单实例委托与异步子进程问题。

## 质量基线

- 构建 0 error / 0 Overfull / 0 缺字符；
- `\XeTeXgenerateactualtext=1`：PDF 中文可复制、可搜索（ToUnicode）；
- 仓库 `pnpm docs:check`（链接校验）已通过：md 图片引用 `../architecture/*.svg`。