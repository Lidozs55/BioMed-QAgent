# BioMed-QAgent 参赛作品报告（LaTeX）

参赛报告的多章节 LaTeX 源（初稿 md 与自动转换流程已于 2026-08-30 停用，
`chapters/*.tex` 为直接维护的事实源；排版由模板文件承载，正文文件不写排版代码）。

## 目录结构

```
docs/latex/
├── main.tex                  # 主入口：文档类（biomed-report）、项目元信息、章节装配
├── biomed-report.cls         # 模板入口：ctexbook 继承、页面、字体、宏包、metadata API
├── biomed-report-theme.sty   # 视觉主题：颜色、标题、页眉页脚、表格、代码、提示框、封面
├── chapters/                 # 每章一个 .tex（直接编辑）
│   ├── ch00-submission-table.tex  #   封面参赛信息表（无章标题，由模板装配）
│   ├── ch01-introduction.tex #   一、引言
│   ├── ch02-problem-definition.tex
│   ├── ch03-system-overview.tex
│   ├── ch04-dataset-core.tex
│   ├── ch05-experiments.tex
│   └── ch06-conclusion.tex
├── figures/                  # PDF 图源（主架构图、Core 数据流图、报名截图；随仓库维护）
├── build/                    # 编译产物（git-ignored）
└── .gitignore                # 忽略 build/ 与 LaTeX 编译中间产物
```

## 构建

```bash
cd docs/latex
latexmk -xelatex -outdir=build main.tex   # 输出 build/main.pdf（A4）
```

需要 TeX Live（xelatex + ctex）。中文字体自动探测（Windows SimSun/SimHei/FangSong），
无外部字体要求。

## 内容修改流程

1. 直接编辑 `chapters/*.tex`；
2. `latexmk -xelatex -outdir=build main.tex` 重新构建。

## 手工维护项

- 排版只在两个文件：`biomed-report.cls`（页面/字体/宏包/`\code`/`L` 列型/metadata API）
  与 `biomed-report-theme.sty`（颜色/标题/页眉页脚/代码/提示框/封面布局）。
  `main.tex` 只填元信息与装配章节，不写排版代码。
- 表内/正文的“见 3.2”式章节引用是字面数字，与 LaTeX 自动编号一一对应，无需手工改。

## 质量基线

- 构建 0 error / 0 Overfull / 0 缺字符；`latexmk -xelatex -outdir=build`，产物全部在 `build/`；
- `\XeTeXgenerateactualtext=1`：PDF 中文可复制、可搜索（ToUnicode）；
- 仓库 `pnpm docs:check`（本地 Markdown 链接校验，`scripts/check-doc-links.mjs`）已通过。

## 换题 / 压页数时改哪里

- 换赛题颜色 / 标题样式 / 页眉页脚：只改 `biomed-report-theme.sty`；
- 页边距 / 字号 / 行距 / 宏包：只改 `biomed-report.cls`；
- 都不碰 `main.tex` 与 chapters（正文零排版代码）。