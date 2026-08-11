import { create } from "zustand";

import { useThemeStore } from "@/stores/themeStore";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type SendShortcut = "enter" | "ctrl-enter";
export type ReducedMotion = "system" | "on" | "off";

export interface ThemeColorOverrides {
  /** Empty string means "use the theme default". */
  background: string;
  foreground: string;
}

export interface Preferences {
  /** 编辑器：是否在输入框工具栏显示上下文窗口使用情况。 */
  showContextUsage: boolean;
  /** 编辑器：Enter 直接发送，还是 Ctrl/⌘+Enter 发送。 */
  sendShortcut: SendShortcut;
  /** 外观：半透明侧边栏。 */
  translucentSidebar: boolean;
  /** 外观：文字对比度（0-100，50 = 默认）。 */
  contrast: number;
  /** 偏好：交互元素显示指针光标。 */
  pointerCursor: boolean;
  /** 偏好：减少动态效果。 */
  reducedMotion: ReducedMotion;
  /** 偏好：UI 基准字号（px，12-18）。 */
  uiFontSize: number;
  /** 外观：浅色主题自定义背景/前景色（空 = 主题默认）。 */
  lightColors: ThemeColorOverrides;
  /** 外观：深色主题自定义背景/前景色（空 = 主题默认）。 */
  darkColors: ThemeColorOverrides;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

export const SEND_SHORTCUT_OPTIONS: { value: SendShortcut; label: string; hint: string }[] = [
  { value: "enter", label: "Enter 发送", hint: "Enter 发送，Shift+Enter 换行" },
  { value: "ctrl-enter", label: "Ctrl+Enter 发送", hint: "Enter 换行，Ctrl+Enter 发送" },
];

export const REDUCED_MOTION_OPTIONS: { value: ReducedMotion; label: string; hint: string }[] = [
  { value: "system", label: "系统", hint: "跟随系统设置" },
  { value: "on", label: "开启", hint: "停用动画与过渡" },
  { value: "off", label: "关闭", hint: "保持动画，忽略系统减弱设置" },
];

export const UI_FONT_SIZE_MIN = 12;
export const UI_FONT_SIZE_MAX = 18;
// 当前应用基准字号为浏览器默认 16px；默认值保持现状，只有用户调整才生效。
export const DEFAULT_UI_FONT_SIZE = 16;
export const CONTRAST_DEFAULT = 50;

const STORAGE_KEY = "biomed.preferences";
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

/* ------------------------------------------------------------------ */
/*  DOM application                                                    */
/* ------------------------------------------------------------------ */

const MANAGED_COLOR_VARS = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--border",
  "--input",
  "--sidebar",
  "--sidebar-foreground",
  "--sidebar-accent",
  "--sidebar-accent-foreground",
  "--sidebar-border",
] as const;

function readComputedVar(root: HTMLElement, name: string): string {
  return getComputedStyle(root).getPropertyValue(name).trim();
}

function mix(foreground: string, percent: number, background: string): string {
  return `color-mix(in srgb, ${foreground} ${percent}%, ${background})`;
}

function removeManagedColorVars(root: HTMLElement): void {
  for (const name of MANAGED_COLOR_VARS) root.style.removeProperty(name);
}

function applyColors(root: HTMLElement, prefs: Preferences): void {
  removeManagedColorVars(root);

  const dark = useThemeStore.getState().resolved === "dark";
  const overrides = dark ? prefs.darkColors : prefs.lightColors;
  const bg = overrides.background.trim().toLowerCase();
  const fg = overrides.foreground.trim().toLowerCase();
  const custom = HEX_COLOR.test(bg) && HEX_COLOR.test(fg);
  const baseBg = custom ? bg : readComputedVar(root, "--background");
  const baseFg = custom ? fg : readComputedVar(root, "--foreground");

  // 对比度 50 = 主题默认；此时不改写 muted/border，保持原始设计。
  const customContrast = prefs.contrast !== CONTRAST_DEFAULT;
  const contrastPct = Math.round(45 + prefs.contrast * 0.55);

  if (custom) {
    const muted = mix(baseFg, 8, baseBg);
    root.style.setProperty("--background", bg);
    root.style.setProperty("--foreground", fg);
    root.style.setProperty("--card", bg);
    root.style.setProperty("--card-foreground", fg);
    root.style.setProperty("--popover", bg);
    root.style.setProperty("--popover-foreground", fg);
    root.style.setProperty("--secondary", muted);
    root.style.setProperty("--secondary-foreground", fg);
    root.style.setProperty("--muted", muted);
    root.style.setProperty("--accent", muted);
    root.style.setProperty("--accent-foreground", fg);
    root.style.setProperty("--sidebar-foreground", fg);
    root.style.setProperty("--sidebar-accent", muted);
    root.style.setProperty("--sidebar-accent-foreground", fg);
  }

  if (custom || customContrast) {
    root.style.setProperty("--muted-foreground", mix(baseFg, contrastPct, baseBg));
    root.style.setProperty("--border", mix(baseFg, 15, baseBg));
    root.style.setProperty("--input", mix(baseFg, 15, baseBg));
    if (custom) {
      root.style.setProperty("--sidebar", bg);
      root.style.setProperty("--sidebar-border", mix(baseFg, 15, baseBg));
    }
  }

  if (prefs.translucentSidebar) {
    const sidebarBase = custom ? bg : readComputedVar(root, "--sidebar") || baseBg;
    root.style.setProperty("--sidebar", mix(sidebarBase, 70, "transparent"));
  }
}

