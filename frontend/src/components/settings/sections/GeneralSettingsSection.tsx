import { DownloadSimpleIcon } from "@phosphor-icons/react";

import {
  SettingCard,
  SettingRow,
  SettingSection,
} from "@/components/settings/primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export function GeneralSettingsSection({ onExportCache }: { onExportCache: () => void }) {
  return (
    <div className="flex flex-col gap-8">
      <SettingSection
        title="本地数据"
        description="管理保存在本机浏览器中的任务与工作区数据。"
      >
        <SettingCard>
          <SettingRow
            id="settings-export-cache"
            title="导出本地缓存"
            description="下载任务历史、会话与工件的 ZIP 备份。"
            control={
              <Button variant="outline" onClick={onExportCache}>
                <DownloadSimpleIcon data-icon="inline-start" />
                导出缓存
              </Button>
            }
          />
        </SettingCard>
      </SettingSection>

      <SettingSection title="关于">
        <SettingCard>
          <SettingRow
            title="BioMed QAgent"
            description="面向生物医学检索与科研工作流的 Agent 控制台。"
            control={<Badge variant="outline">v1.0.0</Badge>}
          />
        </SettingCard>
      </SettingSection>
    </div>
  );
}
