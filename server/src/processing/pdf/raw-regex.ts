/**
 * Raw PDF stream regex fallback (P5-08 spike, tier B).
 *
 * Line-by-line port of Python ``extract_tables.py``'s regex fallback
 * (``_extract_text_via_regex`` + ``_decode_pdf_bytes`` + ``_detect_delimited_rows``
 * helpers) with the CJK-aware decoding heuristics. Used when pdfjs-dist
 * cannot open a PDF (malformed xref, hand-crafted blobs) — exactly the tier
 * Python uses when pdfplumber/PyPDF2 are absent.
 */

import { readFileSync } from "node:fs";
import zlib from "node:zlib";

const PDF_TEXT_RE = /BT\s*([\s\S]*?)\s*ET/g;
const PDF_STRING_PART = String.raw`(?:\(([^)]*(?:\\.[^)]*)*)\)|<([0-9a-fA-F\s]+)>)`;
const PDF_STRING_RE = new RegExp(PDF_STRING_PART, "g");
const PDF_TJ_CALL_RE = new RegExp(PDF_STRING_PART + String.raw`\s*Tj`, "g");
const PDF_ARRAY_RE = /\[([\s\S]*?)\]\s*TJ/g;
const PDF_STRIP_ESCAPES = /\\([()\\nrtbf])/g;
const PDF_STREAM_RE = /(?:<<[^>]*>>\s*)?stream\r?\n([\s\S]*?)\r?\nendstream/g;
const TABLE_SEP_RE = /\s{3,}|\t/;

/** Attempt to decompress FlateDecode streams in raw PDF bytes. */
function decompressPdfStreams(raw: Buffer): Buffer {
  let result = raw;
  for (const match of raw.toString("latin1").matchAll(PDF_STREAM_RE)) {
    // Match indices are byte-accurate for latin-1 (1 byte == 1 char).
    const blockStart = match.index ?? 0;
    const innerStart = match.index + match[0].indexOf(match[1]);
    const innerEnd = innerStart + match[1].length;
    const streamBlock = raw.subarray(blockStart, innerEnd + "\r\nendstream".length);
    if (!streamBlock.includes(Buffer.from("/Filter")) || !streamBlock.includes(Buffer.from("FlateDecode"))) {
      continue;
    }
    const inner = raw.subarray(innerStart, innerEnd);
    try {
      const decompressed = zlib.unzipSync(inner);
      result = Buffer.concat([result.subarray(0, innerStart), decompressed, result.subarray(innerEnd)]);
    } catch {
      // Not zlib-wrapped — keep the original bytes (Python: pass on zlib.error).
    }
  }
  return result;
}

/** Recover a UTF-8 literal (e.g. CJK) from latin-1-decoded PDF content. */
function recoverUtf8Literal(text: string): string {
  // eslint-disable-next-line no-control-regex -- ASCII byte-range guard
  const asciiOnly = /^[\x00-\x7f]*$/.test(text);
  if (asciiOnly) return text;
  const raw = Buffer.from(text, "latin1");
  const decoded = raw.toString("utf8");
  // Node replaces invalid sequences with U+FFFD instead of throwing;
  // mirror Python's "return original on UnicodeDecodeError".
  return decoded.includes("\ufffd") ? text : decoded;
}

/** Heuristic: >= half of the 16-bit pairs fall in CJK Unified Ideographs. */
function looksLikeUtf16beCjk(data: Buffer): boolean {
  if (data.length < 2 || data.length % 2 !== 0) return false;
  let cjk = 0;
  const pairs = data.length / 2;
  for (let i = 0; i < data.length; i += 2) {
    const cp = (data[i] << 8) | data[i + 1];
    if (cp >= 0x4e00 && cp <= 0x9fff) cjk += 1;
  }
  return cjk >= Math.floor(pairs / 2);
}

