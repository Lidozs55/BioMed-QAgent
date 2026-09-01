import { describe, expect, it } from "vitest";

import { resolvePdfObject } from "../src/processing/pdf/pdfjs.js";

describe("pdfjs image object resolution", () => {
  it("waits for an unresolved page object through the callback API", async () => {
    let callbackUsed = false;
    const objects = {
      get(_name: string, callback?: (value: unknown) => void): unknown {
        if (callback === undefined) throw new Error("Requesting object that isn't resolved yet");
        callbackUsed = true;
        queueMicrotask(() => callback({ width: 1, height: 1, kind: 3, data: new Uint8Array(4) }));
        return null;
      },
    };

    await expect(resolvePdfObject(objects, "img_p1_1")).resolves.toMatchObject({ width: 1, height: 1 });
    expect(callbackUsed).toBe(true);
  });
});
