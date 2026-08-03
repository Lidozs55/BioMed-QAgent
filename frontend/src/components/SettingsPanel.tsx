import { SettingsPage } from "@/components/settings/SettingsPage";
import type { SettingsAPIClient } from "@/hooks/useAPI";

export interface SettingsPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  api: SettingsAPIClient;
  onExportCache?: () => void;
}

/**
 * Backward-compatible entry point for the settings surface. The old
 * modal/tabs implementation has been replaced by a full-page settings
 * shell rendered inside the app.
 */
export function SettingsPanel({ open, onOpenChange, api, onExportCache }: SettingsPanelProps) {
  if (!open) return null;
  return (
    <SettingsPage
      api={api}
      onClose={() => onOpenChange(false)}
      onExportCache={onExportCache}
    />
  );
}
