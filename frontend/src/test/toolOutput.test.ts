import { describe, expect, it } from "vitest";

import { unwrapToolOutput } from "@/lib/toolOutput";

function envelope(details: unknown): string {
  return JSON.stringify({
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
  });
}

describe("unwrapToolOutput", () => {
  it("returns null for empty output", () => {
    expect(unwrapToolOutput(null)).toBeNull();
    expect(unwrapToolOutput("")).toBeNull();
  });

  it("passes raw non-JSON text through", () => {
    expect(unwrapToolOutput("plain stdout")?.text).toBe("plain stdout");
    expect(unwrapToolOutput("plain stdout")?.details).toBeNull();
  });

  it("unwraps workspace_read details.text", () => {
    const result = unwrapToolOutput(
      envelope({ path: "hello.py", text: 'print("hi")\n', offset: 0, characters: 12, truncated: false }),
    );
    expect(result?.text).toBe('print("hi")\n');
    expect(result?.details?.characters).toBe(12);
  });

  it("renders exec stdout and stderr with non-zero exit code", () => {
    const result = unwrapToolOutput(
      envelope({ command: ["python", "x.py"], exitCode: 1, stdout: "out\n", stderr: "err\n" }),
    );
    expect(result?.text).toBe("out\nerr\n[exit 1]");
  });

  it("renders exec with no output as a placeholder", () => {
    const result = unwrapToolOutput(envelope({ exitCode: 0, stdout: "", stderr: "" }));
    expect(result?.text).toBe("(无输出)");
  });

  it("renders error details as code + message", () => {
    const result = unwrapToolOutput(
      envelope({ code: "PRECONDITION_FAILED", message: "expectedOccurrences must be provided" }),
    );
    expect(result?.text).toBe("PRECONDITION_FAILED: expectedOccurrences must be provided");
  });

  it("renders write/edit summaries", () => {
    expect(
      unwrapToolOutput(envelope({ path: "a.py", bytes: 23, created: true }))?.text,
    ).toBe("a.py 已创建 (23 bytes)");
    expect(
      unwrapToolOutput(envelope({ path: "a.py", bytes: 25, replacements: 1 }))?.text,
    ).toBe("a.py 已写入 (25 bytes,替换 1 处)");
  });

  it("falls back to content[0].text when details is missing", () => {
    const output = JSON.stringify({
      content: [{ type: "text", text: "inner message" }],
    });
    expect(unwrapToolOutput(output)?.text).toBe("inner message");
  });

  it("pretty-prints unknown detail shapes", () => {
    const result = unwrapToolOutput(envelope({ custom: 1 }));
    expect(result?.text).toContain('"custom": 1');
  });
});
