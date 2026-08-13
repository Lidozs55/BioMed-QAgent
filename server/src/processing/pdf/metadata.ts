/**
 * PDF metadata extraction (P5-08B, Python ``extract_pdf_metadata`` parity).
 *
 * Python ignores the PDF Info dictionary and heuristically derives title /
 * authors / DOI / abstract / captions from the extracted text; this module
 * ports those heuristics verbatim onto pdfjs text (regex fallback tier when
 * pdfjs cannot open the file). Golden parity: see
 * ``server/tests/phase5/fixtures/pdf/golden/minimal_table_metadata.golden.json``.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveTaskLocalFile, toTaskRelative } from "../paths.js";
import { openPdf, readPdfBytes } from "./pdfjs.js";
import { countPagesViaRegex, extractTextViaRegex } from "./raw-regex.js";

const DOI_RE = /(10\.\d{4,}\/[^\s]+)/g;
const CAPTION_RE = /^(Fig(?:ure)?|Table)\s*\d+[\.:]\s*(.*)/gim;
const HEADING_RE = /^(?:Abstract|ABSTRACT|A B S T R A C T)\s*$/m;
const ALL_CAPS_HEADING_RE = /^[A-Z][A-Z\s]{4,}$/;

export interface PdfMetadata {
  source_file: string;
  title: string;
  authors: string;
  doi: string;
  abstract: string;
  captions: string[];
  num_pages: number;
}

export interface PdfMetadataError {
  status: "error";
  error: string;
  source_file: string;
}

export interface PdfMetadataOk {
  status: "ok";
  source_file: string;
  outputs: string[];
  summary: PdfMetadata;
  warning?: string;
}

export type PdfMetadataResult = PdfMetadataOk | PdfMetadataError;

/** Extract full text and page count (pdfjs tier with regex fallback). */
export async function extractTextForMetadata(filePath: string): Promise<{ text: string; pageCount: number; degraded: boolean }> {
  let opened: Awaited<ReturnType<typeof openPdf>> | null = null;
  try {
    opened = await openPdf(await readPdfBytes(filePath));
  } catch {
    opened = null;
  }
  if (opened !== null) {
    try {
      const pages: string[] = [];
      for (let pageNumber = 1; pageNumber <= opened.numPages; pageNumber += 1) {
        const page = await opened.page(pageNumber);
        pages.push(page.items.map((item) => item.str).join("\n"));
      }
      return { text: pages.join("\n\n"), pageCount: opened.numPages, degraded: false };
    } finally {
      await opened.close();
    }
  }
  return {
    text: extractTextViaRegex(filePath),
    pageCount: countPagesViaRegex(filePath),
    degraded: true,
  };
}

