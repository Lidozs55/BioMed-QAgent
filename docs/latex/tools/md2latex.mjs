#!/usr/bin/env node
/**
 * md2latex.mjs — 把 docs/latex/PROJECT_REPORT_DRAFT.md 机械转换为多章节 LaTeX。
 *
 * 输出：docs/latex/chapters/chXX-*.tex（每章一个文件，含 \chapter/\section/\subsection、
 * xltabular 表格、lstlisting 代码、figure 图、itemize/enumerate 列表与行内 \code/\textbf）。
 *
 * 约束：只做机械转换 + 转义 + 结构生成；表题（caption）留占位注释供手工补，
 * 正文中引用章节号均为“见 3.2”式的字面数字（LaTeX 自动编号与 md 手工编号一一对应）。
 *
 * 用法：node tools/md2latex.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..'); // docs/latex
const MD = join(ROOT, 'PROJECT_REPORT_DRAFT.md');
const OUT = join(ROOT, 'chapters');

// ---------------------------------------------------------------- 转义与行内

function escapeTex(s) {
  const map = {
    '\\': '\\textbackslash{}',
    '{': '\\{',
    '}': '\\}',
    '%': '\\%',
    '#': '\\#',
    '&': '\\&',
    // 下划线/斜杠/加号后允许断行：长标识符、URL、组合词可折行，避免 Overfull
    '_': '\\_\\allowbreak{}',
    '/': '/\\allowbreak{}',
    '+': '+\\allowbreak{}',
    '$': '\\$',
    '~': '\\textasciitilde{}',
    '^': '\\textasciicircum{}',
  };
  return s.replace(/[\\{}%#&_$~^/+]/g, (c) => map[c]);
}

/** 行内转换：**bold** 与 `code` 交替出现，按字符流扫描，避免嵌套破坏。 */
function inline(s) {
  let out = '';
  let i = 0;
  let bold = false;
  while (i < s.length) {
    if (s.startsWith('**', i)) {
      out += bold ? '}' : '\\textbf{';
      bold = !bold;
      i += 2;
    } else if (s[i] === '`') {
      const j = s.indexOf('`', i + 1);
      if (j === -1) {
        out += escapeTex(s.slice(i));
        break;
      }
      out += '\\code{' + escapeTex(s.slice(i + 1, j)) + '}';
      i = j + 1;
    } else {
      const m = /`|\*\*/.exec(s.slice(i));
      const end = m ? i + m.index : s.length;
      out += escapeTex(s.slice(i, end));
      i = end;
    }
  }
  if (bold) out += '}'; // 防御未闭合的 **
  return out;
}

/** 去掉标题里的手工编号前缀：3.1 / 3.5.1 / 一、 */
function stripManualNumber(t) {
  return t.replace(/^\d+(\.\d+)*\s*/, '').replace(/^[一二三四五六七八九十]+、\s*/, '');
}

// ---------------------------------------------------------------- 块级转换

// ---------------------------------------------------------------- 表格题注
// 以“表头各列以 | 连接”为键，命中即生成 \caption + \label（放在 xltabular 首行）
const TABLE_CAPTIONS = {
  '相邻系统|已提供|本作的差异': { cap: '与相邻工程系统的差异对照', label: 'tab:related-comparison' },
  '案例 ID|研究主题|主要来源|Gold 规模（目标表）|主要难点': { cap: 'Gold 案例总览（案例 1--10）', label: 'tab:gold-overview' },
  '案例|研究主题|正式发布（Publication）|交付物|校验|上下文峰值': { cap: 'Gold7--9 正式发布与校验结果', label: 'tab:gold789-result' },
  '字段|值': { cap: 'Gold7 locus 真实样例行（v2）', label: 'tab:gold7-locus-sample' },
  '表|行数|字段（语义）': { cap: 'Gold9 输出四表结构', label: 'tab:gold9-tables' },
  '端点|方法|作用': { cap: '系统 HTTP API 端点', label: 'tab:api-endpoints' },
  '评价维度|三案例证据|尚存边界（详见 5.8）': { cap: '三案例对照赛题评价标准', label: 'tab:eval-criteria' },
  '#|边界|性质|改进状态': { cap: '三案例能力边界与改进项', label: 'tab:boundaries' },
};

function toLatexTable(header, body) {
  const cols = header.length;
  const head = header.map((c) => '\\textbf{' + inline(c) + '}').join(' & ') + ' \\\\';
  const meta = TABLE_CAPTIONS[header.join('|')];
  const lines = [
    '\\begin{xltabular}{\\linewidth}{' + 'L'.repeat(cols) + '}',
  ];
  if (meta) {
    lines.push(`\\caption{${meta.cap}}\\label{${meta.label}}\\\\`);
  } else {
    lines.push('% 表题待补：本节表格请手工补 \\caption{...}\\label{tab:...}（下面一行）');
  }
  lines.push('\\toprule');
  lines.push(head);
  lines.push('\\midrule');
  lines.push('\\endfirsthead');
  lines.push('\\toprule');
  lines.push(head);
  lines.push('\\midrule');
  lines.push('\\endhead');
  for (const r of body) lines.push(r.map((c) => inline(c)).join(' & ') + ' \\\\');
  lines.push('\\bottomrule');
  lines.push('\\end{xltabular}');
  return lines.join('\n');
}

function toLatexFigure(alt, path) {
  const name = basename(path).replace(/\.svg$/i, '');
  // 主图横版占满文本宽；Core 详图为竖版长图，限制宽度避免超出页
  const opts = name.includes('core-deterministic')
    ? 'width=0.68\\textwidth'
    : 'width=\\textwidth';
  const label = name.includes('core-deterministic') ? 'fig:core-deterministic-flow' : 'fig:main-architecture';
  return [
    '\\begin{figure}[htbp]',
    '  \\centering',
    `  \\includegraphics[${opts}]{images/${name}.pdf}`,
    `  \\caption{${inline(alt)}}`,
    `  \\label{${label}}`,
    '\\end{figure}',
  ].join('\n');
}

// ---------------------------------------------------------------- 章节定义

const CHAPTER_DEFS = [
  { heading: '参赛作品简介', file: 'ch00-abstract.tex' },
  { heading: '一、引言', file: 'ch01-introduction.tex' },
  { heading: '二、问题定义', file: 'ch02-problem-definition.tex' },
  { heading: '三、Core 外部：系统组成与 Agent 设计', file: 'ch03-system-overview.tex' },
  { heading: '四、Dataset Core：确定性八阶段流水线', file: 'ch04-dataset-core.tex' },
  { heading: '五、实验与案例', file: 'ch05-experiments.tex' },
  { heading: '六、总结与讨论', file: 'ch06-conclusion.tex' },
];

function chapterIntro(def) {
  if (def.heading === '参赛作品简介') {
    return `\\chapter*{参赛作品简介}\n\\addcontentsline{toc}{chapter}{参赛作品简介}`;
  }
  return `\\chapter{${stripManualNumber(def.heading)}}`;
}

// ---------------------------------------------------------------- 主流程

const md = readFileSync(MD, 'utf8');
const lines = md.split(/\r?\n/);

/** 行归类（含围栏行；围栏开关在调用方先行处理） */
function classify(l, inCode) {
  if (inCode) return 'code';
  const t = l.trim();
  if (t.startsWith('#### ')) return 'h4';
  if (t.startsWith('### ')) return 'h3';
  if (t.startsWith('|')) return 'table';
  if (/^\s*[-*]\s+/.test(l)) return 'ul';
  if (/^\s*\d+[.)、]\s+/.test(l)) return 'ol';
  if (t.startsWith('![')) return 'figure';
  if (t === '') return 'blank';
  return 'text';
}

const chapters = [];
let cur = null;

let pendingList = null; // { type: 'itemize'|'enumerate', items: [] }
let pendingPara = []; // raw lines（md 一段可能折成多行）
let inCode = false;
let codeBuf = [];

function flushPara(out) {
  if (pendingPara.length) {
    out.push(inline(pendingPara.join(' ').trim()));
    pendingPara = [];
  }
}
function flushList(out) {
  if (pendingList) {
    out.push(`\\begin{${pendingList.type}}`);
    for (const it of pendingList.items) out.push(`  \\item ${it}`);
    out.push(`\\end{${pendingList.type}}`);
    pendingList = null;
  }
}
function flushTable(out) {
  if (tableBuf.length >= 2) {
    const rows = tableBuf.map((r) =>
      r
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim())
    );
    const norm = rows.filter((r) => !r.every((c) => /^:?-+:?$/.test(c)));
    out.push(toLatexTable(norm[0], norm.slice(1)));
    tableBuf = [];
  }
}
function flushAll(out) {
  flushPara(out);
  flushList(out);
  flushTable(out);
}
function pushBlock(out, block) {
  flushAll(out);
  if (out.length && out[out.length - 1] !== '') out.push('');
  out.push(block);
  out.push('');
}

let tableBuf = [];

for (const l of lines) {
  // 代码围栏开关必须优先于一切（含章节切换），否则闭合行会被吞进 codeBuf
  if (/^\s*```/.test(l)) {
    const out = cur ? cur.body : null;
    if (inCode) {
      if (out) {
        flushAll(out);
        out.push('\\begin{lstlisting}[style=papercode]');
        out.push(...codeBuf);
        out.push('\\end{lstlisting}');
        out.push('');
      }
      codeBuf = [];
      inCode = false;
    } else {
      if (out) flushAll(out);
      codeBuf = [];
      inCode = true;
    }
    continue;
  }

  // 章节切换
  const h2 = /^##\s+(.+)$/.exec(l);
  if (h2 && !inCode) {
    const def = CHAPTER_DEFS.find((d) => d.heading === h2[1].trim());
    if (!def) throw new Error(`未知章标题：${h2[1]}`);
    if (cur) { flushAll(cur.body); chapters.push(cur); }
    cur = { def, body: [] };
    cur.body.push(chapterIntro(def));
    cur.body.push('');
    continue;
  }

  if (!cur) continue; // 第一个 ## 之前无正文

  const k = classify(l, inCode);
  const out = cur.body;

  switch (k) {
    case 'code':
      codeBuf.push(l);
      break;
    case 'h3':
      pushBlock(out, '\\section{' + inline(stripManualNumber(l.trim().slice(4).trim())) + '}');
      break;
    case 'h4':
      pushBlock(out, '\\subsection{' + inline(stripManualNumber(l.trim().slice(5).trim())) + '}');
      break;
    case 'ul':
    case 'ol': {
      flushPara(out);
      if (tableBuf.length) flushTable(out);
      const type = k === 'ul' ? 'itemize' : 'enumerate';
      const item = inline(l.replace(/^\s*[-*]\s+/, '').replace(/^\s*\d+[.)、]\s+/, ''));
      if (pendingList && pendingList.type === type) pendingList.items.push(item);
      else { if (pendingList) flushList(out); pendingList = { type, items: [item] }; }
      break;
    }
    case 'table':
      flushPara(out);
      if (pendingList) flushList(out);
      tableBuf.push(l);
      break;
    case 'figure':
      pushBlock(out, toLatexFigure(l.replace(/^!\[([^\]]*)\]\(.*$/, '$1'), l.replace(/^!\[[^\]]*\]\(([^)]+)\)$/, '$1')));
      break;
    case 'blank':
      flushAll(out);
      break;
    default: {
      // text
      if (pendingList) flushList(out);
      pendingPara.push(l);
      break;
    }
  }
}
if (cur) { flushAll(cur.body); chapters.push(cur); }

