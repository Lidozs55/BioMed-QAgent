/**
 * Delimited-text helpers for source adapters (Python ``csv`` + ``open_text``).
 *
 * ``readSourceText`` mirrors ``app.tools.io.open_text`` (transparent gzip
 * decompression, utf-8). ``delimitedRowsWithLines`` mirrors Python
 * ``csv.reader`` for the tab-delimited source tables the built-in adapters
 * consume; quoted fields are supported but multi-line quoted fields are not
 * (no current source emits them).
 */

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { promisify } from "node:util";
import { gunzip as gunzipCb } from "node:zlib";
import { throwIfAborted } from "../cooperative.js";

const gunzip = promisify(gunzipCb);

export interface DelimitedRow {
  line: number;
  values: string[];
}

/** Python ``open_text``: transparent gzip decompression, utf-8 decode. */
export function readSourceText(path: string): string {
  const buffer = readFileSync(path);
  const isGzip = buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
  const bytes = isGzip ? gunzipSync(buffer) : buffer;
  return bytes.toString("utf8");
}

/**
 * Cooperative ``open_text`` for the async Core path: reads through the
 * libuv thread pool (``fs/promises`` + ``zlib/promises``) so the event loop
 * stays responsive, and re-checks the operation AbortSignal at each await.
 */
export async function readSourceTextAsync(
  path: string,
  signal?: AbortSignal | null,
): Promise<string> {
  throwIfAborted(signal);
  const buffer = await readFile(path);
  throwIfAborted(signal);
  const isGzip = buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
  const bytes = isGzip ? await gunzip(buffer) : buffer;
  throwIfAborted(signal);
  return bytes.toString("utf8");
}

/** Python csv.reader-compatible quote-aware field split for one line. */
export function parseDelimitedLine(line: string, delimiter: string): string[] {
  if (line.length === 0) return [];
  const fields: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index];
    if (inQuotes) {
      if (ch === '"') {
        if (line[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      fields.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return fields;
}

/** All rows of a delimited text with 1-based line numbers (Python csv.reader). */
export function delimitedRowsWithLines(
  text: string,
  delimiter: string,
): DelimitedRow[] {
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.map((lineText, index) => ({
    line: index + 1,
    values: parseDelimitedLine(lineText, delimiter),
  }));
}

/**
 * Cooperative line splitter for the async Core path: byte-identical to
 * ``delimitedRowsWithLines`` (same \r\n / \n / \r handling, same trailing
 * empty-line drop), but yields to the event loop every N lines so pending
 * operation-timeout timers can fire and the AbortSignal is honored mid-file.
 */
export async function delimitedRowsWithLinesAsync(
  text: string,
  delimiter: string,
  signal?: AbortSignal | null,
): Promise<DelimitedRow[]> {
  const rows: DelimitedRow[] = [];
  let offset = 0;
  let lineNumber = 0;
  const length = text.length;
  while (offset < length) {
    const nl = text.indexOf("\n", offset);
    const cr = text.indexOf("\r", offset);
    let end: number;
    let nextStart: number;
    if (cr !== -1 && (nl === -1 || cr < nl)) {
      // \r line break (consuming a following \n as CRLF)
      end = cr;
      nextStart = text[cr + 1] === "\n" ? cr + 2 : cr + 1;
    } else if (nl !== -1) {
      end = nl;
      nextStart = nl + 1;
    } else {
      end = length;
      nextStart = length;
    }
    lineNumber += 1;
    rows.push({ line: lineNumber, values: parseDelimitedLine(text.slice(offset, end), delimiter) });
    offset = nextStart;
    if (lineNumber % 8192 === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      throwIfAborted(signal);
    }
  }
  return rows;
}

/** Python csv QUOTE_MINIMAL single-field serialization. */
export function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** One CSV record line with Python csv writer line endings. */
export function csvLine(values: readonly string[]): string {
  return `${values.map((value) => csvField(value)).join(",")}\r\n`;
}