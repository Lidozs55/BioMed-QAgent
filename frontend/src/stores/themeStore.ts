import { create } from "zustand";

export type ThemeMode = "system" | "light" | "dark";
export type ThemeAccent = "sky" | "emerald" | "violet" | "amber" | "rose" | "custom";
export type ThemeFont = "inter" | "system" | "serif";

export interface ImportedFont {
  id: string;
  name: string;
  family: string;
  format: string;
  dataUrl: string;
}

export interface ThemePrefs {
  mode: ThemeMode;
  accent: ThemeAccent;
  font: string;
  customAccent: string;
  importedFonts: ImportedFont[];
}

export const ACCENT_PRESETS: Record<
  Exclude<ThemeAccent, "custom">,
  {
    label: string;
    light: string;
    dark: string;
    lightForeground: string;
    darkForeground: string;
  }
> = {
  sky: {
    label: "天蓝",
    light: "#2563eb",
    dark: "#3b82f6",
    lightForeground: "#f8fafc",
    darkForeground: "#0f172a",
  },
  emerald: {
    label: "翡翠",
    light: "#059669",
    dark: "#10b981",
    lightForeground: "#ffffff",
    darkForeground: "#022c22",
  },
  violet: {
    label: "紫罗兰",
    light: "#7c3aed",
    dark: "#8b5cf6",
    lightForeground: "#ffffff",
    darkForeground: "#1e1b4b",
  },
  amber: {
    label: "琥珀",
    light: "#d97706",
    dark: "#f59e0b",
    lightForeground: "#ffffff",
    darkForeground: "#451a03",
  },
  rose: {
    label: "玫红",
    light: "#e11d48",
    dark: "#fb7185",
    lightForeground: "#ffffff",
    darkForeground: "#4c0519",
  },
};

