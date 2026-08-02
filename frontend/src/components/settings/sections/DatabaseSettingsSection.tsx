import { GearIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";

import {
  SettingCard,
  SettingRow,
  SettingSection,
} from "@/components/settings/primitives";
import type { DatabaseSettingsSectionProps } from "@/components/settings/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

export function DatabaseSettingsSection({
  databases,
  highlightAnchor,
  onUploadFile,
  onNewDatabase,
  onEditDatabase,
  onToggleEnabled,
  onDeleteDatabase,
}: DatabaseSettingsSectionProps) {
  return (
    <div className="space-y-8">
      <SettingSection
        title="数据库目录"
        description="数据库是可选择、声明式的检索技能投影。"
      >
        <SettingCard>
          <SettingRow
            id="settings-database-upload"
            title="上传数据库包"
            description="支持 JSON、YAML 或 ZIP 格式的声明式清单。"
            controlId="settings-database-upload"
            controlClassName="w-full sm:w-72"
            control={
              <Input
                id="settings-database-upload"
                type="file"
                accept=".json,.yaml,.yml,.zip"
                aria-label="上传数据库包"
                onChange={(event) => onUploadFile(event.target.files?.[0])}
                className="w-full"
              />
            }
          />
          <SettingRow
            id="settings-database-new"
            title="新建数据库"
            description="从空白清单创建新的声明式检索技能。"
            control={
              <Button size="sm" onClick={onNewDatabase}>
                <PlusIcon data-icon="inline-start" />
                新建数据库
              </Button>
            }
          />
        </SettingCard>
      </SettingSection>

      <SettingSection
        title="已安装数据库"
        description="启用后，数据库可作为 Agent 的检索来源。"
      >
        {databases.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>暂无数据库</EmptyTitle>
              <EmptyDescription>上传或新建一个数据库包后，它会显示在这里。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <SettingCard>
            {databases.map((database) => (
              <SettingRow
                key={database.name}
                id={`settings-database-${database.name}`}
                title={database.display_name}
                description={database.description}
                highlight={highlightAnchor === `settings-database-${database.name}`}
                controlClassName="gap-3"
                control={
                  <>
                    <div className="flex items-center gap-1.5">
                      <Badge variant="outline">{database.origin}</Badge>
                      <Badge variant="secondary">v{database.version}</Badge>
                      <Badge variant={database.pipeline_supported ? "secondary" : "outline"}>
                        {database.pipeline_supported ? "Pipeline" : "Agent"}
                      </Badge>
                    </div>
                    <Switch
                      checked={database.enabled}
                      disabled={database.origin === "builtin"}
                      aria-label={`${database.enabled ? "停用" : "启用"} ${database.display_name}`}
                      onCheckedChange={(enabled) => onToggleEnabled(database, enabled)}
                    />
                    <div className="flex items-center gap-1">
                      {database.origin === "package" && (
                        <>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`编辑 ${database.display_name}`}
                            onClick={() => onEditDatabase(database)}
                          >
                            <GearIcon />
                          </Button>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`删除 ${database.display_name}`}
                            onClick={() => onDeleteDatabase(database)}
                          >
                            <TrashIcon />
                          </Button>
                        </>
                      )}
                    </div>
                  </>
                }
              />
            ))}
          </SettingCard>
        )}
      </SettingSection>
    </div>
  );
}
