import {
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
import { Switch } from "@/components/ui/switch";
import {
  FOLLOW_UP_MODE_OPTIONS,
  SEND_SHORTCUT_OPTIONS,
  usePreferencesStore,
} from "@/stores/preferencesStore";

export function EditorSettingsSection() {
  const showContextUsage = usePreferencesStore((state) => state.showContextUsage);
  const sendShortcut = usePreferencesStore((state) => state.sendShortcut);
  const followUpMode = usePreferencesStore((state) => state.followUpMode);
  const setShowContextUsage = usePreferencesStore((state) => state.setShowContextUsage);
  const setSendShortcut = usePreferencesStore((state) => state.setSendShortcut);
  const setFollowUpMode = usePreferencesStore((state) => state.setFollowUpMode);

  return (
    <div className="flex flex-col gap-8">
      <SettingSection
        title="发送"
        description="控制消息输入框的发送与换行行为。"
      >
        <SettingCard>
          <SettingRow
            id="settings-send-shortcut"
            title="发送快捷键"
            description="选择按 Enter 时是发送消息还是插入换行。文件导入的提交始终使用 Enter。"
            control={
              <Select
                value={sendShortcut}
                onValueChange={(value) => setSendShortcut(value ?? "enter")}
              >
                <SelectTrigger className="w-56" aria-label="发送快捷键">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {SEND_SHORTCUT_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                        <span className="ml-2 text-xs text-muted-foreground">
                          {option.hint}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            }
          />
        </SettingCard>
      </SettingSection>

      <SettingSection
        title="跟进处理方式"
        description="任务运行中发送后续消息时的处理策略。"
      >
        <SettingCard>
          <SettingRow
            id="settings-follow-up-mode"
            title="发送后续消息"
            description="加入队列：当前回答结束后自动发送；调整方向：取消当前回答，立即用新消息重新引导。按住 Ctrl+⌘ 发送可对单条消息执行相反操作。"
            control={
              <SegmentedControl
                value={followUpMode}
                options={FOLLOW_UP_MODE_OPTIONS.map((option) => ({
                  value: option.value,
                  label: option.label,
                }))}
                onChange={setFollowUpMode}
                ariaLabel="跟进处理方式"
              />
            }
          />
        </SettingCard>
      </SettingSection>

      <SettingSection
        title="上下文窗口"
        description="管理输入框工具栏的上下文用量指示。"
      >
        <SettingCard>
          <SettingRow
            id="settings-context-usage"
            title="显示上下文窗口使用情况"
            description="在输入框工具栏显示当前会话的上下文占用百分比。关闭后压缩功能仍可正常使用。"
            control={
              <Switch
                checked={showContextUsage}
                onCheckedChange={setShowContextUsage}
                aria-label="显示上下文窗口使用情况"
              />
            }
          />
        </SettingCard>
      </SettingSection>
    </div>
  );
}
