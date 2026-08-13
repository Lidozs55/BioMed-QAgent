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
import { gunzipSync } from "node:zlib";

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