export const FONT_OPTIONS: Record<ThemeFont, { label: string; stack: string }> = {
  inter: {
    label: "Inter",
    stack: "'Inter Variable', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },
  system: {
    label: "系统默认",
    stack:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif",
  },
  serif: {
    label: "衬线阅读",
    stack: "Georgia, 'Times New Roman', 'Songti SC', 'SimSun', serif",
  },
};

export function customFontId(id: string): string {
  return `custom:${id}`;
}

export function fontDisplayName(font: string, importedFonts: ImportedFont[]): string {
  if (font in FONT_OPTIONS) return FONT_OPTIONS[font as ThemeFont].label;
  const imported = importedFonts.find((item) => customFontId(item.id) === font);
  return imported?.name ?? FONT_OPTIONS.inter.label;
}

export function fontStackFor(prefs: ThemePrefs): string {
  if (prefs.font in FONT_OPTIONS) {
    return FONT_OPTIONS[prefs.font as ThemeFont].stack;
  }
  const imported = prefs.importedFonts.find((item) => customFontId(item.id) === prefs.font);
  if (imported) return `"${imported.family}", ${FONT_OPTIONS.inter.stack}`;
  return FONT_OPTIONS.inter.stack;
}

function syncFontFaces(fonts: ImportedFont[]): void {
  if (typeof document === "undefined") return;
  let style = document.getElementById("imported-font-faces");
  if (!style) {
    style = document.createElement("style");
    style.id = "imported-font-faces";
    document.head.appendChild(style);
  }
  style.textContent = fonts
    .map(
      (font) =>
        `@font-face{font-family:"${font.family}";src:url("${font.dataUrl}") format("${font.format}");font-display:swap;}`,
    )
    .join("\n");
}

const STORAGE_KEY = "biomed.theme";
const MAX_IMPORTED_FONTS = 12;
const MAX_FONT_DATA_URL_LENGTH = 3_000_000;

const DEFAULT_PREFS: ThemePrefs = {
  mode: "system",
  accent: "sky",
  font: "inter",
  customAccent: "",
  importedFonts: [],
};

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

function parseImportedFonts(value: unknown): ImportedFont[] {
  if (!Array.isArray(value)) return [];
  const fonts: ImportedFont[] = [];
  for (const item of value) {
    if (fonts.length >= MAX_IMPORTED_FONTS) break;
    if (
      item === null ||
      typeof item !== "object" ||
      typeof Reflect.get(item, "id") !== "string" ||
      typeof Reflect.get(item, "name") !== "string" ||
      typeof Reflect.get(item, "family") !== "string" ||
      typeof Reflect.get(item, "format") !== "string" ||
      typeof Reflect.get(item, "dataUrl") !== "string"
    ) {
      continue;
    }
    const dataUrl = String(Reflect.get(item, "dataUrl"));
    if (!dataUrl.startsWith("data:font/") || dataUrl.length > MAX_FONT_DATA_URL_LENGTH) continue;
    fonts.push({
      id: String(Reflect.get(item, "id")),
      name: String(Reflect.get(item, "name")).slice(0, 80),
      family: String(Reflect.get(item, "family")).slice(0, 80),
      format: String(Reflect.get(item, "format")).slice(0, 20),
      dataUrl,
    });
  }
  return fonts;
}

function readPrefs(): ThemePrefs {
  if (typeof window === "undefined") return DEFAULT_PREFS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<ThemePrefs>;
    const importedFonts = parseImportedFonts(parsed.importedFonts);
    const font =
      parsed.font !== undefined &&
      (parsed.font in FONT_OPTIONS ||
        importedFonts.some((item) => customFontId(item.id) === parsed.font))
        ? String(parsed.font)
        : DEFAULT_PREFS.font;
    return {
      mode:
        parsed.mode === "light" || parsed.mode === "dark" || parsed.mode === "system"
          ? parsed.mode
          : DEFAULT_PREFS.mode,
      accent:
        parsed.accent === "custom" ||
        (parsed.accent !== undefined && parsed.accent in ACCENT_PRESETS)
          ? parsed.accent
          : DEFAULT_PREFS.accent,
      font,
      customAccent:
        typeof parsed.customAccent === "string" && HEX_COLOR.test(parsed.customAccent)
          ? parsed.customAccent
          : DEFAULT_PREFS.customAccent,
      importedFonts,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function systemDark(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

function resolveDark(mode: ThemeMode): boolean {
  return mode === "system" ? systemDark() : mode === "dark";
}

function accentFor(prefs: ThemePrefs): {
  light: string;
  dark: string;
  lightForeground: string;
  darkForeground: string;
} {
  if (prefs.accent === "custom" && HEX_COLOR.test(prefs.customAccent)) {
    const foreground = contrastForeground(prefs.customAccent);
    return {
      light: prefs.customAccent,
      dark: prefs.customAccent,
      lightForeground: foreground,
      darkForeground: foreground,
    };
  }
  return ACCENT_PRESETS[prefs.accent as Exclude<ThemeAccent, "custom">] ?? ACCENT_PRESETS.sky;
}

function contrastForeground(hex: string): string {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.62 ? "#0f172a" : "#ffffff";
}

export function applyThemeToDocument(prefs: ThemePrefs, dark: boolean): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.toggle("dark", dark);
  root.dataset.themeMode = prefs.mode;

  const accent = accentFor(prefs);
  const primary = dark ? accent.dark : accent.light;
  const primaryForeground = dark ? accent.darkForeground : accent.lightForeground;
  root.style.setProperty("--primary", primary);
  root.style.setProperty("--primary-foreground", primaryForeground);
  root.style.setProperty("--ring", primary);
  root.style.setProperty("--sidebar-primary", primary);
  root.style.setProperty("--sidebar-primary-foreground", primaryForeground);
  root.style.setProperty("--font-ui", fontStackFor(prefs));
  syncFontFaces(prefs.importedFonts);

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage unavailable; theme still applies for the current session.
  }
}

interface ThemeState extends ThemePrefs {
  resolved: "light" | "dark";
  setMode: (mode: ThemeMode) => void;
  setAccent: (accent: ThemeAccent) => void;
  setCustomAccent: (hex: string) => void;
  setFont: (font: string) => void;
  addImportedFont: (font: Omit<ImportedFont, "id">) => ImportedFont | null;
  removeImportedFont: (id: string) => void;
  toggleTheme: () => void;
}

const initialPrefs = readPrefs();
const initialDark = resolveDark(initialPrefs.mode);
applyThemeToDocument(initialPrefs, initialDark);

export const useThemeStore = create<ThemeState>((set, get) => ({
  ...initialPrefs,
  resolved: initialDark ? "dark" : "light",

  setMode: (mode) => {
    set({ mode });
    const dark = resolveDark(mode);
    set({ resolved: dark ? "dark" : "light" });
    applyThemeToDocument(get(), dark);
  },

  setAccent: (accent) => {
    set({ accent });
    applyThemeToDocument(get(), get().resolved === "dark");
  },

  setCustomAccent: (hex) => {
    if (!HEX_COLOR.test(hex)) return;
    set({ accent: "custom", customAccent: hex });
    applyThemeToDocument(get(), get().resolved === "dark");
  },

  setFont: (font) => {
    set({ font });
    applyThemeToDocument(get(), get().resolved === "dark");
  },

  addImportedFont: (font) => {
    const current = get();
    if (current.importedFonts.length >= MAX_IMPORTED_FONTS) return null;
    if (!font.dataUrl.startsWith("data:font/")) return null;
    const imported: ImportedFont = {
      id: `font_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      name: font.name.trim().slice(0, 80) || "导入字体",
      family: font.family.trim().slice(0, 80) || `Imported-${Date.now().toString(36)}`,
      format: font.format.slice(0, 20),
      dataUrl: font.dataUrl,
    };
    set({ importedFonts: [...current.importedFonts, imported] });
    applyThemeToDocument(get(), get().resolved === "dark");
    return imported;
  },

  removeImportedFont: (id) => {
    const current = get();
    const importedFonts = current.importedFonts.filter((item) => item.id !== id);
    const font = current.font === customFontId(id) ? "inter" : current.font;
    set({ importedFonts, font });
    applyThemeToDocument(get(), get().resolved === "dark");
  },

  toggleTheme: () => {
    const next = get().resolved === "dark" ? "light" : "dark";
    get().setMode(next);
  },
}));

function syncSystem(): void {
  const { mode } = useThemeStore.getState();
  if (mode !== "system") return;
  const dark = systemDark();
  useThemeStore.setState({ resolved: dark ? "dark" : "light" });
  applyThemeToDocument(useThemeStore.getState(), dark);
}

if (typeof window !== "undefined") {
  if (typeof window.matchMedia === "function") {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", syncSystem);
  }
}
