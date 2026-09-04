#!/usr/bin/env node
/**
 * svg2pdf.mjs — 把 docs/architecture/*.svg 转成 docs/latex/figures/*.pdf。
 *
 * 原理：本机无 inkscape/pandoc，但装有 Edge（Chromium）。用 Edge headless 把
 * 包着 <img> 的临时 HTML（@page 尺寸 = SVG 宽高）打印为矢量 PDF。
 * 用法：node tools/svg2pdf.mjs [svg...]；默认转两张主图。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..'); // docs/latex
const REPO = resolve(ROOT, '..', '..'); // 仓库根
const OUT_DIR = join(ROOT, 'figures');

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];

const DEFAULTS = [
  join(REPO, 'docs', 'architecture', 'biomed-qagent-main.svg'),
  join(REPO, 'docs', 'architecture', 'biomed-qagent-core-deterministic-flow.svg'),
];

function findEdge() {
  return EDGE_CANDIDATES.find((p) => existsSync(p));
}

function svgSize(svgPath) {
  const xml = readFileSync(svgPath, 'utf8');
  const w = /<svg[^>]*\bwidth="([\d.]+)px?"/.exec(xml);
  const h = /<svg[^>]*\bheight="([\d.]+)px?"/.exec(xml);
  return { w: w ? parseFloat(w[1]) : null, h: h ? parseFloat(h[1]) : null };
}

// 清理是尽力而为：Edge 子进程可能仍持有句柄，稍后删除也可能失败
function tryRm(p) {
  try {
    rmSync(p, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 });
  } catch {
    /* ignore */
  }
}

function waitForFile(p, ms = 30000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (existsSync(p)) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  return existsSync(p);
}

async function convert(svgPath, edge) {
  const { w, h } = svgSize(svgPath);
  if (!w || !h) throw new Error(`无法读取 ${basename(svgPath)} 的 width/height`);
  const name = basename(svgPath).replace(/\.svg$/i, '');
  const outPdf = join(OUT_DIR, `${name}.pdf`);
  const tmpHtml = join(OUT_DIR, `_tmp_${name}.html`);
  const tmpPdf = join(OUT_DIR, `_tmp_${name}.pdf`);
  const svgUrl = 'file:///' + svgPath.replace(/\\/g, '/');

  // 96dpi 下 1px = 0.75pt；页面与图同尺寸，无页边距
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: ${(w * 0.75).toFixed(2)}pt ${(h * 0.75).toFixed(2)}pt; margin: 0; }
    html, body { margin: 0; padding: 0; }
    img { width: ${w}px; height: ${h}px; display: block; }
  </style></head><body><img src="${svgUrl}"></body></html>`;
  writeFileSync(tmpHtml, html, 'utf8');

  const runOnce = () => {
    // 每次尝试都要全新的 profile：a) Edge 已在运行时会委托给现有实例并立即
    // 退出，必须用独立 profile；b) 上一次残留的锁/句柄会破坏下一次
    const profile = join(OUT_DIR, `_tmp_profile_${name}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--no-pdf-header-footer',
      `--user-data-dir=${profile}`,
      `--print-to-pdf=${tmpPdf}`,
      `--virtual-time-budget=3000`,
      `file:///${tmpHtml.replace(/\\/g, '/')}`,
    ];
    // msedge.exe 是启动器：--headless=new 的真实渲染是异步子进程，spawnSync
    // 常提前返回 exit=0 而 PDF 尚未落盘 —— 之后轮询等待文件出现
    spawnSync(edge, args, { timeout: 80000, stdio: 'ignore' });
    const ok = waitForFile(tmpPdf);
    tryRm(profile);
    return ok;
  };

  if (!runOnce() && !runOnce()) {
    tryRm(tmpPdf);
    tryRm(tmpHtml);
    throw new Error(`Edge 两次尝试均未产出 ${name}.pdf`);
  }
  writeFileSync(outPdf, readFileSync(tmpPdf));
  tryRm(tmpPdf);
  tryRm(tmpHtml);
  return { name, w, h, outPdf };
}

const edge = findEdge();
if (!edge) {
  console.error('[svg2pdf] 未找到 Edge/Chrome，请先安装或手工转换 SVG→PDF');
  process.exit(1);
}
mkdirSync(OUT_DIR, { recursive: true });

const targets = process.argv.slice(2);
const jobs = targets.length ? targets : DEFAULTS;
for (const t of jobs) {
  const svg = resolve(process.cwd(), t);
  const r = await convert(svg, edge);
  console.log(`[svg2pdf] ${basename(r.outPdf)}  ${r.w}x${r.h}px -> ${r.outPdf}`);
}

// 末尾清扫：Edge 子进程此时已基本退出，残留的 _tmp_* 兜底删掉
await new Promise((r) => setTimeout(r, 1500));
for (const f of readdirSync(OUT_DIR)) {
  if (f.startsWith('_tmp_')) tryRm(join(OUT_DIR, f));
}
console.log('[svg2pdf] done');