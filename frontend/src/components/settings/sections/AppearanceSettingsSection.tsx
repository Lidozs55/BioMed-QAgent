import { useRef, useState } from "react";
import { UploadSimpleIcon, XIcon } from "@phosphor-icons/react";
import { toast } from "sonner";

import {
  ColorSwatch,
  NumberField,
  SegmentedControl,
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  REDUCED_MOTION_OPTIONS,
  UI_FONT_SIZE_MAX,
  UI_FONT_SIZE_MIN,
  usePreferencesStore,
} from "@/stores/preferencesStore";
import {
  ACCENT_PRESETS,
  FONT_OPTIONS,
  customFontId,
  fontDisplayName,
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

const FONT_FORMATS: Record<string, string> = {
  ttf: "truetype",
  otf: "opentype",
  woff: "woff",
  woff2: "woff2",
};

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
  const importedFonts = useThemeStore((state) => state.importedFonts);
  const setMode = useThemeStore((state) => state.setMode);
  const setAccent = useThemeStore((state) => state.setAccent);
  const setCustomAccent = useThemeStore((state) => state.setCustomAccent);
  const setFont = useThemeStore((state) => state.setFont);
  const addImportedFont = useThemeStore((state) => state.addImportedFont);
  const removeImportedFont = useThemeStore((state) => state.removeImportedFont);
  const fontInputRef = useRef<HTMLInputElement>(null);

  const translucentSidebar = usePreferencesStore((state) => state.translucentSidebar);
  const contrast = usePreferencesStore((state) => state.contrast);
  const pointerCursor = usePreferencesStore((state) => state.pointerCursor);
  const reducedMotion = usePreferencesStore((state) => state.reducedMotion);
  const uiFontSize = usePreferencesStore((state) => state.uiFontSize);
  const lightColors = usePreferencesStore((state) => state.lightColors);
  const darkColors = usePreferencesStore((state) => state.darkColors);
  const setTranslucentSidebar = usePreferencesStore((state) => state.setTranslucentSidebar);
  const setContrast = usePreferencesStore((state) => state.setContrast);
  const setPointerCursor = usePreferencesStore((state) => state.setPointerCursor);
  const setReducedMotion = usePreferencesStore((state) => state.setReducedMotion);
  const setUiFontSize = usePreferencesStore((state) => state.setUiFontSize);
  const setLightColors = usePreferencesStore((state) => state.setLightColors);
  const setDarkColors = usePreferencesStore((state) => state.setDarkColors);

  const presetHex =
    accent === "custom" ? customAccent : ACCENT_PRESETS[accent as Exclude<ThemeAccent, "custom">].light;

  const fontOptions = [
    ...(Object.keys(FONT_OPTIONS) as ThemeFont[]).map((key) => ({
      value: key,
      label: FONT_OPTIONS[key].label,
    })),
    ...importedFonts.map((item) => ({
      value: customFontId(item.id),
      label: item.name,
    })),
  ];

  const importFontFile = async (file: File | undefined) => {
    if (!file) return;
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    const format = FONT_FORMATS[extension];
    if (!format) {
      toast.error("不支持的字体格式", { description: "仅支持 TTF、OTF、WOFF、WOFF2 文件" });
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast.error("字体文件过大", { description: "请选择 2MB 以内的字体文件" });
      return;
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error("读取文件失败"));
      reader.readAsDataURL(file);
    });
    const name = file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim() || "导入字体";
    const imported = addImportedFont({
      name,
      family: `Imported-${Date.now().toString(36)}`,
      format,
      dataUrl,
    });
    if (!imported) {
      toast.error("导入失败", { description: "已到达字体数量上限（12 个）" });
      return;
    }
    toast.success(`字体“${imported.name}”已导入`);
  };

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
              <Select value={font} onValueChange={(value) => setFont(value ?? "inter")}>
                <SelectTrigger className="w-48" aria-label="界面字体">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {fontOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            }
          />
          <SettingRow
            id="settings-font-import"
            title="导入字体"
            description="支持 TTF、OTF、WOFF、WOFF2 文件，单个不超过 2MB。"
            controlClassName="w-full sm:w-auto"
            control={
              <div className="flex items-center gap-2">
                <Input
                  ref={fontInputRef}
                  id="settings-font-import"
                  type="file"
                  accept=".ttf,.otf,.woff,.woff2"
                  aria-label="导入字体"
                  onChange={(event) => void importFontFile(event.target.files?.[0])}
                  className="max-w-52"
                />
                <Button variant="outline" onClick={() => fontInputRef.current?.click()}>
                  <UploadSimpleIcon data-icon="inline-start" />
                  导入字体
                </Button>
              </div>
            }
          />
          {importedFonts.length > 0 && (
            <div className="px-5 py-4">
              <div className="rounded-lg border bg-muted/40 p-4">
                <p className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
                  已导入字体
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {importedFonts.map((item) => {
                    const selected = font === customFontId(item.id);
                    return (
                      <span
                        key={item.id}
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs",
                          selected
                            ? "border-primary/40 bg-primary/10 font-medium text-primary"
                            : "bg-background text-foreground",
                        )}
                      >
                        {item.name}
                        <button
                          type="button"
                          aria-label={`删除字体 ${item.name}`}
                          onClick={() => removeImportedFont(item.id)}
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <XIcon className="size-3" />
                        </button>
                      </span>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
          <div className="px-5 py-4">
            <div
              className="rounded-lg border bg-muted/40 p-4"
              data-setting-id="settings-font-preview"
            >
              <div className="flex items-center justify-between gap-3">
                <p className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
                  所选字体展示
                </p>
                <Badge variant="outline">{fontDisplayName(font, importedFonts)}</Badge>
              </div>
              <p className="mt-3 text-2xl font-medium tracking-tight">Aa 生物医学检索</p>
              <p className="mt-1.5 text-sm text-muted-foreground">
                上下文窗口 · 生成参数 · 技能管理
              </p>
            </div>
          </div>
        </SettingCard>
      </SettingSection>

      <SettingSection
        title="自定义颜色"
        description="分别调整浅色 / 深色主题的背景与前景色；留空使用主题默认值。"
      >
        <SettingCard>
          <SettingRow
            id="settings-light-background"
            title="浅色主题背景"
            description="浅色模式下页面与卡片的底色。"
            control={
              <ColorSwatch
                value={lightColors.background}
                onChange={(next) => setLightColors({ background: next })}
                ariaLabel="浅色主题背景色（留空使用默认）"
              />
            }
          />
          <SettingRow
            title="浅色主题前景"
            description="浅色模式下主要文字颜色。"
            control={
              <ColorSwatch
                value={lightColors.foreground}
                onChange={(next) => setLightColors({ foreground: next })}
                ariaLabel="浅色主题前景色（留空使用默认）"
              />
            }
          />
          <SettingRow
            id="settings-dark-background"
            title="深色主题背景"
            description="深色模式下页面与卡片的底色。"
            control={
              <ColorSwatch
                value={darkColors.background}
                onChange={(next) => setDarkColors({ background: next })}
                ariaLabel="深色主题背景色（留空使用默认）"
              />
            }
          />
          <SettingRow
            title="深色主题前景"
            description="深色模式下主要文字颜色。"
            control={
              <ColorSwatch
                value={darkColors.foreground}
                onChange={(next) => setDarkColors({ foreground: next })}
                ariaLabel="深色主题前景色（留空使用默认）"
              />
            }
          />
        </SettingCard>
      </SettingSection>

      <SettingSection
        title="侧边栏与对比度"
        description="调整侧边栏半透明效果与界面文字对比度。"
      >
        <SettingCard>
          <SettingRow
            id="settings-translucent-sidebar"
            title="半透明侧边栏"
            description="开启后侧边栏呈现半透明毛玻璃效果。"
            control={
              <Switch
                checked={translucentSidebar}
                onCheckedChange={setTranslucentSidebar}
                aria-label="半透明侧边栏"
              />
            }
          />
          <SettingRow
            id="settings-contrast"
            title="对比度"
            description="数值越高文字与背景的对比越强；50 为默认值。"
            control={
              <NumberField
                id="settings-contrast-input"
                value={contrast}
                min={0}
                max={100}
                onChange={setContrast}
                ariaLabel="对比度"
                marks={[
                  { value: 0, label: "低" },
                  { value: 50, label: "默认" },
                  { value: 100, label: "高" },
                ]}
              />
            }
          />
        </SettingCard>
      </SettingSection>

      <SettingSection
        title="偏好设置"
        description="与界面交互相关的通用偏好。"
      >
        <SettingCard>
          <SettingRow
            id="settings-pointer-cursor"
            title="使用指针光标"
            description="悬停按钮、链接等交互元素时切换为指针光标。"
            control={
              <Switch
                checked={pointerCursor}
                onCheckedChange={setPointerCursor}
                aria-label="使用指针光标"
              />
            }
          />
          <SettingRow
            id="settings-reduced-motion"
            title="减少动态效果"
            description="减少动画与过渡效果，或匹配系统设置。"
            control={
              <SegmentedControl
                value={reducedMotion}
                options={REDUCED_MOTION_OPTIONS.map((option) => ({
                  value: option.value,
                  label: option.label,
                }))}
                onChange={setReducedMotion}
                ariaLabel="减少动态效果"
              />
            }
          />
          <SettingRow
            id="settings-ui-font-size"
            title="UI 字号"
            description={`调整界面使用的基准字号（${UI_FONT_SIZE_MIN}–${UI_FONT_SIZE_MAX}px）。`}
            control={
              <NumberField
                id="settings-ui-font-size-input"
                value={uiFontSize}
                min={UI_FONT_SIZE_MIN}
                max={UI_FONT_SIZE_MAX}
                onChange={setUiFontSize}
                ariaLabel="UI 字号"
              />
            }
          />
        </SettingCard>
      </SettingSection>
    </div>
  );
}
