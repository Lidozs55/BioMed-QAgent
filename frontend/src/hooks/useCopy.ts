import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 剪贴板复制 + 短暂成功反馈。
 *
 * clipboard API 不可用或写入被拒(权限/非安全上下文)时保持图标不变,
 * 属刻意的静默降级——复制按钮没有可展示的错误位。
 */
export function useCopy(resetMs = 1500): {
  copied: boolean;
  copy: (text: string) => void;
} {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const copy = useCallback(
    (text: string) => {
      if (!navigator.clipboard?.writeText) return;
      navigator.clipboard
        .writeText(text)
        .then(() => {
          setCopied(true);
          if (timerRef.current !== null) window.clearTimeout(timerRef.current);
          timerRef.current = window.setTimeout(() => setCopied(false), resetMs);
        })
        .catch(() => {});
    },
    [resetMs],
  );

  return { copied, copy };
}
