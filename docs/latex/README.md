# BioMed-QAgent 参赛作品报告（LaTeX）

把 `PROJECT_REPORT_DRAFT.md` 初稿完整转换为多章节 LaTeX 论文。

## 目录结构

```
docs/latex/
├── PROJECT_REPORT_DRAFT.md   # 唯一事实源（md 初稿；图片引用 ../architecture/*.svg）
├── main.tex                  # 主入口：文档类、项目元信息、章节装配（不含任何排版代码）
├── biomed-report.cls         # 模板入口：ctexbook 继承、页面、字体、宏包、metadata API
├── biomed-report-theme.sty   # 视觉主题：颜色、标题、页眉页脚、表格、代码、提示框、封面
├── chapters/                 # 每章一个 .tex（由脚本生成，勿手改）
│   ├── ch00-abstract.tex     #   参赛作品简介（不编号章）
│   ├── ch01-introduction.tex #   一、引言
│   ├── ch02-problem-definition.tex
│   ├── ch03-system-overview.tex
│   ├── ch04-dataset-core.tex
│   ├── ch05-experiments.tex
│   └── ch06-conclusion.tex
├── figures/                  # SVG 转 PDF（生成物，勿手改）
├── build/                    # 全部编译产物（git-ignored）
├── .vscode/settings.json     # LaTeX Workshop：latexmk XeLaTeX recipe，outDir=build
├── tools/
│   ├── md2latex.mjs          # md → chapters/*.tex 转换脚本
│   └── svg2pdf.mjs           # docs/architecture/*.svg → figures/*.pdf（Edge headless）
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

- 模板与排版只在两个文件：`biomed-report.cls`（页面/字体/宏包/`\code`/`L` 列型/metadata）
  与 `biomed-report-theme.sty`（颜色/标题/页眉页脚/代码/提示框/封面布局）。
  `main.tex` 只填元信息与装配章节,不写排版代码。
- `md2latex.mjs` 顶部 `TABLE_CAPTIONS`：表格 `\caption`/`\label`（按表头匹配）。
- 表内/正文的“见 3.2”式章节引用是字面数字，与 LaTeX 自动编号一一对应，无需手工改。

## 转换脚本说明

- `md2latex.mjs`：标题去手工编号交给 LaTeX 自动编号；`**粗体**`→`\textbf`、`` `代码` ``→`\code`、
  pipe 表格→`xltabular`、代码围栏→`lstlisting`、`![](...)`→`figure`。
  `\code` 用 `seqsplit` 支持长标识符（SHA-256、路径）折行；`_`/`/`/`+` 后插入断点防 Overfull。
- `svg2pdf.mjs`：用 Edge headless 打印 SVG 为矢量 PDF（无 Inkscape 依赖）；
  独立 `--user-data-dir` + 轮询等文件，规避 Edge 单实例委托与异步子进程问题。

## 质量基线

- 构建 0 error / 0 Overfull / 0 缺字符；`latexmk -xelatex -outdir=build`，产物全部在 `build/`；
- `\XeTeXgenerateactualtext=1`：PDF 中文可复制、可搜索（ToUnicode）；
- 仓库 `pnpm docs:check`（链接校验）已通过：md 图片引用 `../architecture/*.svg`。

## 换题 / 压页数时改哪里

- 换赛题颜色 / 标题样式 / 页眉页脚：只改 `biomed-report-theme.sty`；
- 页边距 / 字号 / 行距 / 宏包：只改 `biomed-report.cls`；
- 都不碰 `main.tex` 与 chapters（正文零排版代码）。