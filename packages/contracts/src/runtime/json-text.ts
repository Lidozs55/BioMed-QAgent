import { APIError } from "./errors.js";

export interface StrictJsonTextOptions {
  maxChars?: number;
  maxDepth?: number;
  maxNodes?: number;
}

const DEFAULT_MAX_CHARS = 1_048_576;
const DEFAULT_MAX_DEPTH = 128;
const DEFAULT_MAX_NODES = 100_000;
const NUMBER_TOKEN = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

class StrictJsonTextReader {
  private index = 0;
  private nodes = 0;

  constructor(
    private readonly text: string,
    private readonly maxDepth: number,
    private readonly maxNodes: number,
  ) {}

  parse(): unknown {
    this.skipWhitespace();
    this.parseValue(0);
    this.skipWhitespace();
    if (this.index !== this.text.length) this.fail("unexpected trailing content");
    return JSON.parse(this.text) as unknown;
  }

  private fail(message: string): never {
    throw new APIError(400, `Invalid JSON at character ${this.index}: ${message}`);
  }

  private countNode(depth: number): void {
    if (depth > this.maxDepth) this.fail(`nesting exceeds ${this.maxDepth}`);
    this.nodes += 1;
    if (this.nodes > this.maxNodes) this.fail(`node count exceeds ${this.maxNodes}`);
  }

  private skipWhitespace(): void {
    while (/\s/u.test(this.text[this.index] ?? "") && /[\t\n\r ]/u.test(this.text[this.index] ?? "")) {
      this.index += 1;
    }
  }

  private parseValue(depth: number): void {
    this.countNode(depth);
    const char = this.text[this.index];
    if (char === "{") {
      this.parseObject(depth);
      return;
    }
    if (char === "[") {
      this.parseArray(depth);
      return;
    }
    if (char === '"') {
      this.parseString();
      return;
    }
    if (char === "t") {
      this.consumeLiteral("true");
      return;
    }
    if (char === "f") {
      this.consumeLiteral("false");
      return;
    }
    if (char === "n") {
      this.consumeLiteral("null");
      return;
    }
    this.parseNumber();
  }

  private parseObject(depth: number): void {
    this.index += 1;
    this.skipWhitespace();
    if (this.text[this.index] === "}") {
      this.index += 1;
      return;
    }
    const keys = new Set<string>();
    while (true) {
      if (this.text[this.index] !== '"') this.fail("object key must be a string");
      const key = this.parseString();
      if (keys.has(key)) this.fail(`duplicate object key ${JSON.stringify(key)}`);
      keys.add(key);
      this.skipWhitespace();
      if (this.text[this.index] !== ":") this.fail("expected ':' after object key");
      this.index += 1;
      this.skipWhitespace();
      this.parseValue(depth + 1);
      this.skipWhitespace();
      const separator = this.text[this.index];
      if (separator === "}") {
        this.index += 1;
        return;
      }
      if (separator !== ",") this.fail("expected ',' or '}' in object");
      this.index += 1;
      this.skipWhitespace();
    }
  }

  private parseArray(depth: number): void {
    this.index += 1;
    this.skipWhitespace();
    if (this.text[this.index] === "]") {
      this.index += 1;
      return;
    }
    while (true) {
      this.parseValue(depth + 1);
      this.skipWhitespace();
      const separator = this.text[this.index];
      if (separator === "]") {
        this.index += 1;
        return;
      }
      if (separator !== ",") this.fail("expected ',' or ']' in array");
      this.index += 1;
      this.skipWhitespace();
    }
  }

  private parseString(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.text.length) {
      const char = this.text[this.index]!;
      const code = char.charCodeAt(0);
      if (char === '"') {
        this.index += 1;
        return JSON.parse(this.text.slice(start, this.index)) as string;
      }
      if (code <= 0x1f) this.fail("unescaped control character in string");
      if (char !== "\\") {
        this.index += 1;
        continue;
      }
      this.index += 1;
      const escape = this.text[this.index];
      if (escape === undefined || !'"\\/bfnrtu'.includes(escape)) {
        this.fail("invalid string escape");
      }
      if (escape === "u") {
        const hex = this.text.slice(this.index + 1, this.index + 5);
        if (!/^[0-9A-Fa-f]{4}$/u.test(hex)) this.fail("invalid Unicode escape");
        this.index += 5;
      } else {
        this.index += 1;
      }
    }
    this.fail("unterminated string");
  }

  private consumeLiteral(literal: "true" | "false" | "null"): void {
    if (!this.text.startsWith(literal, this.index)) this.fail(`expected ${literal}`);
    this.index += literal.length;
  }

  private parseNumber(): void {
    NUMBER_TOKEN.lastIndex = this.index;
    const match = NUMBER_TOKEN.exec(this.text);
    if (match === null) this.fail("expected a JSON value");
    const token = match[0];
    const value = Number(token);
    if (!Number.isFinite(value)) this.fail("number is outside the finite range");
    this.index += token.length;
  }
}

/**
 * Parse untrusted JSON text while rejecting duplicate decoded object keys.
 * Object parsers cannot recover this fact after ordinary JSON.parse has run.
 */
export function parseJsonTextStrict(
  text: string,
  options: StrictJsonTextOptions = {},
): unknown {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  if (!Number.isSafeInteger(maxChars) || maxChars < 0) {
    throw new TypeError("maxChars must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) {
    throw new TypeError("maxDepth must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 1) {
    throw new TypeError("maxNodes must be a positive safe integer");
  }
  if (text.length > maxChars) {
    throw new APIError(413, `JSON text exceeds ${maxChars} characters`);
  }
  if (text.trim() === "") throw new APIError(400, "Invalid JSON: empty input");
  return new StrictJsonTextReader(text, maxDepth, maxNodes).parse();
}
