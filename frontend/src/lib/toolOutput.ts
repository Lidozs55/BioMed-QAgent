/**
 * workspace / Pi 工具输出的统一解包。
 *
 * 服务端工具结果以 JSON 信封进入事件流:
 * `{content:[{type:"text",text:JSON.stringify(details)}], details}`。
 * 专用渲染器需要的是 details 里的实际内容(文件文本 / stdout / 错误消息),
 * 而不是原始 JSON。非 JSON 或不认识的形状原样返回,行为与旧版一致。
 */
export interface UnwrappedToolOutput {
  /** 面向用户的文本(文件内容 / stdout+stderr / 错误消息 / 摘要 / pretty JSON)。 */
  text: string;
  /** 原始 details 对象(渲染器可读取 characters / exitCode 等元信息)。 */
  details: Record<string, unknown> | null;
}

function asDetails(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function unwrapToolOutput(
  output: string | null | undefined,
): UnwrappedToolOutput | null {
  if (!output) return null;
  let envelope: unknown;
  try {
    envelope = JSON.parse(output);
  } catch {
    return { text: output, details: null };
  }
  const envelopeObj = asDetails(envelope);
  if (envelopeObj === null) return { text: output, details: null };

  // 空 details(schema 校验失败等)视同缺失,回退到 content[0].text 的
  // 人类可读消息。
  const rawDetails = asDetails(envelopeObj.details);
  let details =
    rawDetails !== null && Object.keys(rawDetails).length > 0 ? rawDetails : null;
  let contentText: string | null = null;
  if (details === null && Array.isArray(envelopeObj.content)) {
    const first: unknown = envelopeObj.content[0];
    const inner =
      asDetails(first) !== null && typeof (first as { text?: unknown }).text === "string"
        ? (first as { text: string }).text
        : null;
    if (inner !== null) {
      try {
        details = asDetails(JSON.parse(inner));
      } catch {
        details = null;
      }
      if (details === null) contentText = inner;
    }
  }
  if (details === null) {
    return {
      text: contentText ?? output,
      details: null,
    };
  }
  return { text: renderDetails(details), details };
}

function renderDetails(details: Record<string, unknown>): string {
  // 错误详情(WorkspacePolicyError / PermissionDeniedError)
  if (typeof details.message === "string") {
    return typeof details.code === "string"
      ? `${details.code}: ${details.message}`
      : details.message;
  }
  // exec:stdout + stderr(+ 非零退出码)
  if (typeof details.stdout === "string" || typeof details.stderr === "string") {
    const parts: string[] = [];
    const stdout = typeof details.stdout === "string" ? details.stdout : "";
    const stderr = typeof details.stderr === "string" ? details.stderr : "";
    if (stdout.trim().length > 0) parts.push(stdout.replace(/\n$/, ""));
    if (stderr.trim().length > 0) parts.push(stderr.replace(/\n$/, ""));
    if (typeof details.exitCode === "number" && details.exitCode !== 0) {
      parts.push(`[exit ${details.exitCode}]`);
    }
    return parts.length > 0 ? parts.join("\n") : "(无输出)";
  }
  // read:文件文本
  if (typeof details.text === "string") return details.text;
  // write / edit 摘要
  if (typeof details.path === "string" && typeof details.bytes === "number") {
    const action = details.created === true ? "已创建" : "已写入";
    const replacements =
      typeof details.replacements === "number"
        ? `,替换 ${details.replacements} 处`
        : "";
    return `${details.path} ${action} (${details.bytes} bytes${replacements})`;
  }
  return JSON.stringify(details, null, 2);
}