// ---------------------------------------------------------------- 写文件

mkdirSync(OUT, { recursive: true });
let totalTables = 0;
for (const c of chapters) {
  const text = c.body.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  writeFileSync(join(OUT, c.def.file), text);
  const nTab = (text.match(/begin\{xltabular\}/g) || []).length;
  const nFig = (text.match(/begin\{figure\}/g) || []).length;
  totalTables += nTab;
  console.log(`${c.def.file.padEnd(28)} 表格=${nTab} 图=${nFig} 行=${text.split('\n').length}`);
}

// ---------------------------------------------------------------- 自检

const all = chapters.map((c) => c.body.join('\n')).join('\n');
const checks = [
  ['残留反引号', /`/],
  ['残留加粗标记', /\*\*/],
  ['残留图片语法', /!\[/],
  ['残留链接语法', /\]\(\)/],
  ['残留围栏', /^\s*```/m],
];
let warn = 0;
for (const [name, re] of checks) {
  const m = all.match(re);
  if (m) {
    const lineNo = md.split('\n').findIndex((l) => re.test(l)) + 1;
    console.warn(`[自检] ${name}: md 第 ${lineNo} 行附近仍有匹配`);
    warn++;
  }
}
console.log(`[md2latex] 完成：${chapters.length} 章，表格 ${totalTables} 张，自检警告 ${warn} 项`);