/** Decode raw bytes of a PDF hex string to text (Python heuristic order). */
function decodePdfBytes(data: Buffer): string {
  if (data.length === 0) return "";
  if ((data[0] === 0xfe && data[1] === 0xff) || (data[0] === 0xff && data[1] === 0xfe)) {
    return data.toString("utf16le").replace(/^\ufeff/, "");
  }
  let zeroes = 0;
  for (const byte of data) if (byte === 0) zeroes += 1;
  if (zeroes > 0 && zeroes >= Math.floor(data.length / 2)) {
    try {
      const swapped = Buffer.from(data).swap16();
      return swapped.toString("utf16le");
    } catch {
      // fall through
    }
  }
  const utf8 = data.toString("utf8");
  if (!utf8.includes("\ufffd")) return utf8;
  if (looksLikeUtf16beCjk(data)) {
    return Buffer.from(data).swap16().toString("utf16le");
  }
  return data.toString("latin1");
}

function decodeHexString(hexContent: string): string {
  const compact = hexContent.replace(/\s+/g, "");
  const padded = compact.length % 2 ? compact + "0" : compact;
  if (!/^[0-9a-fA-F]*$/.test(padded)) return "";
  return decodePdfBytes(Buffer.from(padded, "hex"));
}

function decodePdfString(literal: string | undefined, hexContent: string | undefined): string {
  if (literal !== undefined) {
    const text = literal.replace(PDF_STRIP_ESCAPES, "$1");
    return recoverUtf8Literal(text);
  }
  return decodeHexString(hexContent ?? "");
}

/** Extract plain text from a PDF using regex on raw content streams. */
export function extractTextViaRegex(filePath: string): string {
  const raw = decompressPdfStreams(readFileSync(filePath));
  const content = raw.toString("latin1");

  const lines: string[] = [];
  for (const blockMatch of content.matchAll(PDF_TEXT_RE)) {
    const block = blockMatch[1];

    for (const tj of block.matchAll(PDF_TJ_CALL_RE)) {
      const text = decodePdfString(tj[1], tj[2]).trim();
      if (text) lines.push(text);
    }

    for (const tjArr of block.matchAll(PDF_ARRAY_RE)) {
      const parts: string[] = [];
      for (const sm of tjArr[1].matchAll(PDF_STRING_RE)) {
        parts.push(decodePdfString(sm[1], sm[2]));
      }
      const line = parts.join("").trim();
      if (line) lines.push(line);
    }
  }
  return lines.join("\n");
}

/** Count ``/Type /Page`` objects (Python fallback page counter, min 1). */
export function countPagesViaRegex(filePath: string): number {
  const content = readFileSync(filePath).toString("latin1");
  const count = (content.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  return count === 0 ? 1 : count;
}

/**
 * Heuristic: detect rows that look tabular (Python ``_detect_delimited_rows``).
 */
export function detectDelimitedRows(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.split("\n")) {
    const stripped = line.trim();
    if (!stripped) continue;
    const cells = stripped.split(TABLE_SEP_RE);
    if (cells.length >= 2) {
      rows.push(cells.map((cell) => cell.trim()));
    }
  }
  if (rows.length === 0) return [];

  const colCounts = rows.map((row) => row.length);
  if (colCounts.length >= 3) {
    const mode = modeOf(colCounts);
    return rows.filter(
      (row) => row.length === mode || (mode - 1 <= row.length && row.length <= mode + 1),
    );
  }
  return rows;
}

function modeOf(values: readonly number[]): number {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best = values[0];
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/** Clean a column name (Python ``_clean_header``). */
export function cleanHeader(header: string): string {
  let value = header.trim();
  value = value.normalize("NFKC");
  value = value.replace(/[\n\r\t]+/g, " ");
  value = value.replace(/\s{2,}/g, " ");
  // eslint-disable-next-line no-control-regex
  value = value.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
  if (value.length > 100) value = value.slice(0, 100);
  if (!value) value = "column";
  return value;
}
