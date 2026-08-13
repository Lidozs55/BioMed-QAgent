/**
 * Minimal CSV reader mirroring the pandas read_csv behavior the Python
 * analysis tools rely on (P5-09 analysis).
 *
 * Mirrors pandas defaults that matter for the analysis fixtures:
 *   - RFC-4180 quoting (double-quote escaping, quoted commas/newlines);
 *   - blank lines skipped;
 *   - the pandas default NA value set (``''``, ``NaN``, ``nan``, ``NA``,
 *     ``N/A``, ``n/a``, ``NULL``, ``null``, ``None``, ``<NA>``, ...) treated
 *     as missing, matched case-sensitively exactly like the pandas C parser;
 *   - per-column dtype inference: a column is numeric (float64/int64) iff
 *     every non-missing cell parses as a decimal number (scientific notation
 *     included); anything else is an object/string column (pandas would not
 *     infer numeric for mixed content either);
 *   - missing values become NaN in numeric columns.
 */

export interface ParsedTable {
  /** Column names from the header row (verbatim). */
  headers: string[];
  /** Raw cell text per row (unquoted, untrimmed). */
  rows: string[][];
  /** True when pandas would infer a numeric dtype for the column. */
  numericColumns: boolean[];
  /**
   * Parsed cell values: numbers for numeric cells, NaN for missing and for
   * non-numeric content (pd.to_numeric(errors="coerce") semantics).
   */
  values: number[][];
}

/**
 * pandas default NA strings (case-sensitive exact match, pandas 3.x
 * ``pandas._libs.parsers.STR_NA_VALUES``).
 */
const NA_VALUES: ReadonlySet<string> = new Set([
  "", "#N/A", "#N/A N/A", "#NA", "-1.#IND", "-1.#QNAN", "-NaN", "-nan",
  "1.#IND", "1.#QNAN", "<NA>", "N/A", "NA", "NULL", "NaN", "None", "n/a",
  "nan", "null",
]);

const NUMERIC_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/** Split CSV text into lines of raw fields (quotes resolved, blank lines dropped). */
function splitFields(text: string): string[][] {
  const lines: string[][] = [];
  let fields: string[] = [];
  let field = "";
  let inQuotes = false;
  let sawAny = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      sawAny = true;
      continue;
    }
    if (ch === ",") {
      fields.push(field);
      field = "";
      sawAny = true;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      fields.push(field);
      field = "";
      if (sawAny && !fields.every((f) => f.trim() === "")) {
        lines.push(fields);
      }
      fields = [];
      sawAny = false;
      continue;
    }
    field += ch;
    sawAny = true;
  }
  if (sawAny || field !== "") {
    fields.push(field);
    if (!fields.every((f) => f.trim() === "")) lines.push(fields);
  }
  return lines;
}

/**
 * Parse CSV text (pandas read_csv parity for the analysis fixtures).
 *
 * Throws Error("CSV has no rows: <path>") / Error("CSV has no columns: ...")
 * style failures are NOT raised here — the caller decides on messages using
 * the ``sourcePath`` label, mirroring the Python tool's validation order
 * (empty file check happens before parsing).
 */
export function parseCsv(text: string): ParsedTable {
  const lines = splitFields(text);
  if (lines.length === 0) {
    return { headers: [], rows: [], numericColumns: [], values: [] };
  }
  const headers = lines[0];
  const rows = lines.slice(1);
  const columnCount = headers.length;
  const numericColumns: boolean[] = new Array(columnCount).fill(true);
  // Determine which columns pandas would type as numeric.
  for (const row of rows) {
    for (let c = 0; c < columnCount; c += 1) {
      const cell = c < row.length ? row[c] : "";
      if (NA_VALUES.has(cell)) continue;
      if (!NUMERIC_RE.test(cell.trim())) {
        numericColumns[c] = false;
      }
    }
  }
  const values: number[][] = rows.map((row) =>
    Array.from({ length: columnCount }, (_, c) => {
      const cell = c < row.length ? row[c] : "";
      if (NA_VALUES.has(cell)) return Number.NaN;
      const trimmed = cell.trim();
      if (NUMERIC_RE.test(trimmed)) return Number(trimmed);
      return Number.NaN;
    }),
  );
  return { headers, rows, numericColumns, values };
}

/** Column index by name, or -1 (duplicates resolved like df[col] would). */
export function columnIndex(headers: readonly string[], name: string): number {
  return headers.indexOf(name);
}
