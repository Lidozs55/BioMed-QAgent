/**
 * Delimited-text helpers for source adapters (Python ``csv`` + ``open_text``).
 *
 * ``readSourceText`` mirrors ``app.tools.io.open_text`` (transparent gzip
 * decompression, utf-8). ``delimitedRowsWithLines`` mirrors Python
 * ``csv.reader`` for the tab-delimited source tables the built-in adapters
 * consume; quoted fields are supported but multi-line quoted fields are not
 * (no current source emits them).
 */

import { createReadStream, readFileSync } from "node:fs";
import { open as openFile, readFile } from "node:fs/promises";
import { createGunzip, gunzip as gunzipCb, gunzipSync } from "node:zlib";
import { promisify } from "node:util";
import { StringDecoder } from "node:string_decoder";
import { throwIfAborted } from "../cooperative.js";

const gunzip = promisify(gunzipCb);

export interface DelimitedRow {
  line: number;
  values: string[];
  /** Raw line text without the line ending, when the consumer opted in via
   * ``includeLineText``.  Useful for formats with an auto-detected delimiter
   * (GEO supplementary matrices) where values splits on a fixed delimiter. */
  lineText?: string;
}

/**
 * Optional per-scan bounds enforced while streaming rows.  Default (all null)
 * preserves the previous unbounded behavior for source adapters; validation
 * scans enable these caps so a single pathological row cannot balloon memory
 * inside a multi-gigabyte primary.  A row exceeding a cap surfaces a
 * {@link DelimitedBoundsError} instead of being parsed whole.
 */
export interface DelimitedRowBounds {
  maxRowChars?: number | null;
  maxFieldChars?: number | null;
  maxRowFields?: number | null;
}

/** Raised when a row/field exceeds the caller's streaming row bounds. */
export class DelimitedBoundsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DelimitedBoundsError";
  }
}

async function hasGzipMagic(path: string): Promise<boolean> {
  const handle = await openFile(path, "r");
  try {
    const header = Buffer.alloc(2);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return bytesRead === 2 && header[0] === 0x1f && header[1] === 0x8b;
  } finally {
    await handle.close();
  }
}

/**
 * Stream a delimited source file without materializing its decompressed text
 * or all parsed rows.  This is the large-file path used by GEO adapters;
 * small-fixture callers can continue using the array helpers below.
 */
export async function* delimitedRowsFromFileAsync(
  path: string,
  delimiter: string,
  signal?: AbortSignal | null,
  options?: ({ includeLineText?: boolean } & DelimitedRowBounds) | null,
): AsyncGenerator<DelimitedRow> {
  throwIfAborted(signal);
  const includeLineText = options?.includeLineText === true;
  const maxRowChars = options?.maxRowChars ?? null;
  const maxFieldChars = options?.maxFieldChars ?? null;
  const maxRowFields = options?.maxRowFields ?? null;
  // Probe before constructing the stream. If opening the path fails (for
  // example ENOENT), creating the stream first would leave its asynchronous
  // error event unobserved while hasGzipMagic rejects.
  const gzip = await hasGzipMagic(path);
  const source = createReadStream(path);
  const input = gzip ? source.pipe(createGunzip()) : source;
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let line = 0;
  let completed = false;
  try {
    for await (const chunk of input) {
      throwIfAborted(signal);
      pending += decoder.write(chunk as Buffer);
      while (true) {
        let breakIndex = -1;
        let breakLength = 1;
        for (let index = 0; index < pending.length; index += 1) {
          const code = pending.charCodeAt(index);
          if (code === 10) {
            breakIndex = index;
            breakLength = 1;
            break;
          }
          if (code === 13) {
            if (index + 1 >= pending.length) break;
            breakIndex = index;
            breakLength = pending.charCodeAt(index + 1) === 10 ? 2 : 1;
            break;
          }
        }
        if (breakIndex < 0) break;
        const text = pending.slice(0, breakIndex);
        pending = pending.slice(breakIndex + breakLength);
        line += 1;
        const row: DelimitedRow = {
          line,
          values: parseDelimitedLineBounded(text, delimiter, maxFieldChars, maxRowFields, line, maxRowChars),
        };
        if (includeLineText) row.lineText = text;
        yield row;
        if (line % 8192 === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          throwIfAborted(signal);
        }
      }
      if (maxRowChars !== null) {
        const pendingRowChars = pending.endsWith("\r")
          ? pending.length - 1
          : pending.length;
        if (pendingRowChars > maxRowChars) {
          throw new DelimitedBoundsError(
            `row ${line + 1} exceeds ${maxRowChars} chars`,
          );
        }
      }
    }
    pending += decoder.end();
    if (pending.length > 0) {
      line += 1;
      const row: DelimitedRow = {
        line,
        values: parseDelimitedLineBounded(pending, delimiter, maxFieldChars, maxRowFields, line, maxRowChars),
      };
      if (includeLineText) row.lineText = pending;
      yield row;
    }
    completed = true;
  } finally {
    if (!completed) {
      source.destroy();
      if (input !== source) input.destroy();
    }
  }
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

/**
 * Quote-aware field split like {@link parseDelimitedLine}, but aborts with a
 * {@link DelimitedBoundsError} as soon as the row/field exceeds a length cap
 * so a pathological row is not held in memory.  Passing all-null caps falls
 * back to the exact unbounded behavior of parseDelimitedLine.
 */
function parseDelimitedLineBounded(
  line: string,
  delimiter: string,
  maxFieldChars: number | null,
  maxRowFields: number | null,
  lineNumber: number,
  maxRowChars: number | null,
): string[] {
  if (maxRowChars !== null && line.length > maxRowChars) {
    throw new DelimitedBoundsError(`row ${lineNumber} exceeds ${maxRowChars} chars`);
  }
  if (line.length === 0) return [];
  if (maxFieldChars === null && maxRowFields === null) {
    return parseDelimitedLine(line, delimiter);
  }
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
      if (maxRowFields !== null && fields.length > maxRowFields) {
        throw new DelimitedBoundsError(`row ${lineNumber} exceeds ${maxRowFields} fields`);
      }
    } else {
      field += ch;
    }
    if (maxFieldChars !== null && field.length > maxFieldChars) {
      throw new DelimitedBoundsError(`row ${lineNumber} has a field longer than ${maxFieldChars} chars`);
    }
  }
  fields.push(field);
  if (maxRowFields !== null && fields.length > maxRowFields) {
    throw new DelimitedBoundsError(`row ${lineNumber} exceeds ${maxRowFields} fields`);
  }
  if (maxFieldChars !== null && field.length > maxFieldChars) {
    throw new DelimitedBoundsError(`row ${lineNumber} has a field longer than ${maxFieldChars} chars`);
  }
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
