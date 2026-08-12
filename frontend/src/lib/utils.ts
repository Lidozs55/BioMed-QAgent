import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function errorMessage(error: unknown, fallback = "未知错误"): string {
  return error instanceof Error ? error.message : fallback
}

/**
 * 方向调整的前缀只喂给模型（与后端 `_STEER_FRAMING` 保持一致），
 * 不显示在对话气泡/历史里。若后端措辞修改，请同步更新此常量；
 * 不匹配时前缀会原样显示（fail-safe，不会丢内容）。
 */
export const STEER_FRAMING_PREFIX =
  "【方向调整】用户中断了上一次作答并调整了方向或做了补充。" +
  "请不要忘记上一次的任务内容，按照用户的内容继续作答或终止作答，" +
  "具体依照用户语义完成：\n"

export function stripSteerFraming(content: string): string {
  return content.startsWith(STEER_FRAMING_PREFIX)
    ? content.slice(STEER_FRAMING_PREFIX.length)
    : content
}
