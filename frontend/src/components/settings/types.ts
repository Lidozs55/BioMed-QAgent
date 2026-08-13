import type { DatabaseItem, ModelSettings, SettingsAPIClient } from "@/hooks/useAPI";

export interface ModelSettingsSectionProps {
  api: SettingsAPIClient;
  settings: ModelSettings | null;
  highlightAnchor: string | null;
  onActivated: (settings: ModelSettings) => void;
}

export interface DatabaseSettingsSectionProps {
  databases: DatabaseItem[];
  highlightAnchor: string | null;
  highlightNonce: number;
  onNewDatabase: () => void;
  onEditDatabase: (database: DatabaseItem) => void;
  onToggleEnabled: (database: DatabaseItem, enabled: boolean) => void;
  onDeleteDatabase: (database: DatabaseItem) => void;
}
