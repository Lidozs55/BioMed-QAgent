import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

describe("dataset adapter production module graph", () => {
  test("keeps the GEO registry free of a top-level-await import cycle", () => {
    const registrySource = readFileSync(
      new URL("../src/dataset/adapters/adapters.ts", import.meta.url),
      "utf8",
    );
    const geoSource = readFileSync(
      new URL("../src/dataset/adapters/geo/series-matrix.ts", import.meta.url),
      "utf8",
    );

    expect(registrySource).toContain(
      'import { geoExpressionAdapter } from "./geo/index.js";',
    );
    expect(registrySource).not.toContain('await import("./geo/index.js")');
    expect(geoSource).toContain('from "../base.js";');
    expect(geoSource).not.toContain('from "../adapters.js";');
  });
});
