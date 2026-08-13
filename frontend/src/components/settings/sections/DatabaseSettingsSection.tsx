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
import { Switch } from "@/components/ui/switch";

export function DatabaseSettingsSection({
  databases,
  highlightAnchor,
  onNewDatabase,
  onEditDatabase,
  onToggleEnabled,
  onDeleteDatabase,
}: DatabaseSettingsSectionProps) {
  return (
    <div className="space-y-8">
      <SettingSection
        title="数据库目录"
        description="数据库是可选择、声明式的检索来源。"
      >
        <SettingCard>
          <SettingRow
            id="settings-database-new"
            title="新建数据库"
            description="从空白清单创建新的声明式检索数据库。"
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
              <EmptyDescription>新建一个数据库后，它会显示在这里。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <SettingCard>
            {databases.map((database) => (
              <SettingRow
                key={database.id}
                id={`settings-database-${database.id}`}
                title={database.name}
                description={database.description}
                highlight={highlightAnchor === `settings-database-${database.id}`}
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
                      aria-label={`${database.enabled ? "停用" : "启用"} ${database.name}`}
                      onCheckedChange={(enabled) => onToggleEnabled(database, enabled)}
                    />
                    <div className="flex items-center gap-1">
                      {database.origin === "package" && (
                        <>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`编辑 ${database.name}`}
                            onClick={() => onEditDatabase(database)}
                          >
                            <GearIcon />
                          </Button>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`删除 ${database.name}`}
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
