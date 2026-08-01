import { useState } from "react";

import {
  ColorSwatch,
  SettingCard,
  SettingRow,
  SettingSection,
} from "@/components/settings/primitives";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  ACCENT_PRESETS,
  FONT_OPTIONS,
  useThemeStore,
  type ThemeAccent,
  type ThemeFont,
  type ThemeMode,
} from "@/stores/themeStore";
import { cn } from "@/lib/utils";

const THEME_MODES: { value: ThemeMode; label: string; hint: string }[] = [
  { value: "system", label: "系统", hint: "跟随操作系统" },
  { value: "light", label: "浅色", hint: "明亮界面" },
  { value: "dark", label: "深色", hint: "低光环境" },
];

function CustomAccentField({
  value,
  onApply,
}: {
  value: string;
  onApply: (hex: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  return (
    <ColorSwatch
      value={draft}
      ariaLabel="自定义强调色"
      onChange={(next) => {
        setDraft(next);
        if (/^#[0-9A-Fa-f]{6}$/.test(next)) onApply(next);
      }}
    />
  );
}

function ThemePreviewCard({
  label,
  hint,
  active,
  darkPreview,
  onClick,
}: {
  label: string;
  hint: string;
  active: boolean;
  darkPreview: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "w-full rounded-xl border p-3 text-left transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
        active
          ? "border-primary ring-2 ring-primary/25"
          : "border-border hover:border-muted-foreground/40",
      )}
    >
      <div
        className={cn(
          "flex h-24 overflow-hidden rounded-lg border",
          darkPreview ? "border-white/10 bg-slate-900" : "border-slate-200 bg-white",
        )}
      >
        <div
          className={cn(
            "w-1/4 border-r",
            darkPreview ? "border-white/10 bg-slate-800" : "border-slate-200 bg-slate-100",
          )}
        >
          <div className={cn("mx-2 mt-2 h-1.5 rounded-full", darkPreview ? "bg-white/70" : "bg-slate-400")} />
          <div className={cn("mx-2 mt-1.5 h-1.5 w-3/5 rounded-full", darkPreview ? "bg-white/30" : "bg-slate-300")} />
          <div className={cn("mx-2 mt-1.5 h-1.5 w-4/5 rounded-full", darkPreview ? "bg-white/25" : "bg-slate-300")} />
        </div>
        <div className="flex-1 p-2">
          <div className={cn("h-2 w-2/3 rounded-full", darkPreview ? "bg-white/70" : "bg-slate-500")} />
          <div className={cn("mt-2 h-1.5 w-full rounded-full", darkPreview ? "bg-white/25" : "bg-slate-200")} />
          <div className={cn("mt-1.5 h-1.5 w-4/5 rounded-full", darkPreview ? "bg-white/20" : "bg-slate-200")} />
          <div className="mt-2 h-1.5 w-10 rounded-full bg-primary" />
        </div>
      </div>
      <div className="mt-2.5 flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-[11px] text-muted-foreground">{active ? "当前" : hint}</span>
      </div>
    </button>
  );
}

export function AppearanceSettingsSection() {
  const mode = useThemeStore((state) => state.mode);
  const resolved = useThemeStore((state) => state.resolved);
  const accent = useThemeStore((state) => state.accent);
  const customAccent = useThemeStore((state) => state.customAccent);
  const font = useThemeStore((state) => state.font);
  const setMode = useThemeStore((state) => state.setMode);
  const setAccent = useThemeStore((state) => state.setAccent);
  const setCustomAccent = useThemeStore((state) => state.setCustomAccent);
  const setFont = useThemeStore((state) => state.setFont);

  const presetHex =
    accent === "custom" ? customAccent : ACCENT_PRESETS[accent as Exclude<ThemeAccent, "custom">].light;

  return (
    <div className="space-y-8">
      <SettingSection
        title="主题模式"
        description="选择跟随系统，或固定使用浅色 / 深色主题。"
      >
        <div id="settings-theme-mode" className="grid gap-3 sm:grid-cols-3">
          {THEME_MODES.map((option) => (
            <ThemePreviewCard
              key={option.value}
              label={option.label}
              hint={option.hint}
              active={mode === option.value}
              darkPreview={option.value === "dark" || (option.value === "system" && resolved === "dark")}
              onClick={() => setMode(option.value)}
            />
          ))}
        </div>
      </SettingSection>

      <SettingSection
        title="强调色"
        description="控制按钮、选中态与高亮的主色。"
      >
        <SettingCard>
          <SettingRow
            id="settings-accent"
            title="预设色板"
            description="快速切换一组经过对比度校验的强调色。"
            control={
              <div className="flex items-center gap-1.5">
                {(Object.keys(ACCENT_PRESETS) as Exclude<ThemeAccent, "custom">[]).map((key) => {
                  const preset = ACCENT_PRESETS[key];
                  return (
                    <button
                      key={key}
                      type="button"
                      aria-label={`强调色 ${preset.label}`}
                      aria-pressed={accent === key}
                      onClick={() => setAccent(key)}
                      className={cn(
                        "flex size-7 items-center justify-center rounded-full ring-1 ring-foreground/15 transition-transform",
                        accent === key && "scale-110 ring-2 ring-foreground/40",
                      )}
                      style={{ backgroundColor: preset.light }}
                    >
                      <span
                        className={cn(
                          "size-2 rounded-full",
                          accent === key ? "bg-white" : "bg-transparent",
                        )}
                      />
                    </button>
                  );
                })}
              </div>
            }
          />
          <SettingRow
            title="自定义色值"
            description="输入任意 Hex 色值，立即应用到当前主题。"
            control={
              <CustomAccentField
                key={`${accent}:${customAccent}`}
                value={presetHex}
                onApply={setCustomAccent}
              />
            }
          />
        </SettingCard>
      </SettingSection>

      <SettingSection
        title="界面字体"
        description="调整全局 UI 字体与阅读排版。"
      >
        <SettingCard>
          <SettingRow
            id="settings-font"
            title="字体"
            description="切换后立即作用于整个应用。"
            control={
              <Select value={font} onValueChange={(value) => setFont(value as ThemeFont)}>
                <SelectTrigger className="w-48" aria-label="界面字体">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {(Object.keys(FONT_OPTIONS) as ThemeFont[]).map((key) => (
                      <SelectItem key={key} value={key}>
                        {FONT_OPTIONS[key].label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            }
          />
        </SettingCard>
        <div
          className="rounded-xl border bg-card p-5 ring-1 ring-foreground/10"
          data-setting-id="settings-font-preview"
        >
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
              所选字体展示
            </p>
            <Badge variant="outline">{FONT_OPTIONS[font].label}</Badge>
          </div>
          <p className="mt-4 text-2xl font-medium tracking-tight">Aa 生物医学检索</p>
          <p className="mt-1.5 text-sm text-muted-foreground">
            上下文窗口 · 生成参数 · 技能管理
          </p>
        </div>
      </SettingSection>
    </div>
  );
}
