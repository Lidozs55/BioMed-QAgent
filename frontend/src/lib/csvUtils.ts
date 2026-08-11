import Papa from "papaparse";

/** Parse a CSV text into trimmed headers/rows with a 100-row preview cap. */
export function parseCSV(text: string): {
  headers: string[];
  rows: string[][];
  truncated: boolean;
} {
  if (text.trim() === "") {
    return { headers: [], rows: [], truncated: false };
  }
  const parsed = Papa.parse<string[]>(text, {
    preview: 101,
    skipEmptyLines: "greedy",
  });
  if (parsed.errors.length > 0) throw new Error(parsed.errors[0].message);
  const [headers = [], ...rows] = parsed.data;
  return {
    headers: headers.map((header) => header.trim()),
    rows: rows.map((row) => row.map((cell) => cell.trim())),
    truncated: parsed.meta.truncated,
  };
}