/** Heuristic metadata derivation (Python ``extract_pdf_metadata`` parity). */
export function deriveMetadata(fullText: string, pageCount: number, sourceName: string): PdfMetadata {
  const lines = fullText.split("\n");
  const textSingle = fullText.replace(/\n/g, " ");

  // ── title: first non-empty line with > 1 word ────────────────────────
  let title = "";
  for (const line of lines) {
    const stripped = line.trim();
    if (stripped !== "" && stripped.split(/\s+/).length > 1) {
      title = stripped;
      break;
    }
  }

  // ── authors: capitalized-name patterns in the first 15 lines ─────────
  const authorLines: string[] = [];
  for (const line of lines.slice(1, 15)) {
    const stripped = line.trim();
    if (stripped === "" || stripped.length > 200) continue;
    if (/[A-Z][a-z]+,\s*[A-Z]/.test(stripped) || /([A-Z][a-z]+)\s{2,}([A-Z][a-z]+)/.test(stripped)) {
      authorLines.push(stripped);
    }
  }
  const authors = authorLines.length > 0 ? authorLines.join("; ") : "";

  // ── DOI ──────────────────────────────────────────────────────────────
  let doi = "";
  const doiMatch = DOI_RE.exec(textSingle);
  if (doiMatch !== null) {
    doi = doiMatch[1].replace(/[.,;:]+$/, "").replace(/[.,;:)]+$/, "");
  }

  // ── abstract: paragraph after the "Abstract" heading ─────────────────
  let abstract = "";
  const headingMatch = HEADING_RE.exec(fullText);
  if (headingMatch !== null) {
    const afterAbstract = fullText.slice(headingMatch.index + headingMatch[0].length);
    const paraLines: string[] = [];
    for (const line of afterAbstract.split("\n")) {
      const stripped = line.trim();
      if (stripped === "") {
        if (paraLines.length > 0) break;
        continue;
      }
      if (ALL_CAPS_HEADING_RE.test(stripped) && stripped.length < 60) break;
      paraLines.push(stripped);
      if (paraLines.join(" ").length > 2000) break;
    }
    abstract = paraLines.join(" ").trim();
  }
  if (abstract === "") {
    for (let i = 0; i < lines.length; i += 1) {
      if (i < 5) continue;
      const stripped = lines[i].trim();
      if (stripped !== "" && stripped.length > 50) {
        abstract = stripped;
        break;
      }
    }
  }

  // ── captions ─────────────────────────────────────────────────────────
  const captions: string[] = [];
  for (const match of fullText.matchAll(CAPTION_RE)) {
    const captionText = (match[2] ?? "").trim();
    if (captionText !== "") {
      captions.push(captionText);
    } else {
      captions.push(match[0].trim());
    }
  }

  return { source_file: sourceName, title, authors, doi, abstract, captions, num_pages: pageCount };
}

/**
 * ``extract_pdf_metadata`` tool implementation. Writes
 * ``<taskRoot>/parsed/<stem>_metadata.json`` and returns the P5-08B contract.
 */
export async function extractPdfMetadata(filePath: string, options: { taskRoot: string }): Promise<PdfMetadataResult> {
  const { taskRoot } = options;

  let resolved: string;
  try {
    resolved = await resolveTaskLocalFile(filePath, taskRoot);
  } catch (error) {
    const isMissing = error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
    return {
      status: "error",
      error: isMissing
        ? `文件不存在: ${filePath}`
        : error instanceof Error
          ? error.message
          : String(error),
      source_file: filePath,
    };
  }

  const extension = path.extname(resolved).toLowerCase();
  if (!extension.endsWith("pdf")) {
    return {
      status: "error",
      error: `不支持的文件类型: ${extension}（需要 .pdf）`,
      source_file: filePath,
    };
  }

  let text: string;
  let pageCount: number;
  let degraded = false;
  try {
    const extracted = await extractTextForMetadata(resolved);
    text = extracted.text;
    pageCount = extracted.pageCount;
    degraded = extracted.degraded;
  } catch (error) {
    return {
      status: "error",
      error: `文本提取失败: ${error instanceof Error ? error.message : String(error)}`,
      source_file: filePath,
    };
  }

  const sourceName = path.basename(resolved);
  const metadata = deriveMetadata(text, pageCount, sourceName);

  const parsedDir = path.join(taskRoot, "parsed");
  await mkdir(parsedDir, { recursive: true });
  const stem = path.basename(resolved, path.extname(resolved));
  const metaPath = path.join(parsedDir, `${stem}_metadata.json`);
  try {
    await writeFile(metaPath, JSON.stringify(metadata, null, 2) + "\n", "utf8");
  } catch (error) {
    return {
      status: "error",
      error: `写入元数据 JSON 失败: ${error instanceof Error ? error.message : String(error)}`,
      source_file: sourceName,
    };
  }

  const result: PdfMetadataOk = {
    status: "ok",
    source_file: sourceName,
    outputs: [toTaskRelative(metaPath, taskRoot)],
    summary: metadata,
  };
  if (degraded) {
    result.warning =
      "PDF 解析器无法打开该文件；元数据提取基于正则匹配，标题、作者、摘要等字段可能不完整。";
  }
  return result;
}
