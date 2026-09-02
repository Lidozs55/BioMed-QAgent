import { describe, expect, it } from "vitest";

import {
  MAX_IMPORT_FILES,
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_TOTAL_BYTES,
} from "../src/index.js";

describe("fixed import-upload safety contract", () => {
  it("keeps the frontend and Application Host protocol fences aligned", () => {
    expect(MAX_IMPORT_FILES).toBe(10);
    expect(MAX_IMPORT_FILE_BYTES).toBe(500 * 1024 * 1024);
    expect(MAX_IMPORT_TOTAL_BYTES).toBe(2 * 1024 * 1024 * 1024);
  });
});
