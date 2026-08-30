# BioMed-QAgent 参赛作品报告（LaTeX）

参赛报告的多章节 LaTeX 源（初稿 md 与自动转换流程已于 2026-08-30 停用，
`chapters/*.tex` 为直接维护的事实源）。

## 目录结构

```
docs/latex/
├── main.tex                  # 主文件：ctexbook 文档类、宏包、封面/前言/目录、章节装配
├── chapters/                 # 每章一个 .tex（直接编辑）
│   ├── ch00-abstract.tex     #   参赛作品简介（不编号章）
│   ├── ch01-introduction.tex #   一、引言
│   ├── ch02-problem-definition.tex
│   ├── ch03-system-overview.tex
│   ├── ch04-dataset-core.tex
│   ├── ch05-experiments.tex
│   └── ch06-conclusion.tex
├── images/                   # 直接维护的 PDF 图源（主架构图、Core 数据流图）
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

- `main.tex`：文档类、宏包、封面、目录、页眉页脚、`\code`/`lstlisting` 样式、表列型 `L`。
- 表内/正文的“见 3.2”式章节引用是字面数字，与 LaTeX 自动编号一一对应，无需手工改。

## 质量基线

- 构建 0 error / 0 Overfull / 0 缺字符；
- `\XeTeXgenerateactualtext=1`：PDF 中文可复制、可搜索（ToUnicode）；
- 仓库 `pnpm docs:check`（本地 Markdown 链接校验，`scripts/check-doc-links.mjs`）已通过。