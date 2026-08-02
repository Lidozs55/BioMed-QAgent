import { useRef } from "react";
import {
  DotsThreeIcon,
  TrashIcon,
  UploadSimpleIcon,
} from "@phosphor-icons/react";

import {
  SettingCard,
  SettingRow,
  SettingSection,
} from "@/components/settings/primitives";
import type { SkillsSettingsSectionProps } from "@/components/settings/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { SkillManifest } from "@/hooks/useAPI";

function hueFor(name: string): number {
  let hash = 0;
  for (const char of name) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 360;
  }
  return hash;
}

function SkillRow({
  skill,
  onToggle,
  onDetail,
  onRollback,
  onDelete,
}: {
  skill: SkillManifest;
  onToggle: (enabled: boolean) => void;
  onDetail: () => void;
  onRollback: () => void;
  onDelete: () => void;
}) {
  const hue = hueFor(skill.name);
  const interactive = skill.origin !== "builtin" && skill.available !== false;

  return (
    <div className="flex items-center gap-3 px-5 py-3">
      <span
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded-lg text-sm font-semibold"
        style={{
          backgroundColor: `hsl(${hue} 70% 48% / 0.14)`,
          color: `hsl(${hue} 70% 42%)`,
        }}
      >
        {skill.display_name.charAt(0).toUpperCase()}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{skill.display_name}</span>
          <Badge variant="outline" className="shrink-0 text-[10px]">
            v{skill.version}
          </Badge>
          <Badge variant="secondary" className="shrink-0 text-[10px]">
            {skill.category}
          </Badge>
          <Badge variant="outline" className="shrink-0 text-[10px]">
            {skill.origin}
          </Badge>
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground" title={skill.description}>
          {skill.description || "无描述"}
        </p>
        {skill.load_error && <p className="mt-0.5 truncate text-xs text-destructive">{skill.load_error}</p>}
      </div>
      {skill.available === false && <Badge variant="destructive">不可用</Badge>}
      <Switch
        checked={skill.enabled}
        disabled={!interactive}
        aria-label={`${skill.enabled ? "停用" : "启用"} ${skill.display_name}`}
        onCheckedChange={onToggle}
      />
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="icon-sm" aria-label={`管理 ${skill.display_name}`} />
          }
        >
          <DotsThreeIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onDetail}>查看详情</DropdownMenuItem>
          {interactive && (
            <>
              <DropdownMenuItem onClick={onRollback}>回滚到上一版</DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                <TrashIcon />
                卸载
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function SkillsSettingsSection({
  skills,
  filter,
  onFilterChange,
  onInstallFile,
  onToggleEnabled,
  onShowDetail,
  onRollback,
  onDeleteSkill,
}: SkillsSettingsSectionProps) {
  const installInputRef = useRef<HTMLInputElement>(null);
  const hasFilter = filter.trim().length > 0;

  return (
    <div className="space-y-8">
      <SettingSection
        title="技能管理"
        description="筛选、启停、回滚或安装技能包。"
      >
        <SettingCard>
          <SettingRow
            id="settings-skill-filter"
            title="筛选技能"
            description="按名称、分类或来源过滤已安装技能。"
            controlId="settings-skill-filter"
            controlClassName="w-full sm:w-64"
            control={
              <Input
                id="settings-skill-filter"
                value={filter}
                placeholder="筛选技能"
                onChange={(event) => onFilterChange(event.target.value)}
                className="w-full"
              />
            }
          />
          <SettingRow
            id="settings-skill-install"
            title="安装技能"
            description="上传本地技能包，上传前会进行校验。"
            controlClassName="w-full sm:w-auto"
            control={
              <div className="flex items-center gap-2">
                <Input
                  ref={installInputRef}
                  id="settings-skill-install"
                  type="file"
                  accept=".json,.yaml,.yml,.zip"
                  aria-label="上传技能"
                  onChange={(event) => onInstallFile(event.target.files?.[0])}
                  className="max-w-52"
                />
                <Button variant="outline" onClick={() => installInputRef.current?.click()}>
                  <UploadSimpleIcon data-icon="inline-start" />
                  安装技能
                </Button>
              </div>
            }
          />
        </SettingCard>
      </SettingSection>

      <SettingSection
        title="已安装技能"
        description={skills.length > 0 ? `共 ${skills.length} 个技能` : "尚未安装任何技能。"}
      >
        {skills.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{hasFilter ? "没有匹配的技能" : "暂无技能"}</EmptyTitle>
              <EmptyDescription>
                {hasFilter
                  ? "调整名称、分类、来源或状态筛选。"
                  : "上传技能包后会显示在这里。"}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <SettingCard>
            {skills.map((skill) => (
              <SkillRow
                key={skill.name}
                skill={skill}
                onToggle={(enabled) => onToggleEnabled(skill, enabled)}
                onDetail={() => onShowDetail(skill.name)}
                onRollback={() => onRollback(skill)}
                onDelete={() => onDeleteSkill(skill)}
              />
            ))}
          </SettingCard>
        )}
      </SettingSection>
    </div>
  );
}