export function applyPreferencesToDocument(prefs: Preferences): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;

  root.style.fontSize = `${prefs.uiFontSize}px`;
  root.style.setProperty("--ui-contrast", String(prefs.contrast));
  root.dataset.pointerCursor = prefs.pointerCursor ? "on" : "off";
  root.dataset.reducedMotion = prefs.reducedMotion;
  root.dataset.translucentSidebar = prefs.translucentSidebar ? "on" : "off";

  applyColors(root, prefs);

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage unavailable; preferences still apply for this session.
  }
}

/* ------------------------------------------------------------------ */
/*  Persistence helpers                                                */
/* ------------------------------------------------------------------ */

const DEFAULT_PREFS: Preferences = {
  showContextUsage: true,
  sendShortcut: "enter",
  translucentSidebar: false,
  contrast: CONTRAST_DEFAULT,
  pointerCursor: true,
  reducedMotion: "system",
  uiFontSize: DEFAULT_UI_FONT_SIZE,
  lightColors: { background: "", foreground: "" },
  darkColors: { background: "", foreground: "" },
};

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function parseColorOverrides(value: unknown): ThemeColorOverrides {
  const result: ThemeColorOverrides = { background: "", foreground: "" };
  if (value === null || typeof value !== "object") return result;
  for (const key of ["background", "foreground"] as const) {
    const raw = Reflect.get(value, key);
    if (typeof raw === "string" && HEX_COLOR.test(raw.trim())) {
      result[key] = raw.trim().toLowerCase();
    }
  }
  return result;
}

function readPrefs(): Preferences {
  if (typeof window === "undefined") return DEFAULT_PREFS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<Preferences>;
    return {
      showContextUsage:
        typeof parsed.showContextUsage === "boolean"
          ? parsed.showContextUsage
          : DEFAULT_PREFS.showContextUsage,
      sendShortcut:
        parsed.sendShortcut === "ctrl-enter" ? "ctrl-enter" : DEFAULT_PREFS.sendShortcut,
      translucentSidebar:
        typeof parsed.translucentSidebar === "boolean"
          ? parsed.translucentSidebar
          : DEFAULT_PREFS.translucentSidebar,
      contrast:
        typeof parsed.contrast === "number"
          ? clampInt(parsed.contrast, 0, 100)
          : DEFAULT_PREFS.contrast,
      pointerCursor:
        typeof parsed.pointerCursor === "boolean"
          ? parsed.pointerCursor
          : DEFAULT_PREFS.pointerCursor,
      reducedMotion:
        parsed.reducedMotion === "on" || parsed.reducedMotion === "off"
          ? parsed.reducedMotion
          : DEFAULT_PREFS.reducedMotion,
      uiFontSize:
        typeof parsed.uiFontSize === "number"
          ? clampInt(parsed.uiFontSize, UI_FONT_SIZE_MIN, UI_FONT_SIZE_MAX)
          : DEFAULT_PREFS.uiFontSize,
      lightColors: parseColorOverrides(parsed.lightColors),
      darkColors: parseColorOverrides(parsed.darkColors),
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

/* ------------------------------------------------------------------ */
/*  Store                                                              */
/* ------------------------------------------------------------------ */

export function isSubmitKey(
  event: {
    key: string;
    shiftKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    nativeEvent?: { isComposing?: boolean };
  },
  shortcut: SendShortcut,
): boolean {
  if (event.key !== "Enter") return false;
  if (event.nativeEvent?.isComposing) return false;
  return shortcut === "enter" ? !event.shiftKey : event.ctrlKey || event.metaKey;
}

interface PreferencesState extends Preferences {
  setShowContextUsage: (value: boolean) => void;
  setSendShortcut: (value: SendShortcut) => void;
  setTranslucentSidebar: (value: boolean) => void;
  setContrast: (value: number) => void;
  setPointerCursor: (value: boolean) => void;
  setReducedMotion: (value: ReducedMotion) => void;
  setUiFontSize: (value: number) => void;
  setLightColors: (colors: Partial<ThemeColorOverrides>) => void;
  setDarkColors: (colors: Partial<ThemeColorOverrides>) => void;
}

const initialPrefs = readPrefs();
applyPreferencesToDocument(initialPrefs);

export const usePreferencesStore = create<PreferencesState>((set, get) => ({
  ...initialPrefs,

  setShowContextUsage: (value) => {
    set({ showContextUsage: value });
    applyPreferencesToDocument(get());
  },

  setSendShortcut: (value) => {
    set({ sendShortcut: value });
    applyPreferencesToDocument(get());
  },

  setTranslucentSidebar: (value) => {
    set({ translucentSidebar: value });
    applyPreferencesToDocument(get());
  },

  setContrast: (value) => {
    set({ contrast: clampInt(value, 0, 100) });
    applyPreferencesToDocument(get());
  },

  setPointerCursor: (value) => {
    set({ pointerCursor: value });
    applyPreferencesToDocument(get());
  },

  setReducedMotion: (value) => {
    set({ reducedMotion: value });
    applyPreferencesToDocument(get());
  },

  setUiFontSize: (value) => {
    set({ uiFontSize: clampInt(value, UI_FONT_SIZE_MIN, UI_FONT_SIZE_MAX) });
    applyPreferencesToDocument(get());
  },

  setLightColors: (colors) => {
    set({ lightColors: { ...get().lightColors, ...colors } });
    applyPreferencesToDocument(get());
  },

  setDarkColors: (colors) => {
    set({ darkColors: { ...get().darkColors, ...colors } });
    applyPreferencesToDocument(get());
  },
}));

// 主题切换后重放自定义颜色/对比度覆盖（CSS 类只控制默认值）。
useThemeStore.subscribe((state, previous) => {
  if (state.resolved !== previous.resolved) {
    applyPreferencesToDocument(usePreferencesStore.getState());
  }
});
