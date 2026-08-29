/**
 * 轻量 JSON 语法高亮 tokenizer。
 *
 * 输出带 className 的文本片段,由 JsonBlock 渲染为 span;颜色全部使用语义
 * token(见 docs/plans/tool-call-ui-custom-renderers.md §5.7),明暗主题自适应。
 * 超过 maxChars 的文本跳过高亮直接原样返回,避免长输出上的正则开销。
 */

export interface JsonSegment {
  text: string;
  className?: string;
}

export const JSON_TOKEN_CLASS = {
  key: "text-primary font-medium",
  string: "text-success",
  literal: "text-muted-foreground",
  number: "text-muted-foreground",
} as const;

const JSON_TOKEN_RE =
  /"(?:\\.|[^"\\])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

export function highlightJson(text: string, maxChars = 100_000): JsonSegment[] {
  if (text.length > maxChars) return [{ text }];
  const segments: JsonSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(JSON_TOKEN_RE)) {
    const index = match.index;
    if (index > last) segments.push({ text: text.slice(last, index) });
    const token = match[0];
    let className: string;
    if (token.startsWith('"')) {
      className =
        match[1] !== undefined ? JSON_TOKEN_CLASS.key : JSON_TOKEN_CLASS.string;
    } else if (token === "true" || token === "false" || token === "null") {
      className = JSON_TOKEN_CLASS.literal;
    } else {
      className = JSON_TOKEN_CLASS.number;
    }
    segments.push({ text: token, className });
    last = index + token.length;
  }
  if (last < text.length) segments.push({ text: text.slice(last) });
  return segments;
}
