%% =====================================================================
%% biomed-report.cls — BioMed-QAgent 参赛报告文档类
%%
%% 职责：继承 ctexbook、XeLaTeX 校验、页面尺寸、字体、通用宏包、
%%       基础排版、项目 metadata API、封面/摘要骨架。
%% 视觉（颜色/标题/页眉页脚/代码/提示框）见 biomed-report-theme.sty，
%% 由本文件在末尾加载。
%% =====================================================================

\NeedsTeXFormat{LaTeX2e}
\ProvidesClass{biomed-report}[2026/08/30 BioMed-QAgent competition report]

% 继承 ctexbook（不要再 \RequirePackage{ctex}，会与 ctexbook 冲突）
\LoadClass[
  UTF8,
  scheme=chinese,
  zihao=5,
  oneside,
  openany
]{ctexbook}

% --------------------------------------------------------------
% 编译器限制：仅 XeLaTeX
% --------------------------------------------------------------
\RequirePackage{iftex}

\ifXeTeX
\else
  \ClassError{biomed-report}
    {Please compile with XeLaTeX}
    {Use latexmk -xelatex or XeLaTeX.}
\fi

% --------------------------------------------------------------
% 页面尺寸：紧凑技术报告
% --------------------------------------------------------------
\RequirePackage[
  a4paper,
  top=20mm,
  bottom=16mm,
  left=18mm,
  right=18mm,
  headheight=32pt,
  headsep=14pt,
  footskip=8mm
]{geometry}

% --------------------------------------------------------------
% 字体（英文；中文由 ctex 按系统自动选择，不在此固定 CJK 字体）
% --------------------------------------------------------------
\setmainfont{TeX Gyre Termes}
\setsansfont{TeX Gyre Heros}
\setmonofont{Latin Modern Mono}

% XeTeX 写入 ToUnicode，保证 PDF 中文可复制、可搜索
\XeTeXgenerateactualtext=1

% --------------------------------------------------------------
% 通用宏包（统一在此加载，main.tex 禁止再 \usepackage）
% --------------------------------------------------------------
\RequirePackage{graphicx}
\RequirePackage{pdflscape}   % 横排页面（主架构图等大图可用）
\RequirePackage{booktabs}
\RequirePackage{array}
\RequirePackage{tabularx}
\RequirePackage{xltabular}
\RequirePackage{multirow}

\RequirePackage{amsmath}
\RequirePackage{amssymb}

\RequirePackage{enumitem}
\RequirePackage{caption}
\RequirePackage{subcaption}

\RequirePackage{xcolor}
\RequirePackage{fancyhdr}
\RequirePackage{titlesec}

\RequirePackage{hyperref}

\RequirePackage{listings}
\RequirePackage{tcolorbox}

\RequirePackage{seqsplit}
\RequirePackage{newunicodechar}

\RequirePackage{float}
\RequirePackage{placeins}
\RequirePackage{etoolbox}

% --------------------------------------------------------------
% 基础排版：紧凑但不失阅读性
% --------------------------------------------------------------
\setlength{\parindent}{2em}
\setlength{\parskip}{0pt}
\linespread{1.15}
\emergencystretch=3em

% --------------------------------------------------------------
% 项目 metadata API（只存值；所有显示方式在 theme 中实现）
% --------------------------------------------------------------
\newcommand{\ReportTitle}{作品技术报告}
\newcommand{\ReportSubtitle}{}
\newcommand{\ReportShortTitle}{作品技术报告}
\newcommand{\ReportTeam}{团队名称}
\newcommand{\ReportSchool}{学校名称}
\newcommand{\ReportTrack}{赛题方向}
\newcommand{\ReportDate}{\today}

% 页眉左/右内容（默认：参赛编号 / 作品编码）
\newcommand{\ReportLeftHeader}{XH-202619}
\newcommand{\ReportRightHeader}{作品编码 611186}

\newcommand{\reporttitle}[1]{\renewcommand{\ReportTitle}{#1}}
\newcommand{\reportsubtitle}[1]{\renewcommand{\ReportSubtitle}{#1}}
\newcommand{\reportshorttitle}[1]{\renewcommand{\ReportShortTitle}{#1}}
\newcommand{\reportteam}[1]{\renewcommand{\ReportTeam}{#1}}
\newcommand{\reportschool}[1]{\renewcommand{\ReportSchool}{#1}}
\newcommand{\reporttrack}[1]{\renewcommand{\ReportTrack}{#1}}
\newcommand{\reportdate}[1]{\renewcommand{\ReportDate}{#1}}
\newcommand{\reportleftheader}[1]{\renewcommand{\ReportLeftHeader}{#1}}
\newcommand{\reportrightheader}[1]{\renewcommand{\ReportRightHeader}{#1}}

% --------------------------------------------------------------
% Unicode 映射（正文出现的 Unicode 数学符号 → 数学模式）
% --------------------------------------------------------------
\newunicodechar{≠}{\ensuremath{\neq}}
\newunicodechar{↔}{\ensuremath{\leftrightarrow}}

% --------------------------------------------------------------
% 表格列类型：中文长表左对齐自动换行
% --------------------------------------------------------------
\newcolumntype{L}{>{\raggedright\arraybackslash}X}

% --------------------------------------------------------------
% 行内代码：长路径 / SHA-256 / identifier 允许任意字符处断行
% --------------------------------------------------------------
\DeclareRobustCommand{\code}[1]{%
  \texttt{\seqsplit{#1}}%
}

% --------------------------------------------------------------
% 摘要环境：由模板统一控制样式，替代手写 \chapter*
% --------------------------------------------------------------
\newenvironment{reportabstract}{%
  \chapter*{参赛作品简介}%
  \addcontentsline{toc}{chapter}{参赛作品简介}%
}{}

% --------------------------------------------------------------
% 封面骨架：布局由 theme 定义
% --------------------------------------------------------------
\newcommand{\makereporttitle}{}

% --------------------------------------------------------------
% PDF metadata：由 metadata 字段生成（hidelinks，正式报告风格）
% --------------------------------------------------------------
\AtBeginDocument{%
  \hypersetup{
    pdftitle={\ReportTitle——\ReportSubtitle},
    pdfauthor={\ReportTeam},
    pdfsubject={\ReportTrack},
    bookmarksnumbered=true,
    hidelinks
  }%
}

% --------------------------------------------------------------
% 视觉主题（颜色/标题/页眉页脚/表格/代码/提示框/封面布局）
% --------------------------------------------------------------
\RequirePackage{biomed-report-theme}

\endinput
